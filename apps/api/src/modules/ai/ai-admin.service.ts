import { createHash } from 'node:crypto';
import {
  AiUnavailableError,
  effectivePricing,
  extractVariables,
  providerSecretContext,
} from '@cbi/ai-core';
import type { Logger } from '@cbi/config';
import {
  AiModelModel,
  AiProviderModel,
  AiRouteModel,
  AiUsageModel,
  mongoose,
  PromptTemplateModel,
  ProviderHealthModel,
  type AiModelRecord,
  type AiProviderRecord,
  type PromptTemplateRecord,
} from '@cbi/db';
import {
  AI_FEATURE_CAPABILITY,
  AiFeature,
  AiModelParams,
  type AddAiModelPriceBody,
  type AiCallOutcome,
  type AiModelHealth,
  type AiModelSummary,
  type AiProviderSummary,
  type AiRouteSummary,
  type AiUsageEntriesPage,
  type AiUsageEntriesQuery,
  type AiUsageQuery,
  type AiUsageReport,
  type AiUsageRow,
  type CreateAiModelBody,
  type CreatePromptVersionBody,
  type PriceEntry,
  type PromptListQuery,
  type PromptTemplateSummary,
  type TestAiModelResponse,
  type UpdateAiModelBody,
  type UpdateAiProviderBody,
  type UpsertAiRouteBody,
} from '@cbi/shared-types';
import type { ClientSession } from 'mongoose';
import type { AuditService } from '../../lib/audit.js';
import { AppError } from '../../lib/errors.js';
import type { ClientContext } from '../../lib/request-context.js';
import { transaction } from '../../lib/transaction.js';
import type { AiRuntime } from './ai-runtime.js';

interface Deps {
  ai: AiRuntime;
  audit: AuditService;
  logger: Logger;
  now?: () => Date;
}

/** Features an admin can route. `admin.test` calls a model directly. */
export const ROUTABLE_FEATURES = AiFeature.options.filter((f) => f !== 'admin.test');

export const HEALTH_WINDOW = '5m' as const;
/** Health rows older than this mean "no recent traffic". */
const HEALTH_STALE_MS = 15 * 60 * 1000;

function objectId(id: string, what: string) {
  if (!mongoose.isValidObjectId(id)) throw AppError.notFound(`${what} not found`);
  return new mongoose.Types.ObjectId(id);
}

const iso = (d: Date) => d.toISOString();

function toPriceEntry(p: AiModelRecord['pricing'][number]): PriceEntry {
  return {
    unit: p.unit,
    pricePerUnitMicros: p.pricePerUnitMicros,
    currency: p.currency,
    effectiveFrom: iso(p.effectiveFrom),
  };
}

function providerSummary(p: AiProviderRecord, available: boolean): AiProviderSummary {
  return {
    id: String(p._id),
    key: p.key,
    displayName: p.displayName,
    enabled: p.enabled,
    available,
    credential: p.credential
      ? {
          last4: p.credential.last4,
          keyId: p.credential.keyId,
          updatedAt: iso(p.credential.updatedAt),
        }
      : null,
    baseUrl: p.baseUrl ?? null,
    region: p.region ?? null,
    notes: p.notes ?? null,
    updatedAt: iso(p.updatedAt),
  };
}

function promptSummary(p: PromptTemplateRecord): PromptTemplateSummary {
  return {
    id: String(p._id),
    key: p.key,
    version: p.version,
    locale: p.locale,
    feature: p.feature,
    status: p.status,
    messages: p.messages.map((m) => ({ role: m.role, content: m.content })),
    variables: p.variables,
    notes: p.notes ?? null,
    contentHash: p.contentHash,
    createdAt: iso(p.createdAt),
    activatedAt: p.activatedAt ? iso(p.activatedAt) : null,
  };
}

/** Before/after of the fields that changed. Callers never pass credentials. */
function diff(before: Record<string, unknown>, after: Record<string, unknown>) {
  const changes: Record<string, { from: unknown; to: unknown }> = {};
  for (const key of Object.keys(after)) {
    if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) {
      changes[key] = { from: before[key] ?? null, to: after[key] ?? null };
    }
  }
  return changes;
}

const plainChain = (chain: readonly { modelId: unknown; priority: number }[]) =>
  chain.map((c) => ({ modelId: String(c.modelId), priority: c.priority }));

type Audited<T> = { result: T; details: Record<string, unknown> };

/**
 * Admin operations for the AI provider layer. Each mutation runs in a
 * transaction together with its audit entry, then broadcasts a cache bust so
 * every process routes with the new configuration immediately.
 */
export function createAiAdminService(deps: Deps) {
  const now = deps.now ?? (() => new Date());
  const { ai, audit } = deps;

  async function audited<T>(
    ctx: ClientContext,
    actorId: string,
    event: { action: string; resourceType: string; resourceId: string },
    fn: (session: ClientSession) => Promise<Audited<T>>,
  ): Promise<T> {
    const result = await transaction(async (session) => {
      const { result: value, details } = await fn(session);
      await audit.record({ actorType: 'ADMIN', actorId, ...event, details }, ctx, session);
      return value;
    });
    await ai.announceChange();
    return result;
  }

  async function loadProvider(id: string, session?: ClientSession) {
    const provider = await AiProviderModel.findById(objectId(id, 'Provider'), null, { session });
    if (!provider) throw AppError.notFound('Provider not found');
    return provider;
  }

  async function loadModel(id: string, session?: ClientSession) {
    const model = await AiModelModel.findById(objectId(id, 'Model'), null, { session });
    if (!model) throw AppError.notFound('Model not found');
    return model;
  }

  const available = (key: AiProviderRecord['key']) => Boolean(ai.adapters.llm(key));

  async function modelLabels(): Promise<Map<string, string>> {
    const [models, providers] = await Promise.all([
      AiModelModel.find({}, { displayName: 1, providerId: 1 }).lean(),
      AiProviderModel.find({}, { displayName: 1 }).lean(),
    ]);
    const names = new Map(providers.map((p) => [String(p._id), p.displayName]));
    return new Map(
      models.map((m) => [
        String(m._id),
        `${m.displayName} (${names.get(String(m.providerId)) ?? 'unknown'})`,
      ]),
    );
  }

  async function modelSummaries(filter: Record<string, unknown> = {}): Promise<AiModelSummary[]> {
    const [models, providers] = await Promise.all([
      AiModelModel.find(filter).sort({ displayName: 1 }).lean(),
      AiProviderModel.find({}, { key: 1 }).lean(),
    ]);
    const keys = new Map(providers.map((p) => [String(p._id), p.key]));
    const at = now();
    return models
      .filter((m) => {
        const key = keys.get(String(m.providerId));
        return key !== undefined && (key !== 'mock' || available('mock'));
      })
      .map((m) => ({
        id: String(m._id),
        providerId: String(m.providerId),
        providerKey: keys.get(String(m.providerId))!,
        modelId: m.modelId,
        displayName: m.displayName,
        capabilities: m.capabilities,
        enabled: m.enabled,
        languages: m.languages,
        params: {
          temperature: m.params.temperature ?? null,
          maxOutputTokens: m.params.maxOutputTokens,
          timeoutMs: m.params.timeoutMs,
          retries: m.params.retries,
          concurrency: m.params.concurrency,
        },
        pricing: [...m.pricing]
          .sort((a, b) => b.effectiveFrom.getTime() - a.effectiveFrom.getTime())
          .map(toPriceEntry),
        currentPricing: (effectivePricing(m.pricing, at)?.entries ?? []).map((p) => ({
          ...p,
          effectiveFrom: iso(p.effectiveFrom),
        })),
        updatedAt: iso(m.updatedAt),
      }));
  }

  async function oneModel(id: mongoose.Types.ObjectId): Promise<AiModelSummary> {
    const [summary] = await modelSummaries({ _id: id });
    if (!summary) throw AppError.notFound('Model not found');
    return summary;
  }

  async function listRoutes(): Promise<AiRouteSummary[]> {
    const [routes, labels] = await Promise.all([AiRouteModel.find().lean(), modelLabels()]);
    const byFeature = new Map(routes.map((r) => [r.feature, r]));
    return ROUTABLE_FEATURES.map((feature) => {
      const route = byFeature.get(feature);
      return {
        feature,
        capability: AI_FEATURE_CAPABILITY[feature],
        active: route?.active ?? false,
        chain: [...(route?.chain ?? [])]
          .sort((a, b) => a.priority - b.priority)
          .map((c) => ({
            modelId: String(c.modelId),
            priority: c.priority,
            label: labels.get(String(c.modelId)) ?? 'Deleted model',
          })),
        updatedAt: route ? iso(route.updatedAt) : null,
      };
    });
  }

  return {
    // ---- Providers ----------------------------------------------------------
    async listProviders(): Promise<AiProviderSummary[]> {
      const providers = await AiProviderModel.find().sort({ key: 1 }).lean();
      return (
        providers
          .map((p) => providerSummary(p, available(p.key)))
          // A mock record copied from a development database stays hidden where the mock cannot run.
          .filter((p) => p.key !== 'mock' || p.available)
      );
    },

    async updateProvider(
      id: string,
      body: UpdateAiProviderBody,
      actorId: string,
      ctx: ClientContext,
    ) {
      const updated = await audited(
        ctx,
        actorId,
        { action: 'ai.provider_updated', resourceType: 'aiProvider', resourceId: id },
        async (session) => {
          const provider = await loadProvider(id, session);
          const snapshot = () => ({
            enabled: provider.enabled,
            displayName: provider.displayName,
            baseUrl: provider.baseUrl,
            region: provider.region,
            notes: provider.notes,
          });
          const before = snapshot();
          for (const [field, value] of Object.entries(body)) {
            if (value !== undefined) provider.set(field, value);
          }
          await provider.save({ session });
          return {
            result: provider.toObject(),
            details: { provider: provider.key, changes: diff(before, snapshot()) },
          };
        },
      );
      return providerSummary(updated, available(updated.key));
    },

    async setCredential(
      id: string,
      apiKey: string,
      reason: string,
      actorId: string,
      ctx: ClientContext,
    ) {
      const provider = await loadProvider(id);
      if (provider.key === 'mock')
        throw AppError.validation('The mock provider does not use an API key.');
      const encrypted = ai.secrets.encrypt(apiKey, providerSecretContext(provider.key));
      const updated = await audited(
        ctx,
        actorId,
        { action: 'ai.provider_credential_set', resourceType: 'aiProvider', resourceId: id },
        async (session) => {
          const doc = await loadProvider(id, session);
          const replaced = Boolean(doc.credential);
          doc.credential = { ...encrypted, updatedAt: now() };
          await doc.save({ session });
          return {
            result: doc.toObject(),
            // The last 4 characters and the key id only; never the key itself.
            details: {
              provider: doc.key,
              last4: encrypted.last4,
              keyId: encrypted.keyId,
              replaced,
              reason,
            },
          };
        },
      );
      return providerSummary(updated, available(updated.key));
    },

    async removeCredential(id: string, reason: string, actorId: string, ctx: ClientContext) {
      const updated = await audited(
        ctx,
        actorId,
        { action: 'ai.provider_credential_removed', resourceType: 'aiProvider', resourceId: id },
        async (session) => {
          const doc = await loadProvider(id, session);
          if (!doc.credential) throw AppError.conflict('This provider has no stored key.');
          const last4 = doc.credential.last4;
          doc.credential = null;
          await doc.save({ session });
          return { result: doc.toObject(), details: { provider: doc.key, last4, reason } };
        },
      );
      return providerSummary(updated, available(updated.key));
    },

    // ---- Models -------------------------------------------------------------
    listModels: () => modelSummaries(),

    async createModel(body: CreateAiModelBody, actorId: string, ctx: ClientContext) {
      const params = AiModelParams.parse(body.params);
      const created = await audited(
        ctx,
        actorId,
        { action: 'ai.model_created', resourceType: 'aiModel', resourceId: body.modelId },
        async (session) => {
          const provider = await loadProvider(body.providerId, session);
          if (!available(provider.key)) {
            throw AppError.validation('This provider cannot run in this environment.');
          }
          const exists = await AiModelModel.exists({
            providerId: provider._id,
            modelId: body.modelId,
          }).session(session);
          if (exists) throw AppError.conflict('This model is already configured for the provider.');
          const [doc] = await AiModelModel.create(
            [
              {
                providerId: provider._id,
                modelId: body.modelId,
                displayName: body.displayName,
                capabilities: [...new Set(body.capabilities)],
                enabled: true,
                languages: body.languages,
                params,
                pricing: [],
              },
            ],
            { session },
          );
          return {
            result: doc!._id,
            details: {
              modelId: body.modelId,
              provider: provider.key,
              capabilities: body.capabilities,
              params,
            },
          };
        },
      );
      return oneModel(created);
    },

    async updateModel(id: string, body: UpdateAiModelBody, actorId: string, ctx: ClientContext) {
      const modelId = await audited(
        ctx,
        actorId,
        { action: 'ai.model_updated', resourceType: 'aiModel', resourceId: id },
        async (session) => {
          const doc = await loadModel(id, session);
          const snapshot = () => ({
            displayName: doc.displayName,
            enabled: doc.enabled,
            languages: [...doc.languages],
            params: {
              temperature: doc.params.temperature ?? null,
              maxOutputTokens: doc.params.maxOutputTokens,
              timeoutMs: doc.params.timeoutMs,
              retries: doc.params.retries,
              concurrency: doc.params.concurrency,
            },
          });
          const before = snapshot();
          if (body.displayName !== undefined) doc.displayName = body.displayName;
          if (body.enabled !== undefined) doc.enabled = body.enabled;
          if (body.languages !== undefined) doc.languages = body.languages;
          if (body.params) doc.params = AiModelParams.parse({ ...before.params, ...body.params });
          await doc.save({ session });
          return {
            result: doc._id,
            details: { modelId: doc.modelId, changes: diff(before, snapshot()) },
          };
        },
      );
      return oneModel(modelId);
    },

    async addPrice(id: string, body: AddAiModelPriceBody, actorId: string, ctx: ClientContext) {
      const at = now();
      const effectiveFrom = body.effectiveFrom ? new Date(body.effectiveFrom) : at;
      // One minute of slack for clock skew between the admin's browser and the server.
      if (effectiveFrom.getTime() < at.getTime() - 60_000) {
        throw AppError.validation(
          'Prices cannot take effect in the past; recorded usage keeps its price.',
        );
      }
      const modelId = await audited(
        ctx,
        actorId,
        { action: 'ai.model_price_added', resourceType: 'aiModel', resourceId: id },
        async (session) => {
          const model = await loadModel(id, session);
          const currencies = new Set(model.pricing.map((p) => p.currency));
          if (currencies.size > 0 && !currencies.has(body.currency)) {
            throw AppError.validation(
              `This model is priced in ${[...currencies][0]}; use the same currency.`,
            );
          }
          model.pricing.push({
            unit: body.unit,
            pricePerUnitMicros: body.price,
            currency: body.currency,
            effectiveFrom,
            addedBy: new mongoose.Types.ObjectId(actorId),
          });
          await model.save({ session });
          return {
            result: model._id,
            details: {
              modelId: model.modelId,
              unit: body.unit,
              pricePerUnitMicros: body.price,
              currency: body.currency,
              effectiveFrom: iso(effectiveFrom),
              reason: body.reason,
            },
          };
        },
      );
      return oneModel(modelId);
    },

    /** Sends a tiny request straight to one model (no fallback) to check its key and model id. */
    async testModel(id: string, actorId: string, ctx: ClientContext): Promise<TestAiModelResponse> {
      const model = await loadModel(id);
      const started = performance.now();
      let response: TestAiModelResponse;
      try {
        const result = await ai.router.runOnModel(
          String(model._id),
          'admin.test',
          {
            messages: [
              { role: 'user', content: 'Connectivity check. Reply with the single word OK.' },
            ],
            // Leaves room for adaptive thinking before the one-word answer.
            maxOutputTokens: 512,
          },
          { correlationId: ctx.requestId, userId: actorId },
        );
        response = {
          ok: true,
          outcome: 'SUCCESS',
          latencyMs: Math.round(performance.now() - started),
          servedModel: result.servedModel,
          sample: result.text.slice(0, 120),
          message: null,
        };
      } catch (err) {
        if (!(err instanceof AiUnavailableError)) throw err;
        const last = err.attempts.at(-1);
        const outcome: AiCallOutcome =
          last && last.outcome !== 'SKIPPED' ? last.outcome : 'PROVIDER_ERROR';
        response = {
          ok: false,
          outcome,
          latencyMs: Math.round(performance.now() - started),
          servedModel: null,
          sample: null,
          message:
            last?.outcome === 'SKIPPED'
              ? `Not called: ${last.detail}`
              : `Failed: ${last?.detail ?? 'unknown'}`,
        };
      }
      await audit.record(
        {
          actorType: 'ADMIN',
          actorId,
          action: 'ai.model_tested',
          resourceType: 'aiModel',
          resourceId: id,
          outcome: response.ok ? 'SUCCESS' : 'FAILURE',
          details: {
            modelId: model.modelId,
            outcome: response.outcome,
            latencyMs: response.latencyMs,
          },
        },
        ctx,
      );
      return response;
    },

    // ---- Routes -------------------------------------------------------------
    listRoutes,

    async upsertRoute(
      feature: AiFeature,
      body: UpsertAiRouteBody,
      actorId: string,
      ctx: ClientContext,
    ) {
      if (!(ROUTABLE_FEATURES as readonly AiFeature[]).includes(feature))
        throw AppError.notFound('Unknown feature');
      await audited(
        ctx,
        actorId,
        { action: 'ai.route_updated', resourceType: 'aiRoute', resourceId: feature },
        async (session) => {
          if (body.active && body.chain.length === 0) {
            throw AppError.validation('An active route needs at least one model.');
          }
          const ids = body.chain.map((c) => objectId(c.modelId, 'Model'));
          const models = await AiModelModel.find(
            { _id: { $in: ids } },
            { capabilities: 1, modelId: 1 },
          )
            .session(session)
            .lean();
          if (models.length !== ids.length)
            throw AppError.validation('A model in the chain does not exist.');
          const capability = AI_FEATURE_CAPABILITY[feature];
          const wrong = models.filter((m) => !m.capabilities.includes(capability));
          if (wrong.length > 0) {
            throw AppError.validation(
              `${wrong.map((m) => m.modelId).join(', ')} cannot serve ${feature} (needs ${capability}).`,
            );
          }
          const before = await AiRouteModel.findOne({ feature }).session(session).lean();
          const chain = body.chain.map((c, i) => ({ modelId: ids[i]!, priority: c.priority }));
          await AiRouteModel.updateOne(
            { feature },
            { $set: { active: body.active, chain }, $setOnInsert: { feature } },
            { upsert: true, session },
          );
          return {
            result: undefined,
            details: {
              reason: body.reason,
              from: before ? { active: before.active, chain: plainChain(before.chain) } : null,
              to: { active: body.active, chain: plainChain(chain) },
            },
          };
        },
      );
      return (await listRoutes()).find((r) => r.feature === feature)!;
    },

    // ---- Usage and cost -----------------------------------------------------
    async usageReport(query: AiUsageQuery): Promise<AiUsageReport> {
      const to = query.to ? new Date(query.to) : now();
      const from = query.from
        ? new Date(query.from)
        : new Date(to.getTime() - 7 * 24 * 3600 * 1000);
      const match: Record<string, unknown> = { at: { $gte: from, $lt: to } };
      if (query.feature) match.feature = query.feature;
      const key =
        query.groupBy === 'feature'
          ? '$feature'
          : query.groupBy === 'model'
            ? '$modelRef'
            : { $dateToString: { format: '%Y-%m-%d', date: '$at', timezone: 'UTC' } };
      const grouped = await AiUsageModel.aggregate<{
        _id: { key: unknown; currency: string };
        calls: number;
        failures: number;
        inputTokens: number;
        outputTokens: number;
        costMicros: number;
        latencySum: number;
      }>([
        { $match: match },
        {
          $group: {
            _id: { key, currency: '$currency' },
            calls: { $sum: 1 },
            failures: { $sum: { $cond: [{ $eq: ['$outcome', 'SUCCESS'] }, 0, 1] } },
            inputTokens: { $sum: '$units.inputTokens' },
            outputTokens: { $sum: '$units.outputTokens' },
            costMicros: { $sum: '$costMicros' },
            latencySum: { $sum: '$latencyMs' },
          },
        },
      ]);
      const labels = query.groupBy === 'model' ? await modelLabels() : null;
      type Acc = AiUsageRow & { latencySum: number };
      const empty = (k: string): Acc => ({
        key: k,
        calls: 0,
        failures: 0,
        inputTokens: 0,
        outputTokens: 0,
        costMicros: {},
        avgLatencyMs: 0,
        latencySum: 0,
      });
      const rows = new Map<string, Acc>();
      const totals = empty('total');
      for (const g of grouped) {
        const raw = String(g._id.key);
        const label = labels ? (labels.get(raw) ?? raw) : raw;
        const row = rows.get(label) ?? empty(label);
        for (const target of [row, totals]) {
          target.calls += g.calls;
          target.failures += g.failures;
          target.inputTokens += g.inputTokens;
          target.outputTokens += g.outputTokens;
          target.latencySum += g.latencySum;
          target.costMicros[g._id.currency] =
            (target.costMicros[g._id.currency] ?? 0) + g.costMicros;
        }
        rows.set(label, row);
      }
      const finish = ({ latencySum, ...r }: Acc): AiUsageRow => ({
        ...r,
        avgLatencyMs: r.calls ? Math.round(latencySum / r.calls) : 0,
      });
      const totalCost = (r: AiUsageRow) => Object.values(r.costMicros).reduce((a, b) => a + b, 0);
      const sorted = [...rows.values()]
        .map(finish)
        .sort((a, b) =>
          query.groupBy === 'day'
            ? a.key.localeCompare(b.key)
            : totalCost(b) - totalCost(a) || b.calls - a.calls,
        );
      return {
        from: iso(from),
        to: iso(to),
        groupBy: query.groupBy,
        rows: sorted,
        totals: finish(totals),
      };
    },

    async usageEntries(query: AiUsageEntriesQuery): Promise<AiUsageEntriesPage> {
      const filter: Record<string, unknown> = {};
      if (query.feature) filter.feature = query.feature;
      if (query.outcome) filter.outcome = query.outcome;
      if (query.before) {
        if (!mongoose.isValidObjectId(query.before)) throw AppError.validation('Invalid before');
        filter._id = { $lt: new mongoose.Types.ObjectId(query.before) };
      }
      const docs = await AiUsageModel.find(filter)
        .sort({ _id: -1 })
        .limit(query.limit + 1)
        .lean();
      const page = docs.slice(0, query.limit);
      return {
        items: page.map((d) => ({
          id: String(d._id),
          at: iso(d.at),
          feature: d.feature,
          provider: d.provider,
          model: d.model,
          servedModel: d.servedModel ?? null,
          outcome: d.outcome,
          errorCode: d.errorCode ?? null,
          attempt: d.attempt,
          latencyMs: d.latencyMs,
          inputTokens: d.units.inputTokens,
          outputTokens: d.units.outputTokens,
          costMicros: d.costMicros,
          currency: d.currency,
          correlationId: d.correlationId ?? null,
          promptKey: d.promptKey ?? null,
          promptVersion: d.promptVersion ?? null,
        })),
        nextCursor: docs.length > query.limit ? String(page.at(-1)!._id) : null,
      };
    },

    async health(): Promise<AiModelHealth[]> {
      const models = await modelSummaries();
      const ids = models.map((m) => new mongoose.Types.ObjectId(m.id));
      const [breakers, latest] = await Promise.all([
        ai.router.breakerStates(models.map((m) => m.id)),
        ProviderHealthModel.aggregate<{
          _id: mongoose.Types.ObjectId;
          windowStart: Date;
          calls: number;
          errorRate: number;
          p50LatencyMs: number | null;
          p95LatencyMs: number | null;
          status: AiModelHealth['status'];
        }>([
          { $match: { window: HEALTH_WINDOW, modelRef: { $in: ids } } },
          { $sort: { windowStart: -1 } },
          {
            $group: {
              _id: '$modelRef',
              windowStart: { $first: '$windowStart' },
              calls: { $first: '$calls' },
              errorRate: { $first: '$errorRate' },
              p50LatencyMs: { $first: '$p50LatencyMs' },
              p95LatencyMs: { $first: '$p95LatencyMs' },
              status: { $first: '$status' },
            },
          },
        ]),
      ]);
      const byModel = new Map(latest.map((l) => [String(l._id), l]));
      const at = now().getTime();
      return models.map((m) => {
        const doc = byModel.get(m.id);
        const fresh = doc !== undefined && at - doc.windowStart.getTime() < HEALTH_STALE_MS;
        const breaker = breakers[m.id] ?? 'CLOSED';
        return {
          modelId: m.id,
          provider: m.providerKey,
          model: m.modelId,
          breaker,
          status: breaker === 'OPEN' ? 'DOWN' : fresh ? doc.status : 'IDLE',
          windowStart: doc ? iso(doc.windowStart) : null,
          calls: fresh ? doc.calls : 0,
          errorRate: fresh ? doc.errorRate : 0,
          p50LatencyMs: fresh ? doc.p50LatencyMs : null,
          p95LatencyMs: fresh ? doc.p95LatencyMs : null,
        };
      });
    },

    // ---- Prompt registry ----------------------------------------------------
    async listPrompts(query: PromptListQuery): Promise<PromptTemplateSummary[]> {
      const filter: Record<string, unknown> = {};
      if (query.key) filter.key = query.key;
      if (query.status) filter.status = query.status;
      const docs = await PromptTemplateModel.find(filter)
        .sort({ key: 1, locale: 1, version: -1 })
        .limit(500)
        .lean();
      return docs.map(promptSummary);
    },

    async createPromptVersion(body: CreatePromptVersionBody, actorId: string, ctx: ClientContext) {
      const contentHash = createHash('sha256')
        .update(JSON.stringify({ feature: body.feature, messages: body.messages }))
        .digest('hex');
      const created = await audited(
        ctx,
        actorId,
        {
          action: 'prompt.version_created',
          resourceType: 'promptTemplate',
          resourceId: `${body.key}:${body.locale}`,
        },
        async (session) => {
          const latest = await PromptTemplateModel.findOne({ key: body.key, locale: body.locale })
            .sort({ version: -1 })
            .session(session)
            .lean();
          if (latest?.contentHash === contentHash) {
            throw AppError.conflict(`Version ${latest.version} already has exactly this content.`);
          }
          const version = (latest?.version ?? 0) + 1;
          const [doc] = await PromptTemplateModel.create(
            [
              {
                key: body.key,
                version,
                locale: body.locale,
                feature: body.feature,
                status: 'DRAFT',
                messages: body.messages,
                variables: extractVariables(body.messages),
                notes: body.notes ?? null,
                contentHash,
                createdBy: new mongoose.Types.ObjectId(actorId),
              },
            ],
            { session },
          );
          return {
            result: doc!.toObject(),
            details: {
              key: body.key,
              locale: body.locale,
              version,
              feature: body.feature,
              contentHash,
            },
          };
        },
      );
      return promptSummary(created);
    },

    /** Makes a version ACTIVE and retires the previous one (also how a rollback is done). */
    async activatePrompt(id: string, reason: string, actorId: string, ctx: ClientContext) {
      const activated = await audited(
        ctx,
        actorId,
        { action: 'prompt.version_activated', resourceType: 'promptTemplate', resourceId: id },
        async (session) => {
          const target = await PromptTemplateModel.findById(objectId(id, 'Prompt'), null, {
            session,
          }).lean();
          if (!target) throw AppError.notFound('Prompt not found');
          if (target.status === 'ACTIVE')
            throw AppError.conflict('This version is already active.');
          const at = now();
          const previous = await PromptTemplateModel.findOneAndUpdate(
            { key: target.key, locale: target.locale, status: 'ACTIVE' },
            { $set: { status: 'RETIRED', retiredAt: at } },
            { session },
          ).lean();
          await PromptTemplateModel.updateOne(
            { _id: target._id },
            { $set: { status: 'ACTIVE', activatedAt: at, retiredAt: null } },
            { session },
          );
          const doc = await PromptTemplateModel.findById(target._id, null, { session }).lean();
          return {
            result: doc!,
            details: {
              key: target.key,
              locale: target.locale,
              activatedVersion: target.version,
              retiredVersion: previous?.version ?? null,
              reason,
            },
          };
        },
      );
      return promptSummary(activated);
    },
  };
}

export type AiAdminService = ReturnType<typeof createAiAdminService>;

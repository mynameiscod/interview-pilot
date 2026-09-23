import type {
  AiRuntimeConfig,
  AiUsageRecord,
  PromptTemplateData,
  RuntimeModel,
  RuntimeProvider,
  RuntimeRoute,
  UsageSink,
} from '@cbi/ai-core';
import {
  AI_FEATURE_CAPABILITY,
  AiFeature,
  type AiCapability,
  type AiModelParams,
  type AiProviderKey,
  type Currency,
  type PricingUnit,
} from '@cbi/shared-types';
import mongoose from 'mongoose';
import {
  AiModelModel,
  AiProviderModel,
  AiRouteModel,
  AiUsageModel,
  PromptTemplateModel,
} from './models/ai.js';

/** Reads providers, models and routes into the router's runtime shape. */
export async function loadAiRuntimeConfig(): Promise<AiRuntimeConfig> {
  const [providers, models, routes] = await Promise.all([
    AiProviderModel.find().lean(),
    AiModelModel.find().lean(),
    AiRouteModel.find().lean(),
  ]);
  return {
    providers: new Map(
      providers.map((p): [string, RuntimeProvider] => [
        String(p._id),
        {
          id: String(p._id),
          key: p.key as AiProviderKey,
          enabled: p.enabled,
          credential: p.credential
            ? {
                ciphertext: p.credential.ciphertext,
                iv: p.credential.iv,
                tag: p.credential.tag,
                keyId: p.credential.keyId,
                last4: p.credential.last4,
              }
            : null,
          baseUrl: p.baseUrl ?? null,
        },
      ]),
    ),
    models: new Map(
      models.map((m): [string, RuntimeModel] => [
        String(m._id),
        {
          id: String(m._id),
          providerId: String(m.providerId),
          modelId: m.modelId,
          enabled: m.enabled,
          capabilities: m.capabilities as AiCapability[],
          params: {
            temperature: m.params.temperature ?? null,
            maxOutputTokens: m.params.maxOutputTokens,
            timeoutMs: m.params.timeoutMs,
            retries: m.params.retries,
            concurrency: m.params.concurrency,
          },
          pricing: m.pricing.map((p) => ({
            unit: p.unit as PricingUnit,
            pricePerUnitMicros: p.pricePerUnitMicros,
            currency: p.currency as Currency,
            effectiveFrom: p.effectiveFrom,
          })),
        },
      ]),
    ),
    routes: new Map(
      routes.map((r): [AiFeature, RuntimeRoute] => [
        r.feature as AiFeature,
        {
          feature: r.feature as AiFeature,
          active: r.active,
          chain: r.chain.map((c) => ({ modelId: String(c.modelId), priority: c.priority })),
        },
      ]),
    ),
    loadedAt: new Date(),
  };
}

const asObjectId = (value: string | undefined) =>
  value && mongoose.isValidObjectId(value) ? new mongoose.Types.ObjectId(value) : null;

/** Appends one `aiUsage` row per provider call. */
export function createMongoUsageSink(): UsageSink {
  return {
    async record(r: AiUsageRecord) {
      await AiUsageModel.create({
        at: r.at,
        feature: r.feature,
        provider: r.providerKey,
        providerId: r.providerId,
        modelRef: r.modelRef,
        model: r.model,
        servedModel: r.servedModel,
        sessionId: r.context.sessionId ?? null,
        userId: asObjectId(r.context.userId),
        correlationId: r.context.correlationId ?? null,
        promptKey: r.context.prompt?.key ?? null,
        promptVersion: r.context.prompt?.version ?? null,
        units: r.units,
        latencyMs: r.latencyMs,
        attempt: r.attempt,
        outcome: r.outcome,
        errorCode: r.errorCode,
        priceSnapshot: r.priceSnapshot,
        costMicros: r.costMicros,
        currency: r.currency,
      });
    },
  };
}

/** The ACTIVE prompt template for key+locale (the registry adds caching and fallback). */
export async function loadActivePrompt(
  key: string,
  locale: string,
): Promise<PromptTemplateData | null> {
  const doc = await PromptTemplateModel.findOne({ key, locale, status: 'ACTIVE' }).lean();
  if (!doc) return null;
  return {
    id: String(doc._id),
    key: doc.key,
    version: doc.version,
    locale: doc.locale,
    feature: doc.feature as AiFeature,
    messages: doc.messages.map((m) => ({ role: m.role as 'system' | 'user', content: m.content })),
  };
}

// ---- Default catalog -------------------------------------------------------------

interface CatalogModel {
  provider: AiProviderKey;
  modelId: string;
  displayName: string;
  capabilities: AiCapability[];
  params: AiModelParams;
  /** USD micro-units per pricing unit. */
  prices: Partial<Record<PricingUnit, number>>;
}

const PROVIDERS: { key: AiProviderKey; displayName: string }[] = [
  { key: 'anthropic', displayName: 'Anthropic' },
  { key: 'openai', displayName: 'OpenAI' },
  { key: 'gemini', displayName: 'Google Gemini' },
];

/**
 * Seeded models. Prices are Anthropic's first-party list prices at the time
 * of writing and are editable (effective-dated) in Admin. OpenAI and Gemini
 * models are added by admins with their current ids and prices.
 */
const MODELS: CatalogModel[] = [
  {
    provider: 'anthropic',
    modelId: 'claude-opus-5',
    displayName: 'Claude Opus 5',
    capabilities: ['LLM'],
    params: {
      temperature: null,
      maxOutputTokens: 16_000,
      timeoutMs: 120_000,
      retries: 1,
      concurrency: 20,
    },
    prices: {
      PER_1M_INPUT_TOKENS: 5_000_000,
      PER_1M_CACHED_INPUT_TOKENS: 500_000,
      PER_1M_OUTPUT_TOKENS: 25_000_000,
    },
  },
  {
    provider: 'anthropic',
    modelId: 'claude-sonnet-5',
    displayName: 'Claude Sonnet 5',
    capabilities: ['LLM'],
    params: {
      temperature: null,
      maxOutputTokens: 16_000,
      timeoutMs: 90_000,
      retries: 1,
      concurrency: 20,
    },
    prices: {
      PER_1M_INPUT_TOKENS: 2_000_000,
      PER_1M_CACHED_INPUT_TOKENS: 200_000,
      PER_1M_OUTPUT_TOKENS: 10_000_000,
    },
  },
  {
    provider: 'anthropic',
    modelId: 'claude-haiku-4-5',
    displayName: 'Claude Haiku 4.5',
    capabilities: ['LLM'],
    params: {
      temperature: null,
      maxOutputTokens: 8_000,
      timeoutMs: 60_000,
      retries: 1,
      concurrency: 20,
    },
    prices: {
      PER_1M_INPUT_TOKENS: 1_000_000,
      PER_1M_CACHED_INPUT_TOKENS: 100_000,
      PER_1M_OUTPUT_TOKENS: 5_000_000,
    },
  },
];

export const MOCK_CATALOG_MODEL_ID = 'mock-llm';

/** LLM features routed by default: Opus 5 first, Sonnet 5 as fallback (and the mock last in dev). */
const DEFAULT_CHAIN = ['claude-opus-5', 'claude-sonnet-5'];

export interface EnsureAiCatalogResult {
  providersCreated: number;
  modelsCreated: number;
  routesCreated: number;
}

/**
 * Idempotent first-run seed. Inserts missing providers, models and routes
 * and never modifies existing ones, so admin changes always win. The mock
 * provider is only created when `mockMode` is on (development/test).
 */
export async function ensureAiCatalog(opts: {
  mockMode: boolean;
  now?: Date;
}): Promise<EnsureAiCatalogResult> {
  const now = opts.now ?? new Date();
  const result: EnsureAiCatalogResult = { providersCreated: 0, modelsCreated: 0, routesCreated: 0 };
  const providers = [
    ...PROVIDERS,
    ...(opts.mockMode ? [{ key: 'mock' as const, displayName: 'Mock (development only)' }] : []),
  ];
  const models: CatalogModel[] = [
    ...MODELS,
    ...(opts.mockMode
      ? [
          {
            provider: 'mock' as const,
            modelId: MOCK_CATALOG_MODEL_ID,
            displayName: 'Mock LLM (deterministic)',
            capabilities: ['LLM'] as AiCapability[],
            params: {
              temperature: null,
              maxOutputTokens: 4096,
              timeoutMs: 5000,
              retries: 0,
              concurrency: 100,
            },
            prices: {},
          },
        ]
      : []),
  ];

  const providerIds = new Map<AiProviderKey, mongoose.Types.ObjectId>();
  for (const p of providers) {
    const res = await AiProviderModel.updateOne(
      { key: p.key },
      { $setOnInsert: { key: p.key, displayName: p.displayName, enabled: true, credential: null } },
      { upsert: true },
    );
    result.providersCreated += res.upsertedCount;
    const doc = await AiProviderModel.findOne({ key: p.key }, { _id: 1 }).lean();
    providerIds.set(p.key, doc!._id);
  }

  const modelIds = new Map<string, mongoose.Types.ObjectId>();
  for (const m of models) {
    const providerId = providerIds.get(m.provider)!;
    const res = await AiModelModel.updateOne(
      { providerId, modelId: m.modelId },
      {
        $setOnInsert: {
          providerId,
          modelId: m.modelId,
          displayName: m.displayName,
          capabilities: m.capabilities,
          enabled: true,
          languages: [],
          params: m.params,
          pricing: Object.entries(m.prices).map(([unit, micros]) => ({
            unit,
            pricePerUnitMicros: micros,
            currency: 'USD',
            effectiveFrom: now,
          })),
        },
      },
      { upsert: true },
    );
    result.modelsCreated += res.upsertedCount;
    const doc = await AiModelModel.findOne({ providerId, modelId: m.modelId }, { _id: 1 }).lean();
    modelIds.set(m.modelId, doc!._id);
  }

  const chainIds = [...DEFAULT_CHAIN, ...(opts.mockMode ? [MOCK_CATALOG_MODEL_ID] : [])]
    .map((id) => modelIds.get(id))
    .filter((id): id is mongoose.Types.ObjectId => Boolean(id));
  const llmFeatures = AiFeature.options.filter(
    (f) => AI_FEATURE_CAPABILITY[f] === 'LLM' && f !== 'admin.test',
  );
  for (const feature of llmFeatures) {
    const res = await AiRouteModel.updateOne(
      { feature },
      {
        $setOnInsert: {
          feature,
          active: true,
          chain: chainIds.map((modelId, i) => ({
            modelId,
            priority: i === chainIds.length - 1 && opts.mockMode ? 99 : i,
          })),
        },
      },
      { upsert: true },
    );
    result.routesCreated += res.upsertedCount;
  }
  return result;
}

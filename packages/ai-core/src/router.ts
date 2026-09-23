import {
  AI_FEATURE_CAPABILITY,
  type AiCallOutcome,
  type AiFeature,
  type BreakerState,
} from '@cbi/shared-types';
import {
  closedBreaker,
  DEFAULT_BREAKER_POLICY,
  effectiveState,
  recordBreakerEvent,
  type BreakerPolicy,
} from './breaker.js';
import type { CoordinationStore } from './coordination.js';
import { calculateCost, effectivePricing } from './cost.js';
import {
  AiAbortedError,
  AiProviderError,
  AiUnavailableError,
  countsAgainstBreaker,
  type AttemptSummary,
} from './errors.js';
import type { SecretBox } from './secrets.js';
import {
  ZERO_USAGE,
  type AdapterRegistry,
  type AiCallContext,
  type AiConfigSource,
  type AiLogger,
  type AiRuntimeConfig,
  type ChatMessage,
  type LlmAdapter,
  type LlmCallResult,
  type LlmRequest,
  type RuntimeModel,
  type RuntimeProvider,
  type UsageSink,
  type UsageUnits,
} from './types.js';

export interface RouterPolicy {
  breaker: BreakerPolicy;
  /** Full-jitter exponential backoff between same-model retries. */
  backoffBaseMs: number;
  backoffMaxMs: number;
  /** How long to wait for a concurrency slot before moving to the next model. */
  slotWaitMs: number;
}

export const DEFAULT_ROUTER_POLICY: RouterPolicy = {
  breaker: DEFAULT_BREAKER_POLICY,
  backoffBaseMs: 250,
  backoffMaxMs: 4000,
  slotWaitMs: 2000,
};

export interface AiRouterDeps {
  config: AiConfigSource;
  adapters: AdapterRegistry;
  secrets: SecretBox;
  coordination: CoordinationStore;
  usage: UsageSink;
  logger: AiLogger;
  policy?: Partial<RouterPolicy>;
  now?: () => Date;
  random?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

export interface AiRunResult<T> {
  text: string;
  /** Present when the request asked for structured output; schema-validated. */
  data: T;
  feature: AiFeature;
  model: { id: string; providerKey: string; modelId: string };
  servedModel: string | null;
  attempts: AttemptSummary[];
  usage: UsageUnits;
  costMicros: number;
}

export type SkipReason =
  | 'model_missing'
  | 'model_disabled'
  | 'capability_mismatch'
  | 'provider_disabled'
  | 'no_credentials'
  | 'credential_unreadable'
  | 'adapter_unavailable'
  | 'circuit_open'
  | 'saturated';

const REPAIR_INSTRUCTION =
  'Your previous reply did not match the required JSON schema. Reply again with only the corrected JSON object, no prose and no code fences. Problems: ';

export const providerSecretContext = (providerKey: string) => `aiProvider:${providerKey}`;

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal!.reason);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** Strips optional ``` fences and parses JSON; throws on invalid JSON. */
export function parseJsonOutput(text: string): unknown {
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  return JSON.parse(fenced ? fenced[1]! : trimmed);
}

function addUsage(a: UsageUnits, b: UsageUnits): UsageUnits {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    cachedInputTokens: a.cachedInputTokens + b.cachedInputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    requests: a.requests + b.requests,
  };
}

class InvalidOutputError extends Error {
  constructor(public readonly issues: string) {
    super('model output failed schema validation');
  }
}

/**
 * Routes a feature to the configured fallback chain. For each model, in
 * priority order, it skips unusable ones (disabled, no key, open circuit,
 * saturated), then calls with a timeout and jittered retries for transient
 * errors. Structured output gets one repair attempt, then the next model.
 * Every provider call writes a usage row with the price snapshot in force.
 * When the chain is exhausted it throws `AiUnavailableError`; it never
 * fabricates a response.
 */
export function createAiRouter(deps: AiRouterDeps) {
  const policy: RouterPolicy = {
    ...DEFAULT_ROUTER_POLICY,
    ...deps.policy,
    breaker: { ...DEFAULT_ROUTER_POLICY.breaker, ...deps.policy?.breaker },
  };
  const now = deps.now ?? (() => new Date());
  const random = deps.random ?? Math.random;
  const sleep = deps.sleep ?? defaultSleep;
  const log = deps.logger;

  // Redis trouble must not stop AI calls: coordination fails open, logged.
  async function safely<T>(what: string, fn: () => Promise<T>, fallback: T): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      log.warn({ err, what }, 'ai coordination unavailable; continuing without it');
      return fallback;
    }
  }

  async function breakerState(modelRef: string): Promise<BreakerState> {
    const snap = await safely('breaker.read', () => deps.coordination.readBreaker(modelRef), null);
    return snap ? effectiveState(snap, now().getTime(), policy.breaker) : 'CLOSED';
  }

  async function recordBreaker(modelRef: string, event: 'success' | 'failure') {
    await safely(
      'breaker.write',
      async () => {
        const t = now().getTime();
        const current = (await deps.coordination.readBreaker(modelRef)) ?? closedBreaker(t);
        const next = recordBreakerEvent(current, event, t, policy.breaker);
        if (next !== current) {
          if (next.state === 'OPEN' && current.state !== 'OPEN') {
            log.warn({ modelRef }, 'ai circuit opened');
          }
          await deps.coordination.writeBreaker(
            modelRef,
            next,
            policy.breaker.windowMs + policy.breaker.openMs * 4,
          );
        }
      },
      undefined,
    );
  }

  async function acquireSlot(
    model: RuntimeModel,
    signal?: AbortSignal,
  ): Promise<string | null | 'none'> {
    const leaseMs = model.params.timeoutMs * (model.params.retries + 2) + 5000;
    const deadline = now().getTime() + policy.slotWaitMs;
    let wait = 50;
    for (;;) {
      const token = await safely(
        'slot.acquire',
        () => deps.coordination.acquireSlot(model.id, model.params.concurrency, leaseMs),
        'none' as const,
      );
      if (token !== null) return token;
      if (now().getTime() + wait > deadline) return null;
      await sleep(wait, signal);
      wait = Math.min(wait * 2, 400);
    }
  }

  function backoff(attempt: number): number {
    const cap = Math.min(policy.backoffMaxMs, policy.backoffBaseMs * 2 ** (attempt - 1));
    return Math.round(random() * cap);
  }

  interface Candidate {
    model: RuntimeModel;
    provider: RuntimeProvider;
    adapter: LlmAdapter;
    apiKey: string;
  }

  /** Resolves a chain entry to something callable, or the reason it is not. */
  function resolve(
    config: AiRuntimeConfig,
    feature: AiFeature,
    modelRef: string,
  ): { candidate: Omit<Candidate, 'apiKey'> } | { skip: SkipReason; model?: RuntimeModel } {
    const model = config.models.get(modelRef);
    if (!model) return { skip: 'model_missing' };
    if (!model.enabled) return { skip: 'model_disabled', model };
    if (!model.capabilities.includes(AI_FEATURE_CAPABILITY[feature])) {
      return { skip: 'capability_mismatch', model };
    }
    const provider = config.providers.get(model.providerId);
    if (!provider || !provider.enabled) return { skip: 'provider_disabled', model };
    const adapter = deps.adapters.llm(provider.key);
    if (!adapter) return { skip: 'adapter_unavailable', model };
    if (!provider.credential && provider.key !== 'mock') return { skip: 'no_credentials', model };
    return { candidate: { model, provider, adapter } };
  }

  async function record(
    feature: AiFeature,
    c: Candidate,
    ctx: AiCallContext,
    outcome: AiCallOutcome,
    fields: {
      attempt: number;
      latencyMs: number;
      units: UsageUnits;
      servedModel: string | null;
      errorCode: string | null;
    },
  ): Promise<number> {
    const at = now();
    const snapshot = effectivePricing(c.model.pricing, at);
    const cost = snapshot ? calculateCost(fields.units, snapshot) : null;
    const { signal: _signal, ...context } = ctx;
    try {
      await deps.usage.record({
        at,
        feature,
        providerKey: c.provider.key,
        providerId: c.provider.id,
        modelRef: c.model.id,
        model: c.model.modelId,
        servedModel: fields.servedModel,
        outcome,
        errorCode: fields.errorCode,
        attempt: fields.attempt,
        latencyMs: fields.latencyMs,
        units: fields.units,
        priceSnapshot: snapshot,
        costMicros: cost?.costMicros ?? 0,
        currency: snapshot?.currency ?? 'USD',
        context,
      });
    } catch (err) {
      // Metering must never fail the call; the log line lets ops reconcile.
      log.error({ err, feature, model: c.model.modelId }, 'ai usage write failed');
    }
    if (!snapshot && fields.units.requests > 0) {
      log.warn({ model: c.model.modelId }, 'ai model has no pricing in force; cost recorded as 0');
    }
    return cost?.costMicros ?? 0;
  }

  /** Calls one model with retries and the structured-output repair step. */
  async function callModel<T>(
    feature: AiFeature,
    c: Candidate,
    request: LlmRequest<T>,
    ctx: AiCallContext,
    attempts: AttemptSummary[],
  ): Promise<AiRunResult<T> | null> {
    const maxAttempts = 1 + c.model.params.retries;
    const maxOutputTokens = Math.min(
      request.maxOutputTokens ?? c.model.params.maxOutputTokens,
      c.model.params.maxOutputTokens,
    );
    let messages: ChatMessage[] = request.messages;
    let failures = 0;
    let callNumber = 0;
    let repaired = false;
    let totalUsage: UsageUnits = { ...ZERO_USAGE };
    let totalCost = 0;

    for (;;) {
      callNumber += 1;
      const timeout = AbortSignal.timeout(c.model.params.timeoutMs);
      const signal = ctx.signal ? AbortSignal.any([ctx.signal, timeout]) : timeout;
      const started = performance.now();
      let result: LlmCallResult;
      try {
        result = await c.adapter.generate({
          model: { providerKey: c.provider.key, modelId: c.model.modelId, params: c.model.params },
          request: { ...request, messages, maxOutputTokens },
          credentials: { apiKey: c.apiKey, baseUrl: c.provider.baseUrl ?? undefined },
          signal,
        });
      } catch (err) {
        const latencyMs = Math.round(performance.now() - started);
        if (ctx.signal?.aborted) {
          await record(feature, c, ctx, 'ABORTED', {
            attempt: callNumber,
            latencyMs,
            units: ZERO_USAGE,
            servedModel: null,
            errorCode: 'aborted',
          });
          throw new AiAbortedError(feature);
        }
        const error =
          err instanceof AiProviderError
            ? err
            : timeout.aborted
              ? new AiProviderError(c.provider.key, 'TIMEOUT', 'timeout', 'timed out', {
                  cause: err,
                })
              : new AiProviderError(
                  c.provider.key,
                  'PROVIDER_ERROR',
                  'unexpected',
                  'adapter error',
                  {
                    cause: err,
                  },
                );
        await record(feature, c, ctx, error.outcome, {
          attempt: callNumber,
          latencyMs,
          units: ZERO_USAGE,
          servedModel: null,
          errorCode: error.code,
        });
        if (countsAgainstBreaker(error.outcome)) await recordBreaker(c.model.id, 'failure');
        log.warn(
          {
            feature,
            model: c.model.modelId,
            outcome: error.outcome,
            code: error.code,
            attempt: callNumber,
          },
          'ai call failed',
        );
        failures += 1;
        if (error.retryable && failures < maxAttempts) {
          await sleep(backoff(failures), ctx.signal).catch(() => undefined);
          if (ctx.signal?.aborted) throw new AiAbortedError(feature);
          continue;
        }
        attempts.push({
          modelRef: c.model.id,
          model: c.model.modelId,
          outcome: error.outcome,
          detail: error.code,
        });
        return null;
      }

      const latencyMs = Math.round(performance.now() - started);
      totalUsage = addUsage(totalUsage, result.usage);

      let outcome: AiCallOutcome = 'SUCCESS';
      let data: T | undefined;
      let issues: string | null = null;
      if (result.finishReason === 'refusal') {
        outcome = 'REFUSED';
      } else if (request.output) {
        try {
          const parsed = request.output.schema.safeParse(parseJsonOutput(result.text));
          if (!parsed.success) {
            throw new InvalidOutputError(
              parsed.error.issues
                .slice(0, 8)
                .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
                .join('; '),
            );
          }
          data = parsed.data;
        } catch (err) {
          outcome = 'INVALID_OUTPUT';
          issues =
            err instanceof InvalidOutputError
              ? err.issues
              : result.finishReason === 'length'
                ? 'the reply was cut off before the JSON was complete'
                : 'the reply was not valid JSON';
        }
      }

      totalCost += await record(feature, c, ctx, outcome, {
        attempt: callNumber,
        latencyMs,
        units: result.usage,
        servedModel: result.servedModel,
        errorCode: outcome === 'SUCCESS' ? null : outcome === 'REFUSED' ? 'refusal' : 'schema',
      });
      // The provider answered, so it is healthy even if the answer was unusable.
      await recordBreaker(c.model.id, 'success');

      if (outcome === 'SUCCESS') {
        attempts.push({ modelRef: c.model.id, model: c.model.modelId, outcome, detail: null });
        return {
          text: result.text,
          data: data as T,
          feature,
          model: { id: c.model.id, providerKey: c.provider.key, modelId: c.model.modelId },
          servedModel: result.servedModel,
          attempts,
          usage: totalUsage,
          costMicros: totalCost,
        };
      }
      if (outcome === 'INVALID_OUTPUT' && !repaired) {
        repaired = true;
        messages = [
          ...request.messages,
          { role: 'assistant', content: result.text },
          { role: 'user', content: `${REPAIR_INSTRUCTION}${issues}` },
        ];
        continue;
      }
      attempts.push({
        modelRef: c.model.id,
        model: c.model.modelId,
        outcome,
        detail: outcome === 'REFUSED' ? 'refusal' : 'schema',
      });
      return null;
    }
  }

  async function withCandidate<T>(
    feature: AiFeature,
    base: Omit<Candidate, 'apiKey'>,
    request: LlmRequest<T>,
    ctx: AiCallContext,
    attempts: AttemptSummary[],
  ): Promise<AiRunResult<T> | null> {
    const skip = (detail: SkipReason) => {
      attempts.push({
        modelRef: base.model.id,
        model: base.model.modelId,
        outcome: 'SKIPPED',
        detail,
      });
      return null;
    };
    let apiKey = '';
    if (base.provider.credential) {
      try {
        apiKey = deps.secrets.decrypt(
          base.provider.credential,
          providerSecretContext(base.provider.key),
        );
      } catch (err) {
        log.error(
          { err, provider: base.provider.key },
          'ai provider credential could not be decrypted',
        );
        return skip('credential_unreadable');
      }
    }
    const token = await acquireSlot(base.model, ctx.signal).catch(() => {
      throw new AiAbortedError(feature);
    });
    if (token === null) return skip('saturated');
    try {
      return await callModel(feature, { ...base, apiKey }, request, ctx, attempts);
    } finally {
      if (token !== 'none') {
        await safely(
          'slot.release',
          () => deps.coordination.releaseSlot(base.model.id, token),
          undefined,
        );
      }
    }
  }

  return {
    /**
     * Serve `feature` through its configured chain. Throws
     * `AiUnavailableError` when no model succeeds and `AiAbortedError` when
     * the caller's signal aborts.
     */
    async run<T = undefined>(
      feature: AiFeature,
      request: LlmRequest<T>,
      ctx: AiCallContext = {},
    ): Promise<AiRunResult<T>> {
      const config = await deps.config.get();
      const route = config.routes.get(feature);
      const attempts: AttemptSummary[] = [];
      if (!route || !route.active || route.chain.length === 0) {
        throw new AiUnavailableError(
          feature,
          attempts,
          `No active AI route is configured for ${feature}`,
        );
      }
      const chain = [...route.chain].sort((a, b) => a.priority - b.priority);
      for (const entry of chain) {
        if (ctx.signal?.aborted) throw new AiAbortedError(feature);
        const resolved = resolve(config, feature, entry.modelId);
        if ('skip' in resolved) {
          attempts.push({
            modelRef: entry.modelId,
            model: resolved.model?.modelId ?? entry.modelId,
            outcome: 'SKIPPED',
            detail: resolved.skip,
          });
          continue;
        }
        const state = await breakerState(resolved.candidate.model.id);
        if (state === 'OPEN') {
          attempts.push({
            modelRef: entry.modelId,
            model: resolved.candidate.model.modelId,
            outcome: 'SKIPPED',
            detail: 'circuit_open',
          });
          continue;
        }
        if (state === 'HALF_OPEN') {
          // Exactly one caller probes a recovering model; others move on.
          const probe = await safely(
            'breaker.probe',
            () =>
              deps.coordination.tryLock(
                `probe:${resolved.candidate.model.id}`,
                resolved.candidate.model.params.timeoutMs + 1000,
              ),
            true,
          );
          if (!probe) {
            attempts.push({
              modelRef: entry.modelId,
              model: resolved.candidate.model.modelId,
              outcome: 'SKIPPED',
              detail: 'circuit_open',
            });
            continue;
          }
        }
        const result = await withCandidate(feature, resolved.candidate, request, ctx, attempts);
        if (result) {
          if (attempts.length > 1) {
            log.info(
              { feature, served: result.model.modelId, attempts },
              'ai call served by fallback',
            );
          }
          return result;
        }
      }
      log.error({ feature, attempts }, 'ai route exhausted');
      throw new AiUnavailableError(feature, attempts);
    },

    /**
     * Calls one specific model, bypassing routing and the open-circuit skip
     * (admin connectivity tests). Usage is still metered.
     */
    async runOnModel<T = undefined>(
      modelRef: string,
      feature: AiFeature,
      request: LlmRequest<T>,
      ctx: AiCallContext = {},
    ): Promise<AiRunResult<T>> {
      const config = await deps.config.get();
      const attempts: AttemptSummary[] = [];
      const resolved = resolve(config, feature, modelRef);
      if ('skip' in resolved) {
        attempts.push({
          modelRef,
          model: resolved.model?.modelId ?? modelRef,
          outcome: 'SKIPPED',
          detail: resolved.skip,
        });
        throw new AiUnavailableError(feature, attempts);
      }
      const result = await withCandidate(feature, resolved.candidate, request, ctx, attempts);
      if (!result) throw new AiUnavailableError(feature, attempts);
      return result;
    },

    async breakerStates(modelRefs: string[]): Promise<Record<string, BreakerState>> {
      const entries = await Promise.all(
        modelRefs.map(async (id) => [id, await breakerState(id)] as const),
      );
      return Object.fromEntries(entries);
    },
  };
}

export type AiRouter = ReturnType<typeof createAiRouter>;

import { randomBytes } from 'node:crypto';
import type { AiProviderKey } from '@cbi/shared-types';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createMemoryCoordination } from './coordination.js';
import { AiAbortedError, AiProviderError, AiUnavailableError } from './errors.js';
import {
  createAiRouter,
  parseJsonOutput,
  providerSecretContext,
  type AiRouterDeps,
} from './router.js';
import { createSecretBox } from './secrets.js';
import type {
  AiRuntimeConfig,
  AiUsageRecord,
  LlmAdapter,
  LlmCallInput,
  LlmCallResult,
  RuntimeModel,
  RuntimeProvider,
} from './types.js';

const silent = { debug() {}, info() {}, warn() {}, error() {} };
const box = createSecretBox({ currentKeyId: 'k1', keys: { k1: randomBytes(32) } });

type Step = LlmCallResult | AiProviderError | ((input: LlmCallInput) => Promise<LlmCallResult>);

/** A scripted adapter: each call consumes the next step for the model id. */
function scriptedAdapter(providerKey: AiProviderKey, script: Record<string, Step[]>) {
  const calls: LlmCallInput[] = [];
  const adapter: LlmAdapter = {
    providerKey,
    async generate(input) {
      calls.push(input);
      const step = script[input.model.modelId]?.shift();
      if (!step) throw new Error(`unscripted call to ${input.model.modelId}`);
      if (step instanceof AiProviderError) throw step;
      if (typeof step === 'function') return step(input);
      return step;
    },
  };
  return { adapter, calls };
}

const ok = (text: string, overrides: Partial<LlmCallResult> = {}): LlmCallResult => ({
  text,
  servedModel: null,
  finishReason: 'stop',
  usage: { inputTokens: 1000, cachedInputTokens: 0, outputTokens: 100, requests: 1 },
  ...overrides,
});
const fail = (outcome: AiProviderError['outcome'], code = String(outcome)) =>
  new AiProviderError('test', outcome, code, 'failed');

function model(
  id: string,
  providerId: string,
  overrides: Partial<RuntimeModel> = {},
): RuntimeModel {
  return {
    id,
    providerId,
    modelId: id,
    enabled: true,
    capabilities: ['LLM'],
    params: {
      temperature: null,
      maxOutputTokens: 1000,
      timeoutMs: 5000,
      retries: 1,
      concurrency: 5,
    },
    pricing: [
      {
        unit: 'PER_1M_INPUT_TOKENS',
        pricePerUnitMicros: 5_000_000,
        currency: 'USD',
        effectiveFrom: new Date('2026-01-01'),
      },
      {
        unit: 'PER_1M_OUTPUT_TOKENS',
        pricePerUnitMicros: 25_000_000,
        currency: 'USD',
        effectiveFrom: new Date('2026-01-01'),
      },
    ],
    ...overrides,
  };
}

function provider(
  id: string,
  key: AiProviderKey,
  overrides: Partial<RuntimeProvider> = {},
): RuntimeProvider {
  return {
    id,
    key,
    enabled: true,
    credential: box.encrypt(`sk-${key}-secret`, providerSecretContext(key)),
    baseUrl: null,
    ...overrides,
  };
}

function setup(opts: {
  models: RuntimeModel[];
  providers?: RuntimeProvider[];
  chain?: string[];
  script: Record<string, Step[]>;
  deps?: Partial<AiRouterDeps>;
}) {
  const providers = opts.providers ?? [
    provider('p-anthropic', 'anthropic'),
    provider('p-openai', 'openai'),
  ];
  const config: AiRuntimeConfig = {
    providers: new Map(providers.map((p) => [p.id, p])),
    models: new Map(opts.models.map((m) => [m.id, m])),
    routes: new Map([
      [
        'interview.question',
        {
          feature: 'interview.question',
          active: true,
          chain: (opts.chain ?? opts.models.map((m) => m.id)).map((modelId, priority) => ({
            modelId,
            priority,
          })),
        },
      ],
    ]),
    loadedAt: new Date(),
  };
  const anthropic = scriptedAdapter('anthropic', opts.script);
  const openai = scriptedAdapter('openai', opts.script);
  const usage: AiUsageRecord[] = [];
  const sleeps: number[] = [];
  const coordination = createMemoryCoordination();
  const router = createAiRouter({
    config: { get: async () => config, invalidate() {} },
    adapters: {
      llm: (key) =>
        key === 'anthropic' ? anthropic.adapter : key === 'openai' ? openai.adapter : undefined,
    },
    secrets: box,
    coordination,
    usage: { record: async (r) => void usage.push(r) },
    logger: silent,
    now: () => new Date('2026-09-23T10:00:00Z'),
    random: () => 0.5,
    sleep: async (ms) => void sleeps.push(ms),
    ...opts.deps,
  });
  return {
    router,
    config,
    usage,
    sleeps,
    coordination,
    calls: [...anthropic.calls, ...openai.calls],
    anthropic,
    openai,
  };
}

const request = { messages: [{ role: 'user' as const, content: 'Ask a question.' }] };

describe('AI router', () => {
  it('serves from the first model, decrypts the key in-process and meters the call', async () => {
    const t = setup({
      models: [model('opus', 'p-anthropic')],
      script: { opus: [ok('Tell me about a project.')] },
    });
    const result = await t.router.run('interview.question', request, {
      correlationId: 'req-1',
      sessionId: 's1',
    });
    expect(result.text).toBe('Tell me about a project.');
    expect(result.model.modelId).toBe('opus');
    expect(t.anthropic.calls[0]!.credentials.apiKey).toBe('sk-anthropic-secret');
    expect(t.usage).toHaveLength(1);
    const row = t.usage[0]!;
    expect(row).toMatchObject({
      feature: 'interview.question',
      outcome: 'SUCCESS',
      providerKey: 'anthropic',
      attempt: 1,
      costMicros: 7_500, // 1000 × $5/1M + 100 × $25/1M
      currency: 'USD',
      context: { correlationId: 'req-1', sessionId: 's1' },
    });
    expect(row.priceSnapshot!.entries).toHaveLength(2);
    expect(result.costMicros).toBe(7_500);
  });

  it('retries transient errors with jittered backoff before succeeding', async () => {
    const t = setup({
      models: [model('opus', 'p-anthropic')],
      script: { opus: [fail('RATE_LIMITED', '429'), ok('ok')] },
    });
    const result = await t.router.run('interview.question', request);
    expect(result.text).toBe('ok');
    expect(t.sleeps).toEqual([125]); // random 0.5 × base 250
    expect(t.usage.map((u) => u.outcome)).toEqual(['RATE_LIMITED', 'SUCCESS']);
    expect(t.usage[0]!.costMicros).toBe(0);
  });

  it('falls back to the next model when retries are exhausted', async () => {
    const t = setup({
      models: [model('opus', 'p-anthropic'), model('gpt', 'p-openai')],
      script: {
        opus: [fail('PROVIDER_ERROR', '529'), fail('PROVIDER_ERROR', '529')],
        gpt: [ok('from gpt')],
      },
    });
    const result = await t.router.run('interview.question', request);
    expect(result.model.modelId).toBe('gpt');
    expect(result.attempts.map((a) => [a.model, a.outcome])).toEqual([
      ['opus', 'PROVIDER_ERROR'],
      ['gpt', 'SUCCESS'],
    ]);
  });

  it('does not retry non-transient errors on the same model', async () => {
    const t = setup({
      models: [model('opus', 'p-anthropic'), model('gpt', 'p-openai')],
      script: { opus: [fail('AUTH_ERROR', '401')], gpt: [ok('from gpt')] },
    });
    await t.router.run('interview.question', request);
    expect(t.anthropic.calls).toHaveLength(1);
    expect(t.sleeps).toEqual([]);
  });

  it('moves on when the model refuses', async () => {
    const t = setup({
      models: [model('opus', 'p-anthropic'), model('gpt', 'p-openai')],
      script: { opus: [ok('', { finishReason: 'refusal' })], gpt: [ok('answer')] },
    });
    const result = await t.router.run('interview.question', request);
    expect(result.model.modelId).toBe('gpt');
    expect(t.usage[0]!.outcome).toBe('REFUSED');
  });

  it('never fabricates a response: an exhausted chain throws with the attempt trail', async () => {
    const t = setup({
      models: [model('opus', 'p-anthropic', { params: { ...model('x', 'y').params, retries: 0 } })],
      script: { opus: [fail('TIMEOUT', 'timeout')] },
    });
    const err = await t.router.run('interview.question', request).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AiUnavailableError);
    expect((err as AiUnavailableError).attempts).toEqual([
      { modelRef: 'opus', model: 'opus', outcome: 'TIMEOUT', detail: 'timeout' },
    ]);
  });

  it('fails clearly when the feature has no active route', async () => {
    const t = setup({ models: [model('opus', 'p-anthropic')], script: {} });
    t.config.routes.get('interview.question')!.active = false;
    await expect(t.router.run('interview.question', request)).rejects.toThrow(/No active AI route/);
    await expect(t.router.run('role.analyze', request)).rejects.toBeInstanceOf(AiUnavailableError);
  });

  it('skips disabled models, disabled providers, missing keys, wrong capabilities and unknown adapters', async () => {
    const t = setup({
      models: [
        model('disabled', 'p-anthropic', { enabled: false }),
        model('stt', 'p-anthropic', { capabilities: ['STT'] }),
        model('nokey', 'p-nokey'),
        model('off', 'p-off'),
        model('gem', 'p-gemini'),
        model('gpt', 'p-openai'),
      ],
      providers: [
        provider('p-anthropic', 'anthropic'),
        provider('p-nokey', 'anthropic', { credential: null }),
        provider('p-off', 'anthropic', { enabled: false }),
        provider('p-gemini', 'gemini'),
        provider('p-openai', 'openai'),
      ],
      chain: ['missing', 'disabled', 'stt', 'nokey', 'off', 'gem', 'gpt'],
      script: { gpt: [ok('served')] },
    });
    const result = await t.router.run('interview.question', request);
    expect(result.attempts.map((a) => a.detail)).toEqual([
      'model_missing',
      'model_disabled',
      'capability_mismatch',
      'no_credentials',
      'provider_disabled',
      'adapter_unavailable',
      null,
    ]);
  });

  it('skips a provider whose stored key cannot be decrypted', async () => {
    const other = createSecretBox({ currentKeyId: 'k1', keys: { k1: randomBytes(32) } });
    const t = setup({
      models: [model('opus', 'p-anthropic'), model('gpt', 'p-openai')],
      providers: [
        provider('p-anthropic', 'anthropic', {
          credential: other.encrypt('sk-x', providerSecretContext('anthropic')),
        }),
        provider('p-openai', 'openai'),
      ],
      script: { gpt: [ok('served')] },
    });
    const result = await t.router.run('interview.question', request);
    expect(result.attempts[0]!.detail).toBe('credential_unreadable');
  });

  it('respects the chain priority order, not insertion order', async () => {
    const t = setup({
      models: [model('opus', 'p-anthropic'), model('gpt', 'p-openai')],
      script: { gpt: [ok('first')] },
    });
    t.config.routes.get('interview.question')!.chain = [
      { modelId: 'opus', priority: 5 },
      { modelId: 'gpt', priority: 1 },
    ];
    expect((await t.router.run('interview.question', request)).model.modelId).toBe('gpt');
  });

  describe('structured output', () => {
    const Assessment = z.object({
      sufficiency: z.enum(['LOW', 'HIGH']),
      followUpNeeded: z.boolean(),
    });
    const structured = { ...request, output: { name: 'assessment', schema: Assessment } };

    it('returns validated data (tolerating code fences)', async () => {
      const t = setup({
        models: [model('opus', 'p-anthropic')],
        script: { opus: [ok('```json\n{"sufficiency":"HIGH","followUpNeeded":false}\n```')] },
      });
      const result = await t.router.run('interview.question', structured);
      expect(result.data).toEqual({ sufficiency: 'HIGH', followUpNeeded: false });
    });

    it('asks once for a repair, sending the validation problems back', async () => {
      const t = setup({
        models: [model('opus', 'p-anthropic')],
        script: {
          opus: [ok('{"sufficiency":"MAYBE"}'), ok('{"sufficiency":"LOW","followUpNeeded":true}')],
        },
      });
      const result = await t.router.run('interview.question', structured);
      expect(result.data.followUpNeeded).toBe(true);
      const repair = t.anthropic.calls[1]!.request.messages;
      expect(repair.at(-2)).toEqual({ role: 'assistant', content: '{"sufficiency":"MAYBE"}' });
      expect(repair.at(-1)!.content).toMatch(/sufficiency: .*followUpNeeded/s);
      expect(t.usage.map((u) => [u.outcome, u.attempt])).toEqual([
        ['INVALID_OUTPUT', 1],
        ['SUCCESS', 2],
      ]);
      // Both calls were billed.
      expect(result.costMicros).toBe(15_000);
    });

    it('falls back to the next model after a failed repair, then fails loudly', async () => {
      const t = setup({
        models: [model('opus', 'p-anthropic'), model('gpt', 'p-openai')],
        script: { opus: [ok('nope'), ok('still nope')], gpt: [ok('{}'), ok('{}')] },
      });
      const err = (await t.router
        .run('interview.question', structured)
        .catch((e: unknown) => e)) as AiUnavailableError;
      expect(err).toBeInstanceOf(AiUnavailableError);
      expect(err.attempts.map((a) => [a.model, a.outcome])).toEqual([
        ['opus', 'INVALID_OUTPUT'],
        ['gpt', 'INVALID_OUTPUT'],
      ]);
    });

    it('treats a truncated reply as invalid output', async () => {
      const t = setup({
        models: [model('opus', 'p-anthropic')],
        script: {
          opus: [
            ok('{"sufficiency":"HI', { finishReason: 'length' }),
            ok('{"sufficiency":"HIGH","followUpNeeded":false}'),
          ],
        },
      });
      await t.router.run('interview.question', structured);
      expect(t.anthropic.calls[1]!.request.messages.at(-1)!.content).toMatch(/cut off/);
    });
  });

  describe('circuit breaker', () => {
    const fragile = () =>
      setup({
        models: [
          model('opus', 'p-anthropic', { params: { ...model('x', 'y').params, retries: 0 } }),
          model('gpt', 'p-openai'),
        ],
        script: {
          opus: Array.from({ length: 5 }, () => fail('PROVIDER_ERROR', '500')),
          gpt: Array.from({ length: 10 }, () => ok('gpt')),
        },
      });

    it('opens after repeated failures and skips the model without calling it', async () => {
      const t = fragile();
      for (let i = 0; i < 5; i++) await t.router.run('interview.question', request);
      expect(t.anthropic.calls).toHaveLength(5);
      const result = await t.router.run('interview.question', request);
      expect(result.attempts[0]).toMatchObject({
        model: 'opus',
        outcome: 'SKIPPED',
        detail: 'circuit_open',
      });
      expect(t.anthropic.calls).toHaveLength(5);
      expect(await t.router.breakerStates(['opus', 'gpt'])).toEqual({
        opus: 'OPEN',
        gpt: 'CLOSED',
      });
    });

    it('does not count bad requests or invalid output against the breaker', async () => {
      const t = setup({
        models: [
          model('opus', 'p-anthropic', { params: { ...model('x', 'y').params, retries: 0 } }),
          model('gpt', 'p-openai'),
        ],
        script: {
          opus: Array.from({ length: 6 }, () => fail('BAD_REQUEST', '400')),
          gpt: Array.from({ length: 6 }, () => ok('gpt')),
        },
      });
      for (let i = 0; i < 6; i++) await t.router.run('interview.question', request);
      expect(t.anthropic.calls).toHaveLength(6);
    });

    it('lets exactly one probe through once half-open', async () => {
      let now = new Date('2026-09-23T10:00:00Z').getTime();
      const t = setup({
        models: [
          model('opus', 'p-anthropic', { params: { ...model('x', 'y').params, retries: 0 } }),
          model('gpt', 'p-openai'),
        ],
        script: {
          opus: [
            ...Array.from({ length: 5 }, () => fail('PROVIDER_ERROR', '500')),
            ok('recovered'),
          ],
          gpt: Array.from({ length: 10 }, () => ok('gpt')),
        },
        deps: { now: () => new Date(now) },
      });
      for (let i = 0; i < 5; i++) await t.router.run('interview.question', request);
      now += 31_000;
      expect((await t.router.run('interview.question', request)).text).toBe('recovered');
      expect(await t.router.breakerStates(['opus'])).toEqual({ opus: 'CLOSED' });
    });
  });

  it('moves on when the model is saturated', async () => {
    const t = setup({
      models: [
        model('opus', 'p-anthropic', { params: { ...model('x', 'y').params, concurrency: 1 } }),
        model('gpt', 'p-openai'),
      ],
      script: { gpt: [ok('gpt')] },
      deps: { policy: { slotWaitMs: 0 } },
    });
    await t.coordination.acquireSlot('opus', 1, 60_000);
    const result = await t.router.run('interview.question', request);
    expect(result.attempts[0]).toMatchObject({ detail: 'saturated' });
  });

  it('releases concurrency slots after every call', async () => {
    const t = setup({
      models: [
        model('opus', 'p-anthropic', { params: { ...model('x', 'y').params, concurrency: 1 } }),
      ],
      script: { opus: [ok('a'), ok('b')] },
      deps: { policy: { slotWaitMs: 0 } },
    });
    await t.router.run('interview.question', request);
    expect((await t.router.run('interview.question', request)).text).toBe('b');
  });

  it('keeps working when Redis coordination is down (fails open)', async () => {
    const broken = {
      acquireSlot: async () => {
        throw new Error('redis down');
      },
      releaseSlot: async () => {
        throw new Error('redis down');
      },
      readBreaker: async () => {
        throw new Error('redis down');
      },
      writeBreaker: async () => {
        throw new Error('redis down');
      },
      tryLock: async () => {
        throw new Error('redis down');
      },
    };
    const t = setup({
      models: [model('opus', 'p-anthropic')],
      script: { opus: [ok('fine')] },
      deps: { coordination: broken },
    });
    expect((await t.router.run('interview.question', request)).text).toBe('fine');
  });

  it('stops without fallback when the caller aborts', async () => {
    const controller = new AbortController();
    const t = setup({
      models: [model('opus', 'p-anthropic'), model('gpt', 'p-openai')],
      script: {
        opus: [
          async () => {
            controller.abort();
            throw new Error('aborted');
          },
        ],
      },
    });
    await expect(
      t.router.run('interview.question', request, { signal: controller.signal }),
    ).rejects.toBeInstanceOf(AiAbortedError);
    expect(t.openai.calls).toHaveLength(0);
    expect(t.usage.map((u) => u.outcome)).toEqual(['ABORTED']);
  });

  it('classifies an adapter that ignores the timeout signal as a timeout', async () => {
    const t = setup({
      models: [
        model('opus', 'p-anthropic', {
          params: { ...model('x', 'y').params, timeoutMs: 1000, retries: 0 },
        }),
        model('gpt', 'p-openai'),
      ],
      script: {
        opus: [
          (input) =>
            new Promise((_resolve, reject) => {
              input.signal.addEventListener('abort', () => reject(new Error('socket closed')));
            }),
        ],
        gpt: [ok('gpt')],
      },
    });
    const result = await t.router.run('interview.question', request);
    expect(result.attempts[0]).toMatchObject({ outcome: 'TIMEOUT' });
  });

  it('caps per-call output tokens at the model maximum', async () => {
    const t = setup({
      models: [model('opus', 'p-anthropic')],
      script: { opus: [ok('a'), ok('b')] },
    });
    await t.router.run('interview.question', { ...request, maxOutputTokens: 50_000 });
    await t.router.run('interview.question', { ...request, maxOutputTokens: 200 });
    expect(t.anthropic.calls.map((c) => c.request.maxOutputTokens)).toEqual([1000, 200]);
  });

  it('meters usage even when a model has no price (cost 0) and never fails on metering errors', async () => {
    const t = setup({
      models: [model('opus', 'p-anthropic', { pricing: [] })],
      script: { opus: [ok('a')] },
      deps: {
        usage: {
          record: async () => {
            throw new Error('mongo down');
          },
        },
      },
    });
    expect((await t.router.run('interview.question', request)).costMicros).toBe(0);
  });

  it('runOnModel targets one model directly', async () => {
    const t = setup({
      models: [model('opus', 'p-anthropic'), model('gpt', 'p-openai')],
      script: { gpt: [ok('pong')] },
    });
    const result = await t.router.runOnModel('gpt', 'admin.test', request);
    expect(result.text).toBe('pong');
    expect(t.usage[0]!.feature).toBe('admin.test');
  });
});

describe('parseJsonOutput', () => {
  it('parses bare and fenced JSON and rejects prose', () => {
    expect(parseJsonOutput(' {"a":1} ')).toEqual({ a: 1 });
    expect(parseJsonOutput('```\n[1]\n```')).toEqual([1]);
    expect(() => parseJsonOutput('Sure! {"a":1}')).toThrow();
  });
});

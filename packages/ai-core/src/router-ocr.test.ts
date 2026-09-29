import { randomBytes } from 'node:crypto';
import type { AiProviderKey } from '@cbi/shared-types';
import { describe, expect, it } from 'vitest';
import { createMemoryCoordination } from './coordination.js';
import { AiProviderError, AiUnavailableError } from './errors.js';
import { createAiRouter, providerSecretContext } from './router.js';
import { createSecretBox } from './secrets.js';
import type {
  AiRuntimeConfig,
  AiUsageRecord,
  OcrCallInput,
  OcrCallResult,
  RuntimeModel,
  RuntimeProvider,
} from './types.js';

const silent = { debug() {}, info() {}, warn() {}, error() {} };
const box = createSecretBox({ currentKeyId: 'k1', keys: { k1: randomBytes(32) } });
const AT = new Date('2026-09-24T10:00:00Z');

const provider = (key: AiProviderKey): RuntimeProvider => ({
  id: `p-${key}`,
  key,
  enabled: true,
  credential: box.encrypt(`key-${key}`, providerSecretContext(key)),
  baseUrl: null,
});

const model = (id: string, key: AiProviderKey, capabilities: RuntimeModel['capabilities']) => ({
  id,
  providerId: `p-${key}`,
  modelId: id,
  enabled: true,
  capabilities,
  params: { temperature: null, maxOutputTokens: 8000, timeoutMs: 5000, retries: 0, concurrency: 5 },
  pricing: [
    {
      unit: 'PER_1M_INPUT_TOKENS' as const,
      pricePerUnitMicros: 2_000_000,
      currency: 'USD' as const,
      effectiveFrom: new Date('2026-01-01'),
    },
  ],
});

type Script = (input: OcrCallInput) => Promise<OcrCallResult>;

function setup(scripts: Record<string, Script>, models?: RuntimeModel[]) {
  const all = models ?? [
    model('sonnet', 'anthropic', ['LLM', 'OCR']),
    model('gemini', 'gemini', ['LLM', 'OCR']),
  ];
  const config: AiRuntimeConfig = {
    providers: new Map([provider('anthropic'), provider('gemini')].map((p) => [p.id, p] as const)),
    models: new Map(all.map((m) => [m.id, m])),
    routes: new Map([
      [
        'ocr.document',
        {
          feature: 'ocr.document',
          active: true,
          chain: all.map((m, i) => ({ modelId: m.id, priority: i })),
        },
      ],
    ]),
    loadedAt: AT,
  };
  const usage: AiUsageRecord[] = [];
  const router = createAiRouter({
    config: { get: async () => config, invalidate() {} },
    adapters: {
      llm: () => undefined,
      ocr: (key) => ({
        providerKey: key,
        recognize: async (input) => {
          const fn = scripts[input.model.modelId];
          if (!fn) throw new Error(`unscripted ${input.model.modelId}`);
          return fn(input);
        },
      }),
    },
    secrets: box,
    coordination: createMemoryCoordination(),
    usage: { record: async (r) => void usage.push(r) },
    logger: silent,
    now: () => AT,
    random: () => 0.5,
    sleep: async () => undefined,
  });
  return { router, usage };
}

const request = {
  document: new Uint8Array([37, 80, 68, 70]),
  mimeType: 'application/pdf' as const,
  pages: 2,
  messages: [{ role: 'user' as const, content: 'Transcribe the attached document.' }],
  maxOutputTokens: 20_000,
};

const read =
  (text: string): Script =>
  async () => ({
    text,
    servedModel: null,
    finishReason: 'stop',
    usage: { inputTokens: 500_000, cachedInputTokens: 0, outputTokens: 900, requests: 1 },
  });

describe('OCR routing', () => {
  it('recognizes with the first model, caps output tokens and meters tokens and pages', async () => {
    const t = setup({
      sonnet: async (input) => {
        expect(input.credentials.apiKey).toBe('key-anthropic');
        expect(input.request.maxOutputTokens).toBe(8000);
        return read('Priya Sharma, Backend Engineer')(input);
      },
    });
    const r = await t.router.recognize(request, { userId: 'u1' });
    expect(r.result.text).toBe('Priya Sharma, Backend Engineer');
    expect(t.usage[0]).toMatchObject({
      feature: 'ocr.document',
      outcome: 'SUCCESS',
      units: { requests: 1, images: 2, inputTokens: 500_000 },
      // 0.5M input tokens at $2/1M.
      costMicros: 1_000_000,
    });
  });

  it('falls back on a provider error or a refusal', async () => {
    const t = setup({
      sonnet: async (input) => ({ ...(await read('')(input)), finishReason: 'refusal' }),
      gemini: read('Fallback text'),
    });
    const r = await t.router.recognize(request);
    expect(r.model.modelId).toBe('gemini');
    expect(r.attempts.map((a) => a.outcome)).toEqual(['REFUSED', 'SUCCESS']);

    const down = setup({
      sonnet: async () => {
        throw new AiProviderError('anthropic', 'BAD_REQUEST', '400', 'too large');
      },
      gemini: async () => {
        throw new AiProviderError('gemini', 'AUTH_ERROR', '401', 'bad key');
      },
    });
    await expect(down.router.recognize(request)).rejects.toBeInstanceOf(AiUnavailableError);
  });

  it('skips models without the OCR capability', async () => {
    const t = setup({ gemini: read('ok') }, [
      model('sonnet', 'anthropic', ['LLM']),
      model('gemini', 'gemini', ['OCR']),
    ]);
    const r = await t.router.recognize(request);
    expect(r.attempts[0]).toMatchObject({ outcome: 'SKIPPED', detail: 'capability_mismatch' });
    expect(r.model.modelId).toBe('gemini');
  });
});

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
  RuntimeModel,
  RuntimeProvider,
  SttAdapter,
  SttCallInput,
  TtsAdapter,
} from './types.js';

const silent = { debug() {}, info() {}, warn() {}, error() {} };
const box = createSecretBox({ currentKeyId: 'k1', keys: { k1: randomBytes(32) } });
const AT = new Date('2026-09-24T10:00:00Z');

const provider = (key: AiProviderKey, credential = true): RuntimeProvider => ({
  id: `p-${key}`,
  key,
  enabled: true,
  credential: credential ? box.encrypt(`key-${key}`, providerSecretContext(key)) : null,
  baseUrl: null,
});

const model = (
  id: string,
  key: AiProviderKey,
  capability: 'STT' | 'TTS',
  unit: 'PER_AUDIO_MINUTE' | 'PER_1M_CHARACTERS',
  micros: number,
): RuntimeModel => ({
  id,
  providerId: `p-${key}`,
  modelId: id,
  enabled: true,
  capabilities: [capability],
  params: { temperature: null, maxOutputTokens: 16, timeoutMs: 5000, retries: 1, concurrency: 5 },
  pricing: [
    { unit, pricePerUnitMicros: micros, currency: 'USD', effectiveFrom: new Date('2026-01-01') },
  ],
});

function setup(opts: {
  providers?: RuntimeProvider[];
  stt?: Record<
    string,
    (input: SttCallInput) => Promise<Awaited<ReturnType<SttAdapter['transcribe']>>>
  >;
  tts?: Record<string, () => Promise<Awaited<ReturnType<TtsAdapter['synthesize']>>>>;
}) {
  const models = [
    model('nova', 'deepgram', 'STT', 'PER_AUDIO_MINUTE', 4_300),
    model('whisper', 'openai', 'STT', 'PER_AUDIO_MINUTE', 6_000),
    model('flash', 'elevenlabs', 'TTS', 'PER_1M_CHARACTERS', 50_000_000),
    model('otts', 'openai', 'TTS', 'PER_1M_CHARACTERS', 15_000_000),
  ];
  const providers = opts.providers ?? [
    provider('deepgram'),
    provider('openai'),
    provider('elevenlabs'),
  ];
  const config: AiRuntimeConfig = {
    providers: new Map(providers.map((p) => [p.id, p])),
    models: new Map(models.map((m) => [m.id, m])),
    routes: new Map([
      [
        'stt.live',
        {
          feature: 'stt.live',
          active: true,
          chain: [
            { modelId: 'nova', priority: 0 },
            { modelId: 'whisper', priority: 1 },
          ],
        },
      ],
      [
        'tts.live',
        {
          feature: 'tts.live',
          active: true,
          chain: [
            { modelId: 'flash', priority: 0 },
            { modelId: 'otts', priority: 1 },
          ],
        },
      ],
    ]),
    loadedAt: AT,
  };
  const sttAdapter = (key: AiProviderKey): SttAdapter => ({
    providerKey: key,
    transcribe: async (input) => {
      const fn = opts.stt?.[input.model.modelId];
      if (!fn) throw new Error(`unscripted ${input.model.modelId}`);
      return fn(input);
    },
  });
  const ttsAdapter = (key: AiProviderKey): TtsAdapter => ({
    providerKey: key,
    synthesize: async (input) => {
      const fn = opts.tts?.[input.model.modelId];
      if (!fn) throw new Error(`unscripted ${input.model.modelId}`);
      return fn();
    },
  });
  const usage: AiUsageRecord[] = [];
  const router = createAiRouter({
    config: { get: async () => config, invalidate() {} },
    adapters: {
      llm: () => undefined,
      stt: (key) => (key === 'deepgram' || key === 'openai' ? sttAdapter(key) : undefined),
      tts: (key) => (key === 'elevenlabs' || key === 'openai' ? ttsAdapter(key) : undefined),
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

const audio = {
  audio: new Uint8Array([1, 2, 3]),
  mimeType: 'audio/webm',
  language: 'en',
  durationSec: 12,
};
const heard =
  (text: string, durationSec: number | null = 30) =>
  async () => ({
    text,
    language: 'en',
    confidence: 0.9,
    durationSec,
    servedModel: null,
  });

describe('speech routing', () => {
  it('transcribes with the first model and meters provider-reported audio seconds', async () => {
    const t = setup({
      stt: {
        nova: async (input) => {
          expect(input.credentials.apiKey).toBe('key-deepgram');
          expect(input.request.mimeType).toBe('audio/webm');
          return heard('I led the migration.')();
        },
      },
    });
    const r = await t.router.transcribe(audio, { sessionId: 's1' });
    expect(r.result.text).toBe('I led the migration.');
    expect(r.model.modelId).toBe('nova');
    expect(t.usage).toHaveLength(1);
    // 30 s at $0.0043/min = 2150 micros.
    expect(t.usage[0]).toMatchObject({
      feature: 'stt.live',
      outcome: 'SUCCESS',
      units: { requests: 1, audioSec: 30 },
      costMicros: 2150,
    });
  });

  it('falls back to the next model and bills the client duration when none is reported', async () => {
    const t = setup({
      stt: {
        nova: async () => {
          throw new AiProviderError('deepgram', 'PROVIDER_ERROR', '503', 'down');
        },
        whisper: heard('Fallback transcript', null),
      },
    });
    const r = await t.router.transcribe(audio);
    expect(r.model.modelId).toBe('whisper');
    expect(r.attempts.map((a) => a.outcome)).toEqual(['PROVIDER_ERROR', 'SUCCESS']);
    // nova was retried once (retries: 1) before moving on.
    expect(t.usage.map((u) => `${u.model}:${u.outcome}`)).toEqual([
      'nova:PROVIDER_ERROR',
      'nova:PROVIDER_ERROR',
      'whisper:SUCCESS',
    ]);
    expect(t.usage[2]!.units.audioSec).toBe(12);
  });

  it('synthesizes speech metered by characters and reports exhaustion', async () => {
    const t = setup({
      tts: {
        flash: async () => ({
          audio: new Uint8Array(10),
          mimeType: 'audio/mpeg',
          servedModel: null,
        }),
      },
    });
    const r = await t.router.synthesize({ text: 'Tell me about yourself.', language: 'en' });
    expect(r.result.mimeType).toBe('audio/mpeg');
    expect(t.usage[0]).toMatchObject({ feature: 'tts.live', units: { characters: 23 } });

    const down = setup({
      tts: {
        flash: async () => {
          throw new AiProviderError('elevenlabs', 'AUTH_ERROR', '401', 'bad key');
        },
        otts: async () => {
          throw new AiProviderError('openai', 'BAD_REQUEST', '400', 'bad');
        },
      },
    });
    await expect(down.router.synthesize({ text: 'Hi', language: null })).rejects.toBeInstanceOf(
      AiUnavailableError,
    );
  });

  it('reports route status without calling providers', async () => {
    expect(await setup({}).router.routeStatus('stt.live')).toBe('AVAILABLE');
    // No Deepgram key: only the fallback can serve.
    const partial = setup({
      providers: [provider('deepgram', false), provider('openai'), provider('elevenlabs', false)],
    });
    expect(await partial.router.routeStatus('stt.live')).toBe('DEGRADED');
    expect(await partial.router.routeStatus('tts.live')).toBe('DEGRADED');
    const none = setup({ providers: [provider('deepgram', false), provider('openai', false)] });
    expect(await none.router.routeStatus('stt.live')).toBe('UNAVAILABLE');
    expect(await none.router.routeStatus('ocr.document')).toBe('UNAVAILABLE');
  });

  it('skips models whose capability does not match the feature', async () => {
    const t = setup({ stt: { nova: heard('x') } });
    await expect(t.router.transcribe(audio, {}, { modelRef: 'flash' })).rejects.toMatchObject({
      attempts: [{ outcome: 'SKIPPED', detail: 'capability_mismatch' }],
    });
  });
});

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
  SpeechStream,
  SpeechStreamEvent,
  SttAdapter,
  SttStreamInput,
  TtsAdapter,
  TtsCallInput,
  TtsStream,
} from './types.js';

const silent = { debug() {}, info() {}, warn() {}, error() {} };
const box = createSecretBox({ currentKeyId: 'k1', keys: { k1: randomBytes(32) } });
const AT = new Date('2026-09-24T10:00:00Z');

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
  params: { temperature: null, maxOutputTokens: 16, timeoutMs: 5000, retries: 0, concurrency: 5 },
  pricing: [
    { unit, pricePerUnitMicros: micros, currency: 'USD', effectiveFrom: new Date('2026-01-01') },
  ],
});

/** A scripted streaming session: records what was sent and closes with a duration. */
function fakeStream(durationSec: number | null = null) {
  const sent: Uint8Array[] = [];
  let finalized = 0;
  const stream: SpeechStream = {
    send: (audio) => void sent.push(audio),
    finalize: () => void (finalized += 1),
    bufferedAmount: () => 0,
    close: async () => ({ durationSec, servedModel: 'nova-3' }),
  };
  return { stream, sent, finalized: () => finalized };
}

function setup(opts: {
  open?: Record<string, (input: SttStreamInput) => Promise<SpeechStream>>;
  tts?: Record<string, (input: TtsCallInput) => Promise<TtsStream>>;
  /** Models whose adapter only synthesizes whole utterances. */
  wholeTts?: Record<string, () => Promise<Uint8Array>>;
}) {
  const models = [
    model('nova', 'deepgram', 'STT', 'PER_AUDIO_MINUTE', 6_000),
    model('whisper', 'openai', 'STT', 'PER_AUDIO_MINUTE', 6_000),
    model('flash', 'elevenlabs', 'TTS', 'PER_1M_CHARACTERS', 50_000_000),
    model('otts', 'openai', 'TTS', 'PER_1M_CHARACTERS', 15_000_000),
  ];
  const providers = (['deepgram', 'openai', 'elevenlabs'] as const).map((key) => ({
    id: `p-${key}`,
    key,
    enabled: true,
    credential: box.encrypt(`key-${key}`, providerSecretContext(key)),
    baseUrl: null,
  }));
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
    transcribe: async () => {
      throw new Error('batch transcription not expected');
    },
    // Only models with a scripted stream can stream (whisper cannot).
    ...(key === 'deepgram'
      ? {
          openStream: async (input: SttStreamInput) => {
            const fn = opts.open?.[input.model.modelId];
            if (!fn) throw new Error(`unscripted ${input.model.modelId}`);
            return fn(input);
          },
        }
      : {}),
  });
  const ttsAdapter = (key: AiProviderKey): TtsAdapter => ({
    providerKey: key,
    synthesize: async (input) => {
      const fn = opts.wholeTts?.[input.model.modelId];
      if (!fn) throw new Error(`unscripted ${input.model.modelId}`);
      return { audio: await fn(), mimeType: 'audio/mpeg', servedModel: null };
    },
    ...(key === 'elevenlabs'
      ? {
          synthesizeStream: async (input: TtsCallInput) => {
            const fn = opts.tts?.[input.model.modelId];
            if (!fn) throw new Error(`unscripted ${input.model.modelId}`);
            return fn(input);
          },
        }
      : {}),
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

const request = {
  encoding: 'linear16' as const,
  sampleRate: 16_000,
  language: 'en',
  utteranceEndMs: 1000,
};

async function* chunks(...parts: (Uint8Array | Error)[]) {
  for (const part of parts) {
    if (part instanceof Error) throw part;
    yield part;
  }
}

describe('streaming transcription', () => {
  it('opens on the first streaming model, relays events and meters audio seconds on close', async () => {
    const fake = fakeStream();
    let emit: ((e: SpeechStreamEvent) => void) | null = null;
    const t = setup({
      open: {
        nova: async (input) => {
          expect(input.credentials.apiKey).toBe('key-deepgram');
          expect(input.request.language).toBe('en');
          emit = input.onEvent;
          return fake.stream;
        },
      },
    });
    const events: SpeechStreamEvent[] = [];
    const stream = await t.router.openTranscriptionStream(request, (e) => events.push(e), {
      sessionId: 's1',
    });
    expect(stream.model.modelId).toBe('nova');
    // 30 s of 16 kHz PCM16.
    for (let i = 0; i < 30; i++) stream.send(new Uint8Array(32_000));
    emit!({ type: 'speech_started', at: 0.2 });
    stream.finalize();
    expect(fake.finalized()).toBe(1);
    const billed = await stream.close();
    // Nothing reaches the caller after close.
    emit!({ type: 'utterance_end', lastWordEnd: 1 });
    expect(events).toEqual([{ type: 'speech_started', at: 0.2 }]);
    expect(billed.audioSec).toBe(30);
    // 30 s at $0.006/min = 3000 micros, recorded once however often close is called.
    await stream.close();
    expect(t.usage).toHaveLength(1);
    expect(t.usage[0]).toMatchObject({
      feature: 'stt.live',
      outcome: 'SUCCESS',
      units: { audioSec: 30, requests: 1 },
      costMicros: 3000,
      context: { sessionId: 's1' },
    });
  });

  it('prefers the duration the provider reports', async () => {
    const fake = fakeStream(12.5);
    const t = setup({ open: { nova: async () => fake.stream } });
    const stream = await t.router.openTranscriptionStream(request, () => undefined);
    stream.send(new Uint8Array(3200));
    expect((await stream.close()).audioSec).toBe(12.5);
  });

  it('skips models that cannot stream and fails when none can connect', async () => {
    const t = setup({
      open: {
        nova: async () => {
          throw new AiProviderError('deepgram', 'PROVIDER_ERROR', '503', 'down');
        },
      },
    });
    const failure = await t.router
      .openTranscriptionStream(request, () => undefined)
      .catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(AiUnavailableError);
    expect((failure as AiUnavailableError).attempts.map((a) => a.detail)).toEqual([
      '503',
      'streaming_unsupported',
    ]);
    expect(t.usage.map((u) => `${u.model}:${u.outcome}`)).toEqual(['nova:PROVIDER_ERROR']);
  });

  it('records a stream that failed mid-way with its billed audio and the error', async () => {
    const fake = fakeStream();
    let emit: ((e: SpeechStreamEvent) => void) | null = null;
    const t = setup({
      open: {
        nova: async (input) => {
          emit = input.onEvent;
          return fake.stream;
        },
      },
    });
    const events: SpeechStreamEvent[] = [];
    const stream = await t.router.openTranscriptionStream(request, (e) => events.push(e));
    stream.send(new Uint8Array(64_000));
    const error = new AiProviderError('deepgram', 'NETWORK_ERROR', 'socket', 'dropped');
    emit!({ type: 'error', error });
    expect(events[0]).toEqual({ type: 'error', error });
    await stream.close();
    expect(t.usage[0]).toMatchObject({
      outcome: 'NETWORK_ERROR',
      errorCode: 'socket',
      units: { audioSec: 2 },
    });
  });
});

describe('streaming synthesis', () => {
  it('yields chunks as they arrive and meters characters once', async () => {
    const t = setup({
      tts: {
        flash: async (input) => {
          expect(input.request.text).toBe('Tell me about a project.');
          return {
            mimeType: 'audio/mpeg',
            chunks: chunks(new Uint8Array([1]), new Uint8Array([2, 3])),
          };
        },
      },
    });
    const gen = t.router.synthesizeStream({ text: 'Tell me about a project.', language: 'en' });
    const received: number[][] = [];
    let step = await gen.next();
    while (!step.done) {
      received.push([...step.value.audio]);
      expect(step.value.mimeType).toBe('audio/mpeg');
      step = await gen.next();
    }
    expect(received).toEqual([[1], [2, 3]]);
    expect(step.value.model.modelId).toBe('flash');
    expect(t.usage).toHaveLength(1);
    expect(t.usage[0]).toMatchObject({ feature: 'tts.live', units: { characters: 24 } });
  });

  it('falls back before the first chunk, including to a model that only synthesizes whole utterances', async () => {
    const t = setup({
      tts: {
        flash: async () => {
          throw new AiProviderError('elevenlabs', 'RATE_LIMITED', '429', 'slow down');
        },
      },
      wholeTts: { otts: async () => new Uint8Array([9, 9]) },
    });
    const received: Uint8Array[] = [];
    for await (const chunk of t.router.synthesizeStream({ text: 'Hello there.', language: null })) {
      received.push(chunk.audio);
    }
    expect(received).toEqual([new Uint8Array([9, 9])]);
    expect(t.usage.map((u) => `${u.model}:${u.outcome}`)).toEqual([
      'flash:RATE_LIMITED',
      'otts:SUCCESS',
    ]);
  });

  it('cannot take audio back: a failure after the first chunk ends the stream', async () => {
    const t = setup({
      tts: {
        flash: async () => ({
          mimeType: 'audio/mpeg',
          chunks: chunks(
            new Uint8Array([1]),
            new AiProviderError('elevenlabs', 'NETWORK_ERROR', 'reset', 'reset'),
          ),
        }),
      },
      wholeTts: { otts: async () => new Uint8Array([9]) },
    });
    const received: Uint8Array[] = [];
    const failure = await (async () => {
      for await (const chunk of t.router.synthesizeStream({
        text: 'Hello there.',
        language: null,
      })) {
        received.push(chunk.audio);
      }
    })().catch((e: unknown) => e);
    expect(received).toHaveLength(1);
    expect(failure).toBeInstanceOf(AiUnavailableError);
    expect(t.usage.map((u) => u.model)).toEqual(['flash']);
  });

  it('stopping the iteration aborts the provider call', async () => {
    let aborted = false;
    const t = setup({
      tts: {
        flash: async (input) => {
          input.signal.addEventListener('abort', () => (aborted = true));
          return {
            mimeType: 'audio/mpeg',
            chunks: (async function* () {
              yield new Uint8Array([1]);
              await new Promise((resolve) => input.signal.addEventListener('abort', resolve));
              throw new Error('aborted');
            })(),
          };
        },
      },
    });
    for await (const chunk of t.router.synthesizeStream({
      text: 'Barge in here.',
      language: null,
    })) {
      expect(chunk.audio).toEqual(new Uint8Array([1]));
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(aborted).toBe(true);
  });
});

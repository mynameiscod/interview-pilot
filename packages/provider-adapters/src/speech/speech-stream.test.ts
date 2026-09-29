import { AiProviderError, type ModelTarget, type SpeechStreamEvent } from '@cbi/ai-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDeepgramSttAdapter } from './deepgram.js';
import {
  createDeepgramLiveAdapter,
  deepgramLiveLanguage,
  type WebSocketLike,
} from './deepgram-live.js';
import { createElevenLabsTtsAdapter } from './elevenlabs.js';
import {
  createMockSttAdapter,
  createMockTtsAdapter,
  MOCK_SPEECH_FAIL,
  MOCK_SPEECH_PREFIX,
  mockSpeechWav,
} from './mock.js';
import { createOpenAiTtsAdapter } from './openai.js';

const target = (modelId: string): ModelTarget => ({
  providerKey: 'deepgram',
  modelId,
  params: { temperature: null, maxOutputTokens: 16, timeoutMs: 5000, retries: 0, concurrency: 5 },
});
const credentials = { apiKey: 'secret-key' };
const liveRequest = (language: string | null = 'en') => ({
  encoding: 'linear16' as const,
  sampleRate: 16_000,
  language,
  utteranceEndMs: 1000,
});

/** A scripted WebSocket: the test opens it, feeds messages and closes it. */
class FakeSocket implements WebSocketLike {
  readyState = 0;
  bufferedAmount = 0;
  binaryType = 'blob';
  sent: (string | Uint8Array)[] = [];
  closedWith: number | null = null;
  private listeners = new Map<string, ((event: never) => void)[]>();
  constructor(
    readonly url: string,
    readonly protocols: string[],
  ) {}
  addEventListener(type: string, listener: (event: never) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  fire(type: string, event: object = {}) {
    for (const listener of this.listeners.get(type) ?? []) listener(event as never);
  }
  open() {
    this.readyState = 1;
    this.fire('open');
  }
  message(body: object) {
    this.fire('message', { data: JSON.stringify(body) });
  }
  send(data: string | Uint8Array) {
    this.sent.push(data);
    if (data === JSON.stringify({ type: 'CloseStream' })) {
      // Deepgram answers CloseStream with the metadata, then closes.
      queueMicrotask(() => {
        this.message({ type: 'Metadata', duration: 4.2, model_info: { a: { name: 'nova-3' } } });
        this.drop(1000);
      });
    }
  }
  close(code?: number) {
    this.closedWith = code ?? 1000;
    this.drop(code ?? 1000);
  }
  drop(code: number) {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.fire('close', { code });
  }
}

function deepgram() {
  const sockets: FakeSocket[] = [];
  const adapter = createDeepgramLiveAdapter({
    webSocket: (url, protocols) => {
      const s = new FakeSocket(url, protocols);
      sockets.push(s);
      return s;
    },
    keepAliveMs: 1000,
  });
  return { adapter, sockets };
}

afterEach(() => vi.useRealTimers());

describe('Deepgram live transcription', () => {
  it('connects with the streaming parameters and the key as a subprotocol', async () => {
    const { adapter, sockets } = deepgram();
    const opening = adapter.openStream({
      model: target('nova-3'),
      request: liveRequest('en'),
      credentials,
      signal: new AbortController().signal,
      onEvent: () => undefined,
    });
    const socket = sockets[0]!;
    const url = new URL(socket.url);
    expect(url.origin).toBe('wss://api.deepgram.com');
    expect(url.pathname).toBe('/v1/listen');
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      model: 'nova-3',
      encoding: 'linear16',
      sample_rate: '16000',
      language: 'en',
      interim_results: 'true',
      vad_events: 'true',
      utterance_end_ms: '1000',
      endpointing: '300',
    });
    expect(socket.protocols).toEqual(['token', 'secret-key']);
    // The key is never in the URL.
    expect(socket.url).not.toContain('secret-key');
    socket.open();
    await expect(opening).resolves.toBeDefined();
  });

  it('uses code-switching for Hindi and keeps Telugu monolingual', () => {
    expect(deepgramLiveLanguage('hi')).toEqual({ language: 'multi', endpointingMs: 100 });
    expect(deepgramLiveLanguage(null)).toEqual({ language: 'multi', endpointingMs: 100 });
    expect(deepgramLiveLanguage('te')).toEqual({ language: 'te', endpointingMs: 300 });
  });

  it('relays results, speech starts and utterance ends, then closes with the billed duration', async () => {
    const { adapter, sockets } = deepgram();
    const events: SpeechStreamEvent[] = [];
    const opening = adapter.openStream({
      model: target('nova-3'),
      request: liveRequest(),
      credentials,
      signal: new AbortController().signal,
      onEvent: (e) => events.push(e),
    });
    const socket = sockets[0]!;
    socket.open();
    const stream = await opening;
    stream.send(new Uint8Array(3200));
    expect(socket.sent[0]).toBeInstanceOf(Uint8Array);
    socket.message({ type: 'SpeechStarted', timestamp: 0.4 });
    socket.message({
      type: 'Results',
      is_final: true,
      speech_final: true,
      start: 0.4,
      duration: 1.1,
      channel: { alternatives: [{ transcript: ' I led the migration ', confidence: 0.91 }] },
    });
    socket.message({ type: 'UtteranceEnd', last_word_end: 1.5 });
    stream.finalize();
    expect(socket.sent).toContain(JSON.stringify({ type: 'Finalize' }));
    const summary = await stream.close();
    expect(summary).toEqual({ durationSec: 4.2, servedModel: 'nova-3' });
    expect(events).toEqual([
      { type: 'speech_started', at: 0.4 },
      {
        type: 'transcript',
        text: 'I led the migration',
        isFinal: true,
        speechFinal: true,
        confidence: 0.91,
        start: 0.4,
        duration: 1.1,
      },
      { type: 'utterance_end', lastWordEnd: 1.5 },
      { type: 'closed' },
    ]);
  });

  it('keeps a quiet stream alive', async () => {
    vi.useFakeTimers();
    const { adapter, sockets } = deepgram();
    const opening = adapter.openStream({
      model: target('nova-3'),
      request: liveRequest(),
      credentials,
      signal: new AbortController().signal,
      onEvent: () => undefined,
    });
    sockets[0]!.open();
    await opening;
    await vi.advanceTimersByTimeAsync(2100);
    expect(
      sockets[0]!.sent.filter((m) => m === JSON.stringify({ type: 'KeepAlive' })),
    ).not.toHaveLength(0);
  });

  it('rejects a refused connection so the router can fall back', async () => {
    const { adapter, sockets } = deepgram();
    const opening = adapter.openStream({
      model: target('nova-3'),
      request: liveRequest(),
      credentials,
      signal: new AbortController().signal,
      onEvent: () => undefined,
    });
    sockets[0]!.fire('error');
    await expect(opening).rejects.toBeInstanceOf(AiProviderError);
  });

  it('reports a stream the provider drops mid-answer as an error', async () => {
    const { adapter, sockets } = deepgram();
    const events: SpeechStreamEvent[] = [];
    const opening = adapter.openStream({
      model: target('nova-3'),
      request: liveRequest(),
      credentials,
      signal: new AbortController().signal,
      onEvent: (e) => events.push(e),
    });
    sockets[0]!.open();
    await opening;
    sockets[0]!.drop(1011);
    expect(events[0]).toMatchObject({ type: 'error' });
    expect((events[0] as unknown as { error: AiProviderError }).error.code).toBe('ws_1011');
    expect(events[1]).toEqual({ type: 'closed' });
  });

  it('is what the Deepgram STT adapter streams with', () => {
    expect(typeof createDeepgramSttAdapter().openStream).toBe('function');
  });
});

const chunkedResponse = (...parts: number[][]) =>
  new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const part of parts) controller.enqueue(new Uint8Array(part));
        controller.close();
      },
    }),
    { status: 200, headers: { 'Content-Type': 'audio/mpeg' } },
  );

async function collect(chunks: AsyncIterable<Uint8Array>) {
  const out: number[][] = [];
  for await (const c of chunks) out.push([...c]);
  return out;
}

describe('streaming synthesis', () => {
  const tts = { text: 'Tell me about a project.', language: 'hi' };

  it('ElevenLabs uses the /stream endpoint and yields MP3 chunks', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(chunkedResponse([1, 2], [3]));
    const stream = await createElevenLabsTtsAdapter({ fetchImpl }).synthesizeStream!({
      model: { ...target('eleven_flash_v2_5'), providerKey: 'elevenlabs' },
      request: tts,
      credentials,
      signal: new AbortController().signal,
    });
    expect(stream.mimeType).toBe('audio/mpeg');
    expect(await collect(stream.chunks)).toEqual([[1, 2], [3]]);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(String(url)).toMatch(/\/v1\/text-to-speech\/[^/]+\/stream\?output_format=mp3_44100_64$/);
    expect(JSON.parse(String(init.body))).toMatchObject({ language_code: 'hi' });
  });

  it('OpenAI asks for a raw audio stream', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(chunkedResponse([7]));
    const stream = await createOpenAiTtsAdapter({ fetchImpl }).synthesizeStream!({
      model: { ...target('gpt-4o-mini-tts'), providerKey: 'openai' },
      request: tts,
      credentials,
      signal: new AbortController().signal,
    });
    expect(await collect(stream.chunks)).toEqual([[7]]);
    expect(JSON.parse(String(fetchImpl.mock.calls[0]![1].body))).toMatchObject({
      stream_format: 'audio',
      response_format: 'mp3',
    });
  });

  it('maps an HTTP failure before any audio to a provider error', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('no', { status: 429 }));
    await expect(
      createOpenAiTtsAdapter({ fetchImpl }).synthesizeStream!({
        model: { ...target('gpt-4o-mini-tts'), providerKey: 'openai' },
        request: tts,
        credentials,
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ outcome: 'RATE_LIMITED' });
  });

  it('the mock streams its WAV in chunks', async () => {
    const stream = await createMockTtsAdapter().synthesizeStream!({
      model: { ...target('mock-tts'), providerKey: 'mock' },
      request: tts,
      credentials,
      signal: new AbortController().signal,
    });
    const parts = await collect(stream.chunks);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.flat()).toEqual([...mockSpeechWav(tts.text)]);
  });
});

/** 100 ms of 16 kHz PCM16: a loud tone or silence. */
function pcm(loud: boolean) {
  const view = new DataView(new ArrayBuffer(3200));
  for (let i = 0; i < 1600; i++) {
    view.setInt16(i * 2, loud ? Math.round(Math.sin(i / 3) * 8000) : 0, true);
  }
  return new Uint8Array(view.buffer);
}

describe('mock streaming STT', () => {
  async function open() {
    const events: SpeechStreamEvent[] = [];
    const stream = await createMockSttAdapter().openStream!({
      model: { ...target('mock-stt'), providerKey: 'mock' },
      request: liveRequest(),
      credentials,
      signal: new AbortController().signal,
      onEvent: (e) => events.push(e),
    });
    return { stream, events };
  }

  it('hears scripted phrases and ends the utterance after a quiet second', async () => {
    const { stream, events } = await open();
    stream.send(new TextEncoder().encode(`${MOCK_SPEECH_PREFIX}I led the payments migration`));
    for (let i = 0; i < 9; i++) stream.send(pcm(false));
    expect(events.some((e) => e.type === 'utterance_end')).toBe(false);
    stream.send(pcm(false));
    const types = events.map((e) => e.type);
    expect(types).toEqual(['speech_started', 'transcript', 'transcript', 'utterance_end']);
    expect(events[2]).toMatchObject({ text: 'I led the payments migration', isFinal: true });
    expect(await stream.close()).toEqual({ durationSec: 2, servedModel: 'mock-stt' });
  });

  it('transcribes loud real audio to a placeholder once the speaker pauses', async () => {
    const { stream, events } = await open();
    for (let i = 0; i < 15; i++) stream.send(pcm(true));
    for (let i = 0; i < 3; i++) stream.send(pcm(false));
    const finals = events.filter((e) => e.type === 'transcript' && e.isFinal);
    expect(finals).toHaveLength(1);
    expect(finals[0]).toMatchObject({ text: '[mock] Spoken answer of about 2 seconds.' });
  });

  it('flushes a phrase in progress on finalize, and simulates an outage', async () => {
    const { stream, events } = await open();
    stream.send(pcm(true));
    stream.finalize();
    expect(events.at(-1)).toMatchObject({ isFinal: true, speechFinal: false });
    stream.send(new TextEncoder().encode(MOCK_SPEECH_FAIL));
    expect(events.at(-1)).toMatchObject({ type: 'error' });
  });
});

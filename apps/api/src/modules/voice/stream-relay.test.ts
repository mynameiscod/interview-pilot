import {
  AiUnavailableError,
  type AiTranscriptionStream,
  type SpeechStreamEvent,
  type SttStreamRequest,
} from '@cbi/ai-core';
import { MOCK_SPEECH_FAIL, MOCK_SPEECH_PREFIX, openMockSpeechStream } from '@cbi/provider-adapters';
import {
  RtEvent,
  type RtAck,
  type VoiceStreamStartPayload,
  type VoiceTurnEndEvent,
} from '@cbi/shared-types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LiveError } from '../live/live.service.js';
import { createVoiceStreamRelay, type PartialStore, type RelaySocket } from './stream-relay.js';
import type { StoredTranscript } from './voice.service.js';

const silentLogger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
} as unknown as Parameters<typeof createVoiceStreamRelay>[0]['logger'];

/** A socket whose handlers the test calls directly; everything emitted is recorded. */
function fakeSocket() {
  const handlers = new Map<string, (raw: unknown, ack?: (r: RtAck) => void) => unknown>();
  const emitted: { event: string; payload: unknown }[] = [];
  const socket: RelaySocket = {
    on: (event, listener) =>
      void handlers.set(
        event,
        listener as unknown as (raw: unknown, ack?: (r: RtAck) => void) => unknown,
      ),
    emit: (event, payload) => void emitted.push({ event, payload }),
  };
  const call = (event: string, payload: unknown) =>
    new Promise<RtAck>((resolve) => void handlers.get(event)!(payload, resolve));
  const events = <T>(event: string) =>
    emitted.filter((e) => e.event === event).map((e) => e.payload as T);
  return { socket, call, events, emitted };
}

/** The router's streaming transcription served by the mock provider (audio clock, no network). */
function mockRouter(opts: { unavailable?: boolean } = {}) {
  const closed: number[] = [];
  let events: ((e: SpeechStreamEvent) => void) | null = null;
  const router = {
    openTranscriptionStream: vi.fn(
      async (
        request: SttStreamRequest,
        onEvent: (e: SpeechStreamEvent) => void,
      ): Promise<AiTranscriptionStream> => {
        if (opts.unavailable) throw new AiUnavailableError('stt.live', []);
        events = onEvent;
        const stream = openMockSpeechStream({
          model: { providerKey: 'mock', modelId: 'mock-stt', params: {} as never },
          request,
          credentials: { apiKey: '' },
          signal: new AbortController().signal,
          onEvent,
        });
        return {
          send: (a) => stream.send(a),
          finalize: () => stream.finalize(),
          bufferedAmount: () => 0,
          close: async () => {
            const r = await stream.close();
            closed.push(r.durationSec ?? 0);
            return { audioSec: r.durationSec ?? 0, costMicros: 0 };
          },
          model: { id: 'm1', providerKey: 'mock', modelId: 'mock-stt' },
          attempts: [],
        };
      },
    ),
  };
  return { router, closed, providerEvent: (e: SpeechStreamEvent) => events?.(e) };
}

function memoryPartials(): PartialStore & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    get: async (u, q) => data.get(`${u}:${q}`) ?? '',
    put: async (u, q, text) => void data.set(`${u}:${q}`, text),
    clear: async (u, q) => void data.delete(`${u}:${q}`),
  };
}

const SESSION = 'session-1';
const QUESTION = 'question-1';
const start = (resume = false) => ({
  sessionId: SESSION,
  questionId: QUESTION,
  encoding: 'linear16',
  sampleRate: 16_000,
  resume,
});
const said = (text: string) => new TextEncoder().encode(`${MOCK_SPEECH_PREFIX}${text}`);
const quiet = () => new Uint8Array(3200);

function setup(
  opts: { authorize?: (p: VoiceStreamStartPayload) => void; unavailable?: boolean } = {},
) {
  const socket = fakeSocket();
  const provider = mockRouter({ unavailable: opts.unavailable });
  const transcripts: StoredTranscript[] = [];
  const partials = memoryPartials();
  const speechEnded = vi.fn(async () => undefined);
  let clock = 1_000_000;
  const relay = createVoiceStreamRelay({
    router: provider.router,
    authorize: async (_userId, payload) => {
      opts.authorize?.(payload);
      return { language: 'en' };
    },
    transcripts: { put: async (t) => void transcripts.push(t) },
    partials,
    latency: { speechEnded },
    logger: silentLogger,
    finalizeWaitMs: 100,
    now: () => clock,
  });
  const attached = relay.attach(socket.socket, { userId: 'user-1', sessionId: () => SESSION });
  const open = async (resume = false) => {
    const ack = await socket.call(RtEvent.VOICE_STREAM_START, start(resume));
    if (!ack.ok) throw new Error(`start refused: ${ack.code}`);
    return ack.stream!;
  };
  let seq = 0;
  const frame = (streamId: string, audio: Uint8Array) =>
    socket.call(RtEvent.VOICE_STREAM_AUDIO, { streamId, seq: seq++, audio });
  return {
    ...socket,
    ...provider,
    attached,
    transcripts,
    partials,
    speechEnded,
    open,
    frame,
    tick: (ms: number) => (clock += ms),
  };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('voice stream relay', () => {
  it('relays the live transcript and ends a complete answer after the quiet spell', async () => {
    const t = setup();
    const { streamId, resumedText, graceMs } = await t.open();
    expect(resumedText).toBe('');
    expect(graceMs).toBe(2000);
    expect(t.router.openTranscriptionStream.mock.calls[0]![0]).toMatchObject({
      encoding: 'linear16',
      sampleRate: 16_000,
      language: 'en',
    });
    expect(await t.frame(streamId, said('I led the payments migration'))).toEqual({ ok: true });
    for (let i = 0; i < 10; i++) await t.frame(streamId, quiet());
    const transcripts = t.events<{ text: string; interim: string }>(RtEvent.VOICE_TRANSCRIPT);
    expect(transcripts.at(-1)).toMatchObject({ text: 'I led the payments migration', interim: '' });
    expect(t.events(RtEvent.VOICE_TURN_END)).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(700);
    const [end] = t.events<VoiceTurnEndEvent>(RtEvent.VOICE_TURN_END);
    expect(end).toMatchObject({
      streamId,
      questionId: QUESTION,
      text: 'I led the payments migration',
      reason: 'silence',
      graceMs: 2000,
      lowConfidence: false,
    });
    // The transcript is stored like a push-to-talk one: the answer path reads it from here.
    expect(t.transcripts[0]).toMatchObject({
      transcriptId: end!.transcriptId,
      userId: 'user-1',
      sessionId: SESSION,
      questionId: QUESTION,
      text: 'I led the payments migration',
      model: 'mock-stt',
    });
    expect(t.speechEnded).toHaveBeenCalledOnce();
  });

  it('reopens the turn when the candidate keeps talking, then ends it with everything', async () => {
    const t = setup();
    const { streamId } = await t.open();
    await t.frame(streamId, said('I led the payments migration'));
    for (let i = 0; i < 10; i++) await t.frame(streamId, quiet());
    await vi.advanceTimersByTimeAsync(700);
    expect(t.events(RtEvent.VOICE_TURN_END)).toHaveLength(1);
    t.tick(1000);
    await t.frame(streamId, said('and cut costs by a third'));
    expect(t.events(RtEvent.VOICE_RESUMED)).toEqual([{ streamId }]);
    for (let i = 0; i < 10; i++) await t.frame(streamId, quiet());
    await vi.advanceTimersByTimeAsync(700);
    const ends = t.events<VoiceTurnEndEvent>(RtEvent.VOICE_TURN_END);
    expect(ends).toHaveLength(2);
    expect(ends[1]!.text).toBe('I led the payments migration and cut costs by a third');
    expect(ends[1]!.transcriptId).not.toBe(ends[0]!.transcriptId);
  });

  it('"send now" flushes the provider and ends the turn at once, with no grace', async () => {
    const t = setup();
    const { streamId } = await t.open();
    // Loud real audio still being spoken: only an interim result so far.
    const loud = new Uint8Array(3200);
    const view = new DataView(loud.buffer);
    for (let i = 0; i < 1600; i++) view.setInt16(i * 2, Math.round(Math.sin(i / 3) * 8000), true);
    await t.frame(streamId, loud);
    expect(await t.call(RtEvent.VOICE_STREAM_STOP, { streamId, action: 'send' })).toEqual({
      ok: true,
    });
    const [end] = t.events<VoiceTurnEndEvent>(RtEvent.VOICE_TURN_END);
    expect(end).toMatchObject({ reason: 'requested', graceMs: 0 });
    expect(end!.text).toMatch(/^\[mock\] Spoken answer of about 1 second\.$/);
  });

  it('closes the provider stream once the answer is submitted and forgets the partial', async () => {
    const t = setup();
    const { streamId } = await t.open();
    await t.frame(streamId, said('Short answer here'));
    await t.call(RtEvent.VOICE_STREAM_STOP, { streamId, action: 'close' });
    expect(t.closed).toHaveLength(1);
    expect(t.events(RtEvent.VOICE_STREAM_CLOSED)).toEqual([{ streamId }]);
    expect(t.partials.data.size).toBe(0);
    // Frames after the close are refused.
    expect(await t.frame(streamId, quiet())).toMatchObject({ ok: false, code: 'INVALID_STATE' });
  });

  it('keeps the partial answer when the socket drops, and resumes it on the next stream', async () => {
    const t = setup();
    const first = await t.open();
    await t.frame(first.streamId, said('First I profiled the service'));
    await t.attached.disconnected();
    expect(t.closed).toHaveLength(1);
    expect(t.partials.data.get(`user-1:${QUESTION}`)).toBe('First I profiled the service');

    const again = await t.open(true);
    expect(again.resumedText).toBe('First I profiled the service');
    await t.frame(again.streamId, said('then fixed the N plus one queries'));
    expect(t.events<{ text: string }>(RtEvent.VOICE_TRANSCRIPT).at(-1)!.text).toBe(
      'First I profiled the service then fixed the N plus one queries',
    );
    // A fresh (not resumed) start discards the old partial.
    await t.open(false);
    expect(t.partials.data.size).toBe(0);
  });

  it('refuses audio that is too fast or oversized', async () => {
    const t = setup();
    const { streamId } = await t.open();
    expect(await t.frame(streamId, new Uint8Array(20_000))).toMatchObject({
      ok: false,
      code: 'VALIDATION_FAILED',
    });
    for (let i = 0; i < 15; i++) await t.frame(streamId, quiet());
    // 16 frames of 3.2 KB within one second is over 1.5× real time.
    expect(await t.frame(streamId, quiet())).toMatchObject({
      ok: false,
      code: 'VALIDATION_FAILED',
    });
    expect(t.events(RtEvent.VOICE_STREAM_ERROR)).toEqual([{ streamId, code: 'RATE' }]);
    expect(t.closed).toHaveLength(1);
  });

  it('allows real-time audio over a long answer', async () => {
    const t = setup();
    const { streamId } = await t.open();
    for (let second = 0; second < 5; second++) {
      for (let i = 0; i < 10; i++) expect(await t.frame(streamId, quiet())).toEqual({ ok: true });
      t.tick(1000);
    }
    expect(t.events(RtEvent.VOICE_STREAM_ERROR)).toHaveLength(0);
  });

  it('falls back to push-to-talk when the provider fails mid-answer', async () => {
    const t = setup();
    const { streamId } = await t.open();
    await t.frame(streamId, said('I was saying'));
    await t.frame(streamId, new TextEncoder().encode(MOCK_SPEECH_FAIL));
    expect(t.events(RtEvent.VOICE_STREAM_ERROR)).toEqual([
      { streamId, code: 'SPEECH_UNAVAILABLE' },
    ]);
    await vi.advanceTimersByTimeAsync(0);
    expect(t.closed).toHaveLength(1);
    expect(t.partials.data.get(`user-1:${QUESTION}`)).toBe('I was saying');
  });

  it('refuses to start when realtime voice is not possible', async () => {
    const off = setup({
      authorize: () => {
        throw new LiveError('UNSUPPORTED', 'Live transcription does not support this language.');
      },
    });
    expect(await off.call(RtEvent.VOICE_STREAM_START, start())).toMatchObject({
      ok: false,
      code: 'UNSUPPORTED',
    });
    const down = setup({ unavailable: true });
    expect(await down.call(RtEvent.VOICE_STREAM_START, start())).toMatchObject({
      ok: false,
      code: 'SPEECH_UNAVAILABLE',
    });
    const wrongRoom = setup();
    expect(
      await wrongRoom.call(RtEvent.VOICE_STREAM_START, { ...start(), sessionId: 'other' }),
    ).toMatchObject({ ok: false, code: 'INVALID_STATE' });
    expect(
      await wrongRoom.call(RtEvent.VOICE_STREAM_START, { ...start(), sampleRate: 44_100 }),
    ).toMatchObject({ ok: false, code: 'VALIDATION_FAILED' });
  });
});

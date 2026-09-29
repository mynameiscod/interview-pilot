import { RtEvent, type RtAck } from '@cbi/shared-types';
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FrameListener } from '../voice/pcm-capture';
import {
  initialVoiceTurn,
  useRealtimeVoice,
  voiceTurnReducer,
  type RealtimeVoiceOptions,
} from './realtime-voice';
import { VOICE_JOINED, VOICE_LEFT, type SendResult, type VoiceChannel } from './useInterviewRoom';

const STREAM = '6f1c2f7e-2b0a-4f47-8f0c-3c1d2e4f5a6b';
const TRANSCRIPT = '0b8f6a4e-3b3c-4b8e-9a51-2f4a5c3c1d10';

/** The room's socket as realtime voice sees it: requests are recorded, events are pushed by the test. */
function fakeChannel() {
  const listeners = new Map<string, Set<(payload: never) => void>>();
  const requests: { event: string; payload: Record<string, unknown> }[] = [];
  let ready = true;
  let startAck: RtAck = {
    ok: true,
    stream: { streamId: STREAM, resumedText: '', graceMs: 2000 },
  };
  const channel: VoiceChannel = {
    ready: () => ready,
    request: vi.fn(async (event: string, payload: unknown) => {
      requests.push({ event, payload: payload as Record<string, unknown> });
      if (event === RtEvent.VOICE_STREAM_START) return startAck;
      return { ok: true } as RtAck;
    }),
    on: (event, listener) => {
      const set = listeners.get(event) ?? new Set();
      set.add(listener as (payload: never) => void);
      listeners.set(event, set);
      return () => void set.delete(listener as (payload: never) => void);
    },
  };
  return {
    channel,
    requests,
    of: (event: string) => requests.filter((r) => r.event === event),
    push: (event: string, payload?: unknown) =>
      act(() => {
        for (const l of listeners.get(event) ?? []) l(payload as never);
      }),
    setReady: (v: boolean) => (ready = v),
    setStartAck: (ack: RtAck) => (startAck = ack),
  };
}

/** A microphone and AudioWorklet stand-in: the test feeds frames with a level. */
function fakeCapture() {
  let onFrame: FrameListener | null = null;
  const closed = vi.fn();
  return {
    openMic: vi.fn(async () => ({ getTracks: () => [] }) as unknown as MediaStream),
    capture: vi.fn(async (_stream: MediaStream, listener: FrameListener) => {
      onFrame = listener;
      return { close: closed };
    }),
    frame: (level: number, n = 1) =>
      act(() => {
        for (let i = 0; i < n; i++) onFrame?.(new Uint8Array(3200).fill(i), level);
      }),
    closed,
  };
}

function setup(overrides: Partial<RealtimeVoiceOptions> = {}) {
  const ch = fakeChannel();
  const mic = fakeCapture();
  const sendAnswer = vi.fn(async (): Promise<SendResult> => 'sent');
  const onBargeIn = vi.fn();
  const initial: RealtimeVoiceOptions = {
    sessionId: 'session-1',
    channel: ch.channel,
    questionId: 'q1',
    saved: true,
    enabled: true,
    interviewerSpeaking: false,
    reviewBeforeSending: false,
    sendAnswer,
    onBargeIn,
    openMic: mic.openMic,
    capture: mic.capture,
    ...overrides,
  };
  const hook = renderHook((props: RealtimeVoiceOptions) => useRealtimeVoice(props), {
    initialProps: initial,
  });
  const rerender = (patch: Partial<RealtimeVoiceOptions>) =>
    hook.rerender({ ...initial, ...patch });
  const settle = () => act(() => vi.advanceTimersByTimeAsync(0));
  const turnEnd = (patch: Record<string, unknown> = {}) =>
    ch.push(RtEvent.VOICE_TURN_END, {
      streamId: STREAM,
      questionId: 'q1',
      transcriptId: TRANSCRIPT,
      text: 'I led the payments migration',
      reason: 'silence',
      graceMs: 2000,
      lowConfidence: false,
      ...patch,
    });
  return { ...ch, mic, sendAnswer, onBargeIn, hook, rerender, settle, turnEnd };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('realtime voice turn', () => {
  it('streams the answer, counts down the grace window and submits the transcript once', async () => {
    const t = setup();
    await t.settle();
    expect(t.hook.result.current.phase).toBe('listening');
    expect(t.of(RtEvent.VOICE_STREAM_START)[0]!.payload).toMatchObject({
      sessionId: 'session-1',
      questionId: 'q1',
      encoding: 'linear16',
      sampleRate: 16_000,
      resume: false,
    });
    await t.mic.frame(0.1, 3);
    await t.settle();
    expect(t.of(RtEvent.VOICE_STREAM_AUDIO)).toHaveLength(3);
    expect(t.of(RtEvent.VOICE_STREAM_AUDIO)[2]!.payload).toMatchObject({
      streamId: STREAM,
      seq: 2,
    });

    await t.push(RtEvent.VOICE_TRANSCRIPT, {
      streamId: STREAM,
      questionId: 'q1',
      text: 'I led the',
      interim: 'payments',
    });
    expect(t.hook.result.current).toMatchObject({ text: 'I led the', interim: 'payments' });

    await t.turnEnd();
    expect(t.hook.result.current.phase).toBe('grace');
    expect(t.hook.result.current.graceLeftMs).toBe(2000);
    await act(() => vi.advanceTimersByTimeAsync(1999));
    expect(t.sendAnswer).not.toHaveBeenCalled();
    await act(() => vi.advanceTimersByTimeAsync(1));
    await t.settle();
    expect(t.sendAnswer).toHaveBeenCalledOnce();
    expect(t.sendAnswer).toHaveBeenCalledWith('q1', 'I led the payments migration', {
      voiceTranscriptId: TRANSCRIPT,
      voiceEdited: undefined,
      clientMsgId: `rt-${TRANSCRIPT}`,
    });
    expect(t.hook.result.current.phase).toBe('sent');
    // The stream is released once the answer is in.
    expect(t.of(RtEvent.VOICE_STREAM_STOP).at(-1)!.payload).toEqual({
      streamId: STREAM,
      action: 'close',
    });
    // Tapping "send" again changes nothing.
    act(() => t.hook.result.current.sendNow());
    await t.settle();
    expect(t.sendAnswer).toHaveBeenCalledOnce();
  });

  it('keeps listening when the candidate carries on talking during the grace window', async () => {
    const t = setup();
    await t.settle();
    await t.turnEnd();
    await act(() => vi.advanceTimersByTimeAsync(1200));
    // The provider hears speech: the countdown starts again…
    await t.push(RtEvent.VOICE_SPEECH, { streamId: STREAM });
    await act(() => vi.advanceTimersByTimeAsync(1500));
    expect(t.hook.result.current.phase).toBe('grace');
    // …and the words reopen the turn.
    await t.push(RtEvent.VOICE_RESUMED, { streamId: STREAM });
    expect(t.hook.result.current.phase).toBe('listening');
    await act(() => vi.advanceTimersByTimeAsync(10_000));
    expect(t.sendAnswer).not.toHaveBeenCalled();
    await t.turnEnd({
      transcriptId: '1b8f6a4e-3b3c-4b8e-9a51-2f4a5c3c1d11',
      text: 'Longer answer',
    });
    await act(() => vi.advanceTimersByTimeAsync(2000));
    await t.settle();
    expect(t.sendAnswer).toHaveBeenCalledWith('q1', 'Longer answer', expect.anything());
  });

  it('"send now" while talking flushes the stream and submits the final transcript at once', async () => {
    const t = setup();
    await t.settle();
    act(() => t.hook.result.current.sendNow());
    await t.settle();
    expect(t.hook.result.current.phase).toBe('finishing');
    expect(t.of(RtEvent.VOICE_STREAM_STOP)[0]!.payload).toEqual({
      streamId: STREAM,
      action: 'send',
    });
    await t.turnEnd({ reason: 'requested', graceMs: 0 });
    await t.settle();
    expect(t.sendAnswer).toHaveBeenCalledOnce();
  });

  it('barge-in: speaking over the question stops it and starts the answer with the words that triggered it', async () => {
    const t = setup({ interviewerSpeaking: true });
    await t.settle();
    expect(t.hook.result.current.phase).toBe('interviewer');
    // Quiet room, then a short click: not a barge-in.
    await t.mic.frame(0.004, 10);
    await t.mic.frame(0.3, 1);
    await t.mic.frame(0.004, 1);
    expect(t.onBargeIn).not.toHaveBeenCalled();
    expect(t.of(RtEvent.VOICE_STREAM_START)).toHaveLength(0);
    // 300 ms of speech.
    await t.mic.frame(0.3, 3);
    expect(t.onBargeIn).toHaveBeenCalledOnce();
    expect(t.of(RtEvent.VOICE_BARGE_IN)[0]!.payload).toEqual({
      sessionId: 'session-1',
      questionId: 'q1',
    });
    await t.settle();
    expect(t.hook.result.current.phase).toBe('listening');
    // The half second before the barge-in goes out first, then the audio that follows.
    await t.mic.frame(0.3, 1);
    await t.settle();
    expect(t.of(RtEvent.VOICE_STREAM_AUDIO)).toHaveLength(6);
    // Audio ending by itself later does not change anything.
    t.rerender({ interviewerSpeaking: false });
    expect(t.hook.result.current.phase).toBe('listening');
  });

  it('waits for the question to be saved before opening the stream (barge-in during a streamed question)', async () => {
    const t = setup({ interviewerSpeaking: true, saved: false, questionId: 'q2' });
    await t.settle();
    await t.mic.frame(0.3, 3);
    await t.mic.frame(0.3, 4);
    await t.settle();
    expect(t.of(RtEvent.VOICE_STREAM_START)).toHaveLength(0);
    t.rerender({ interviewerSpeaking: false, saved: true, questionId: 'q2' });
    await t.settle();
    expect(t.of(RtEvent.VOICE_STREAM_START)[0]!.payload).toMatchObject({ questionId: 'q2' });
    await t.settle();
    // Preroll plus everything captured meanwhile.
    expect(t.of(RtEvent.VOICE_STREAM_AUDIO).length).toBeGreaterThanOrEqual(7);
  });

  it('asks for review before sending when the candidate prefers it, and sends a corrected text as edited', async () => {
    const t = setup({ reviewBeforeSending: true });
    await t.settle();
    await t.turnEnd({ text: 'We used cafe for caching' });
    expect(t.hook.result.current.phase).toBe('review');
    await act(() => vi.advanceTimersByTimeAsync(10_000));
    expect(t.sendAnswer).not.toHaveBeenCalled();
    act(() => t.hook.result.current.edit());
    expect(t.hook.result.current.phase).toBe('editing');
    act(() => t.hook.result.current.submit('We used Caffeine for caching'));
    await t.settle();
    expect(t.sendAnswer).toHaveBeenCalledWith('q1', 'We used Caffeine for caching', {
      voiceTranscriptId: TRANSCRIPT,
      voiceEdited: true,
      clientMsgId: `rt-${TRANSCRIPT}-e`,
    });
  });

  it('an unclear or empty answer waits for the candidate', async () => {
    const t = setup();
    await t.settle();
    await t.turnEnd({ lowConfidence: true });
    expect(t.hook.result.current.phase).toBe('review');
    act(() => t.hook.result.current.submit());
    await t.settle();
    expect(t.sendAnswer).toHaveBeenCalledOnce();
  });

  it('pauses on a dropped connection, keeps the text and resumes the answer', async () => {
    const t = setup();
    await t.settle();
    await t.push(RtEvent.VOICE_TRANSCRIPT, {
      streamId: STREAM,
      questionId: 'q1',
      text: 'First I profiled the service',
      interim: '',
    });
    t.setReady(false);
    await t.push(VOICE_LEFT);
    expect(t.hook.result.current).toMatchObject({
      phase: 'paused',
      text: 'First I profiled the service',
      streamId: null,
    });
    // Nothing is sent while offline.
    const sentBefore = t.of(RtEvent.VOICE_STREAM_AUDIO).length;
    await t.mic.frame(0.1, 2);
    expect(t.of(RtEvent.VOICE_STREAM_AUDIO)).toHaveLength(sentBefore);

    t.setReady(true);
    t.setStartAck({
      ok: true,
      stream: { streamId: STREAM, resumedText: 'First I profiled the service', graceMs: 2000 },
    });
    await t.push(VOICE_JOINED);
    await t.settle();
    expect(t.hook.result.current.phase).toBe('listening');
    expect(t.of(RtEvent.VOICE_STREAM_START).at(-1)!.payload).toMatchObject({ resume: true });
    expect(t.hook.result.current.text).toBe('First I profiled the service');
  });

  it('a finished answer interrupted by a reconnect waits for review instead of being sent twice', async () => {
    const t = setup();
    await t.settle();
    await t.turnEnd();
    await t.push(VOICE_LEFT);
    await act(() => vi.advanceTimersByTimeAsync(5_000));
    await t.push(VOICE_JOINED);
    expect(t.hook.result.current.phase).toBe('review');
    expect(t.sendAnswer).not.toHaveBeenCalled();
  });

  it('falls back to push-to-talk when streaming is not possible', async () => {
    const unsupported = setup();
    unsupported.setStartAck({ ok: false, code: 'UNSUPPORTED', message: 'no' });
    unsupported.rerender({ questionId: 'q2' });
    await unsupported.settle();
    expect(unsupported.hook.result.current).toMatchObject({
      phase: 'fallback',
      fallback: 'unsupported',
    });
    // Unsupported lasts for the interview: the next question stays push-to-talk.
    unsupported.rerender({ questionId: 'q3' });
    expect(unsupported.hook.result.current.phase).toBe('fallback');
    expect(unsupported.mic.closed).toHaveBeenCalled();

    const outage = setup();
    await outage.settle();
    await outage.push(RtEvent.VOICE_STREAM_ERROR, { streamId: STREAM, code: 'SPEECH_UNAVAILABLE' });
    expect(outage.hook.result.current).toMatchObject({
      phase: 'fallback',
      fallback: 'unavailable',
    });
    // The next question tries realtime again.
    outage.rerender({ questionId: 'q2' });
    await outage.settle();
    expect(outage.hook.result.current.phase).toBe('listening');

    const denied = setup({
      openMic: vi.fn(async () => {
        throw Object.assign(new Error('denied'), { name: 'NotAllowedError' });
      }),
    });
    await denied.settle();
    expect(denied.hook.result.current).toMatchObject({
      phase: 'fallback',
      fallback: 'device',
      micProblem: 'denied',
    });
  });
});

describe('voice turn reducer', () => {
  it('ignores events that do not belong to the current phase', () => {
    let s = voiceTurnReducer(initialVoiceTurn, {
      type: 'question',
      questionId: 'q1',
      speaking: false,
    });
    s = voiceTurnReducer(s, { type: 'graceDone' });
    expect(s.phase).toBe('listening');
    s = voiceTurnReducer(s, { type: 'submit' });
    expect(s.phase).toBe('listening');
    // Editing with nothing typed cannot be submitted.
    s = voiceTurnReducer(s, { type: 'edit' });
    expect(voiceTurnReducer(s, { type: 'submit', text: '  ' }).phase).toBe('editing');
  });
});

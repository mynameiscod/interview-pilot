import {
  REALTIME_VOICE,
  RtEvent,
  type RtAck,
  type VoiceStreamErrorEvent,
  type VoiceStreamIdEvent,
  type VoiceTranscriptEvent,
  type VoiceTurnEndEvent,
} from '@cbi/shared-types';
import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { createEnergyVad } from '../voice/energy-vad';
import { micProblem, openMicrophone, stopStream, type MicProblem } from '../voice/media';
import { openPcmCapture, type CaptureFactory, type PcmCapture } from '../voice/pcm-capture';
import type { SendResult, VoiceChannel } from './useInterviewRoom';
import { VOICE_JOINED, VOICE_LEFT } from './useInterviewRoom';

/**
 * - idle: no question to answer yet
 * - interviewer: the question is being spoken; the microphone only listens for a barge-in
 * - listening: the answer streams to the speech service
 * - finishing: "send now" was pressed; waiting for the last words
 * - grace: the answer seems complete; it is sent when the countdown ends
 * - review: the transcript waits for the candidate (preference, unclear, after a reconnect)
 * - editing: the candidate corrects the text
 * - submitting / sent: through the ordinary answer path
 * - paused: the connection dropped while answering; the text is kept
 * - fallback: push-to-talk takes over
 */
export type VoicePhase =
  | 'idle'
  | 'interviewer'
  | 'listening'
  | 'finishing'
  | 'grace'
  | 'review'
  | 'editing'
  | 'submitting'
  | 'sent'
  | 'paused'
  | 'fallback';

/** Why push-to-talk took over. `unsupported` lasts for the whole interview. */
export type FallbackReason = 'unsupported' | 'unavailable' | 'slow' | 'device';

export interface VoiceTurnState {
  phase: VoicePhase;
  questionId: string | null;
  streamId: string | null;
  /** Confirmed text (the server's), and the words still settling. */
  text: string;
  interim: string;
  /** The stored transcript that will be submitted (from the latest turn end). */
  transcript: { id: string; text: string; lowConfidence: boolean } | null;
  /** When the grace countdown ends (Date.now() clock). */
  graceEndsAt: number | null;
  fallback: FallbackReason | null;
  micProblem: MicProblem | null;
}

export type VoiceTurnAction =
  | { type: 'question'; questionId: string; speaking: boolean }
  | { type: 'spoken' }
  | { type: 'bargeIn' }
  | { type: 'streamStarted'; streamId: string; resumedText: string }
  | { type: 'streamLost' }
  | { type: 'transcript'; text: string; interim: string }
  | {
      type: 'turnEnd';
      transcriptId: string;
      text: string;
      graceMs: number;
      lowConfidence: boolean;
      review: boolean;
      at: number;
    }
  | { type: 'resumed' }
  | { type: 'speech'; at: number; graceMs: number }
  | { type: 'graceDone' }
  | { type: 'sendNow' }
  | { type: 'edit' }
  /** Send the transcript under review, or (editing) the corrected text. */
  | { type: 'submit'; text?: string }
  | { type: 'sent' }
  | { type: 'sendFailed' }
  | { type: 'disconnected' }
  | { type: 'reconnected' }
  | { type: 'fallback'; reason: FallbackReason; micProblem?: MicProblem };

export const initialVoiceTurn: VoiceTurnState = {
  phase: 'idle',
  questionId: null,
  streamId: null,
  text: '',
  interim: '',
  transcript: null,
  graceEndsAt: null,
  fallback: null,
  micProblem: null,
};

const ANSWERING: readonly VoicePhase[] = ['listening', 'finishing', 'grace'];

export function voiceTurnReducer(state: VoiceTurnState, action: VoiceTurnAction): VoiceTurnState {
  switch (action.type) {
    case 'question':
      if (action.questionId === state.questionId) return state;
      // Unsupported here (browser, language, flag) stays push-to-talk for every question.
      if (state.fallback === 'unsupported') return { ...state, questionId: action.questionId };
      return {
        ...initialVoiceTurn,
        questionId: action.questionId,
        phase: action.speaking ? 'interviewer' : 'listening',
      };
    case 'spoken':
    case 'bargeIn':
      return state.phase === 'interviewer' ? { ...state, phase: 'listening' } : state;
    case 'streamStarted':
      return {
        ...state,
        streamId: action.streamId,
        // The server's copy of a resumed answer wins; the tab's own copy stays if it has none.
        text: action.resumedText || state.text,
      };
    case 'streamLost':
      return { ...state, streamId: null };
    case 'transcript':
      if (!ANSWERING.includes(state.phase)) return state;
      return { ...state, text: action.text, interim: action.interim };
    case 'turnEnd': {
      if (!ANSWERING.includes(state.phase) && state.phase !== 'review') return state;
      const transcript = {
        id: action.transcriptId,
        text: action.text,
        lowConfidence: action.lowConfidence,
      };
      const base = { ...state, transcript, text: action.text, interim: '', graceEndsAt: null };
      if (!action.text.trim()) return { ...base, phase: 'review' };
      if (state.phase === 'finishing' || action.graceMs === 0)
        return { ...base, phase: 'submitting' };
      if (action.review || action.lowConfidence) return { ...base, phase: 'review' };
      return { ...base, phase: 'grace', graceEndsAt: action.at + action.graceMs };
    }
    case 'resumed':
      // The candidate kept talking: back to listening; a new turn end will follow.
      return state.phase === 'grace' || (state.phase === 'review' && state.streamId)
        ? { ...state, phase: 'listening', graceEndsAt: null, transcript: null }
        : state;
    case 'speech':
      // Speech during the countdown restarts it (the words, if any, bring `resumed`).
      return state.phase === 'grace'
        ? { ...state, graceEndsAt: action.at + action.graceMs }
        : state;
    case 'graceDone':
      return state.phase === 'grace' ? { ...state, phase: 'submitting', graceEndsAt: null } : state;
    case 'sendNow':
      if (state.phase === 'grace' || (state.phase === 'review' && state.transcript))
        return { ...state, phase: 'submitting', graceEndsAt: null };
      if (state.phase === 'listening' && state.streamId) return { ...state, phase: 'finishing' };
      return state;
    case 'edit':
      return ['listening', 'grace', 'review', 'paused'].includes(state.phase)
        ? {
            ...state,
            phase: 'editing',
            graceEndsAt: null,
            text: [state.text, state.interim].filter(Boolean).join(' '),
            interim: '',
          }
        : state;
    case 'submit':
      if (state.phase === 'editing') {
        const text = (action.text ?? state.text).trim();
        return text ? { ...state, phase: 'submitting', text } : state;
      }
      return state.phase === 'review' && state.transcript
        ? { ...state, phase: 'submitting' }
        : state;
    case 'sent':
      return { ...state, phase: 'sent', graceEndsAt: null };
    case 'sendFailed':
      return state.phase === 'submitting' ? { ...state, phase: 'review' } : state;
    case 'disconnected':
      return ANSWERING.includes(state.phase)
        ? { ...state, phase: 'paused', streamId: null, graceEndsAt: null }
        : { ...state, streamId: null };
    case 'reconnected':
      if (state.phase !== 'paused') return state;
      // A finished answer waits for the candidate; an unfinished one carries on.
      return { ...state, phase: state.transcript ? 'review' : 'listening' };
    case 'fallback':
      return {
        ...state,
        phase: 'fallback',
        streamId: null,
        graceEndsAt: null,
        fallback: action.reason,
        micProblem: action.micProblem ?? null,
      };
  }
}

export interface RealtimeVoiceOptions {
  sessionId: string;
  channel: VoiceChannel;
  /** The question being answered: the saved one, or the one still being written (draft). */
  questionId: string | null;
  /** The question is saved (a stream can only be opened for a saved question). */
  saved: boolean;
  /** Realtime voice may run (flag, browser support, spoken mode, not a coding question). */
  enabled: boolean;
  /** The interviewer's audio is loading or playing. */
  interviewerSpeaking: boolean;
  /** Always show the transcript before sending (the candidate's preference). */
  reviewBeforeSending: boolean;
  sendAnswer: (
    questionId: string,
    text: string,
    opts: { voiceTranscriptId?: string; voiceEdited?: boolean; clientMsgId?: string },
  ) => Promise<SendResult>;
  /** Stop the question audio at once (barge-in). */
  onBargeIn: () => void;
  /** Tests replace the microphone and the AudioWorklet. */
  openMic?: () => Promise<MediaStream>;
  capture?: CaptureFactory;
}

/**
 * Realtime conversational voice for one interview room. The microphone
 * stays open while the interview is in voice mode. While the interviewer
 * speaks, only a local voice detector runs: speaking over it stops the
 * audio (barge-in) and starts the answer, including the last half second
 * that triggered it. The answer streams over the interview socket; the
 * server decides when it is complete and this hook then counts down the
 * grace window (keep talking to continue, send now, or edit) and submits
 * the stored transcript through the room's ordinary answer path, once
 * (`clientMsgId` is derived from the transcript). A dropped connection
 * pauses the answer with its text kept; it resumes, or can be edited.
 * Anything that stops streaming falls back to push-to-talk.
 */
export function useRealtimeVoice(opts: RealtimeVoiceOptions) {
  const { channel, questionId, saved, enabled, interviewerSpeaking, sendAnswer } = opts;
  const [state, dispatch] = useReducer(voiceTurnReducer, initialVoiceTurn);
  const [level, setLevel] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const stateRef = useRef(state);
  const latest = useRef(opts);
  /**
   * The phase as the audio path sees it. A barge-in switches it at once:
   * frames keep arriving between the dispatch and the next render.
   */
  const phaseRef = useRef<VoicePhase>(state.phase);
  useEffect(() => {
    stateRef.current = state;
    phaseRef.current = state.phase;
    latest.current = opts;
  });

  /** Frames waiting for a stream (a barge-in before the question is saved, a reconnect). */
  const queueRef = useRef<Uint8Array[]>([]);
  /** The last half second, sent ahead of a barge-in so its first words are not lost. */
  const prerollRef = useRef<Uint8Array[]>([]);
  const inFlightRef = useRef(0);
  const seqRef = useRef(0);
  /** The question a stream is being opened for (a newer question may start its own). */
  const startingRef = useRef<string | null>(null);
  const submittedRef = useRef<string | null>(null);
  const vadRef = useRef(createEnergyVad());
  const lastLevelAt = useRef(0);

  const active = enabled && state.fallback === null;

  // ---- A new question (or the draft becoming the saved question) ----
  useEffect(() => {
    // Only the question id decides a new turn; whether audio plays is read at that moment.
    if (enabled && questionId)
      dispatch({ type: 'question', questionId, speaking: latest.current.interviewerSpeaking });
  }, [enabled, questionId]);

  useEffect(() => {
    if (!interviewerSpeaking && state.phase === 'interviewer') dispatch({ type: 'spoken' });
  }, [interviewerSpeaking, state.phase]);

  useEffect(() => {
    if (state.phase === 'interviewer') vadRef.current.reset();
    if (state.phase !== 'listening' && state.phase !== 'finishing' && state.phase !== 'grace') {
      queueRef.current = [];
    }
  }, [state.phase, state.questionId]);

  // ---- Sending audio (acknowledged frames: at most maxInFlightFrames outstanding) ----
  const pump = useCallback(() => {
    const step = () => {
      const streamId = stateRef.current.streamId;
      if (!streamId || !latest.current.channel.ready()) return;
      while (queueRef.current.length && inFlightRef.current < REALTIME_VOICE.maxInFlightFrames) {
        const audio = queueRef.current.shift()!;
        inFlightRef.current += 1;
        latest.current.channel
          .request(RtEvent.VOICE_STREAM_AUDIO, { streamId, seq: seqRef.current++, audio }, 5_000)
          .catch(() => undefined)
          .finally(() => {
            inFlightRef.current = Math.max(0, inFlightRef.current - 1);
            step();
          });
      }
    };
    step();
  }, []);

  const enqueue = useCallback(
    (audio: Uint8Array) => {
      queueRef.current.push(audio);
      if (queueRef.current.length > REALTIME_VOICE.maxQueuedFrames) {
        // The connection cannot keep up (or the stream never opened): push-to-talk is safer.
        queueRef.current = [];
        dispatch({ type: 'fallback', reason: 'slow' });
        return;
      }
      pump();
    },
    [pump],
  );

  const bargeIn = useCallback(() => {
    const s = stateRef.current;
    latest.current.onBargeIn();
    if (s.questionId) {
      latest.current.channel
        .request(RtEvent.VOICE_BARGE_IN, {
          sessionId: latest.current.sessionId,
          questionId: s.questionId,
        })
        .catch(() => undefined);
    }
    queueRef.current = [...prerollRef.current];
    phaseRef.current = 'listening';
    dispatch({ type: 'bargeIn' });
  }, []);

  const onFrame = useCallback(
    (audio: Uint8Array, frameLevel: number) => {
      const t = Date.now();
      if (t - lastLevelAt.current >= 200) {
        lastLevelAt.current = t;
        setLevel(Math.min(1, frameLevel * 5));
      }
      prerollRef.current.push(audio);
      if (prerollRef.current.length > 5) prerollRef.current.shift();
      const phase = phaseRef.current;
      if (phase === 'interviewer') {
        if (vadRef.current.process(frameLevel) === 'start') bargeIn();
        return;
      }
      if (phase === 'listening' || phase === 'finishing' || phase === 'grace') enqueue(audio);
    },
    [bargeIn, enqueue],
  );

  // ---- The microphone: open while realtime voice runs ----
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    let stream: MediaStream | null = null;
    let capture: PcmCapture | null = null;
    const open = latest.current.openMic ?? openMicrophone;
    const tap = latest.current.capture ?? openPcmCapture;
    (async () => {
      try {
        stream = await open();
        if (cancelled) return stopStream(stream);
        capture = await tap(stream, onFrame);
        if (cancelled) capture.close();
      } catch (err) {
        if (cancelled) return;
        stopStream(stream);
        const problem = err instanceof Error && err.name ? micProblem(err) : 'other';
        dispatch({ type: 'fallback', reason: 'device', micProblem: problem });
      }
    })();
    return () => {
      cancelled = true;
      capture?.close();
      stopStream(stream);
    };
  }, [active, onFrame]);

  // ---- Opening the stream for the current question ----
  const startStream = useCallback(async () => {
    const s = stateRef.current;
    const o = latest.current;
    if (startingRef.current === s.questionId || s.streamId || !s.questionId || !o.saved) return;
    if (s.phase !== 'listening' || !o.channel.ready()) return;
    if (s.questionId !== o.questionId) return;
    startingRef.current = s.questionId;
    let ack: RtAck;
    try {
      ack = await o.channel.request(RtEvent.VOICE_STREAM_START, {
        sessionId: o.sessionId,
        questionId: s.questionId,
        encoding: 'linear16',
        sampleRate: REALTIME_VOICE.sampleRate,
        resume: Boolean(s.text),
      });
    } catch {
      // No answer (connection trouble): the next (re)join tries again.
      return;
    } finally {
      if (startingRef.current === s.questionId) startingRef.current = null;
    }
    if (stateRef.current.questionId !== s.questionId) return;
    if (ack.ok && ack.stream) {
      seqRef.current = 0;
      inFlightRef.current = 0;
      dispatch({
        type: 'streamStarted',
        streamId: ack.stream.streamId,
        resumedText: ack.stream.resumedText,
      });
      return;
    }
    if (!ack.ok && ack.code === 'UNSUPPORTED')
      dispatch({ type: 'fallback', reason: 'unsupported' });
    else if (!ack.ok && (ack.code === 'SPEECH_UNAVAILABLE' || ack.code === 'INTERNAL'))
      dispatch({ type: 'fallback', reason: 'unavailable' });
    // STALE_QUESTION / INVALID_STATE: the interview moved on; the next question resets this.
  }, []);

  useEffect(() => {
    if (active && state.phase === 'listening' && !state.streamId && saved) void startStream();
  }, [active, state.phase, state.streamId, state.questionId, saved, questionId, startStream]);

  // Frames queued before the stream opened go out as soon as it does.
  useEffect(() => {
    if (state.streamId) pump();
  }, [state.streamId, pump]);

  // ---- Server events ----
  useEffect(() => {
    if (!active) return;
    const mine = (streamId: string) => stateRef.current.streamId === streamId;
    const offs = [
      channel.on<VoiceTranscriptEvent>(RtEvent.VOICE_TRANSCRIPT, (e) => {
        if (mine(e.streamId)) dispatch({ type: 'transcript', text: e.text, interim: e.interim });
      }),
      channel.on<VoiceTurnEndEvent>(RtEvent.VOICE_TURN_END, (e) => {
        if (!mine(e.streamId)) return;
        dispatch({
          type: 'turnEnd',
          transcriptId: e.transcriptId,
          text: e.text,
          graceMs: e.graceMs,
          lowConfidence: e.lowConfidence,
          review: latest.current.reviewBeforeSending,
          at: Date.now(),
        });
      }),
      channel.on<VoiceStreamIdEvent>(RtEvent.VOICE_RESUMED, (e) => {
        if (mine(e.streamId)) dispatch({ type: 'resumed' });
      }),
      channel.on<VoiceStreamIdEvent>(RtEvent.VOICE_SPEECH, (e) => {
        if (mine(e.streamId))
          dispatch({ type: 'speech', at: Date.now(), graceMs: REALTIME_VOICE.graceMs });
      }),
      channel.on<VoiceStreamErrorEvent>(RtEvent.VOICE_STREAM_ERROR, (e) => {
        if (!mine(e.streamId)) return;
        if (e.code === 'SPEECH_UNAVAILABLE' || e.code === 'INTERNAL')
          dispatch({ type: 'fallback', reason: 'unavailable' });
        else if (e.code === 'RATE') dispatch({ type: 'fallback', reason: 'slow' });
        // LIMIT: the turn end with what was heard follows.
      }),
      channel.on<VoiceStreamIdEvent>(RtEvent.VOICE_STREAM_CLOSED, (e) => {
        // Closed by the server while still answering (idle provider): reopen and carry on.
        if (mine(e.streamId)) dispatch({ type: 'streamLost' });
      }),
      channel.on(VOICE_LEFT, () => dispatch({ type: 'disconnected' })),
      channel.on(VOICE_JOINED, () => {
        dispatch({ type: 'reconnected' });
        void startStream();
      }),
    ];
    return () => offs.forEach((off) => off());
  }, [active, channel, startStream]);

  // ---- The grace window ----
  useEffect(() => {
    if (state.phase !== 'grace' || state.graceEndsAt === null) return;
    const left = Math.max(0, state.graceEndsAt - Date.now());
    const done = setTimeout(() => dispatch({ type: 'graceDone' }), left);
    const tick = setInterval(() => setNow(Date.now()), 250);
    return () => {
      clearTimeout(done);
      clearInterval(tick);
    };
  }, [state.phase, state.graceEndsAt]);

  // ---- "Send now" while still talking: flush on the server, then submit the turn end ----
  useEffect(() => {
    if (state.phase !== 'finishing' || !state.streamId) return;
    channel
      .request(RtEvent.VOICE_STREAM_STOP, { streamId: state.streamId, action: 'send' })
      .catch(() => undefined);
  }, [state.phase, state.streamId, channel]);

  // ---- Submitting, exactly once per transcript ----
  useEffect(() => {
    if (state.phase !== 'submitting' || !state.questionId) return;
    const edited = state.transcript === null || state.text.trim() !== state.transcript.text.trim();
    const key = `${state.questionId}:${state.transcript?.id ?? 'typed'}:${state.text}`;
    if (submittedRef.current === key) return;
    submittedRef.current = key;
    const streamId = state.streamId;
    const questionForAnswer = state.questionId;
    const opts = state.transcript
      ? {
          voiceTranscriptId: state.transcript.id,
          voiceEdited: edited || undefined,
          clientMsgId: `rt-${state.transcript.id}${edited ? '-e' : ''}`,
        }
      : {};
    void sendAnswer(questionForAnswer, state.text, opts).then((result) => {
      if (result === 'sent') {
        dispatch({ type: 'sent' });
        if (streamId) {
          channel
            .request(RtEvent.VOICE_STREAM_STOP, { streamId, action: 'close' })
            .catch(() => undefined);
        }
      } else {
        submittedRef.current = null;
        dispatch({ type: 'sendFailed' });
      }
    });
  }, [
    state.phase,
    state.questionId,
    state.transcript,
    state.text,
    state.streamId,
    sendAnswer,
    channel,
  ]);

  // ---- Leaving realtime voice (fallback, text mode, the room closing) releases the stream ----
  useEffect(() => {
    const streamId = state.streamId;
    if (!streamId || active) return;
    channel
      .request(RtEvent.VOICE_STREAM_STOP, { streamId, action: 'cancel' })
      .catch(() => undefined);
  }, [active, state.streamId, channel]);

  const sendNow = useCallback(() => dispatch({ type: 'sendNow' }), []);
  const edit = useCallback(() => dispatch({ type: 'edit' }), []);
  /** Sends the transcript under review, or the corrected text while editing. */
  const submit = useCallback((text?: string) => dispatch({ type: 'submit', text }), []);
  const switchToPushToTalk = useCallback(
    () => dispatch({ type: 'fallback', reason: 'device' }),
    [],
  );

  return {
    ...state,
    level,
    /** Time left in the grace window (null outside it). */
    graceLeftMs:
      state.graceEndsAt === null
        ? null
        : Math.min(REALTIME_VOICE.graceMs, Math.max(0, state.graceEndsAt - now)),
    sendNow,
    edit,
    submit,
    switchToPushToTalk,
  };
}

export type RealtimeVoice = ReturnType<typeof useRealtimeVoice>;

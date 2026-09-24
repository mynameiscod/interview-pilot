import { VOICE_LIMITS } from '@cbi/shared-types';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useCandidateAuth } from '../../app/session';
import {
  createLevelMeter,
  micProblem,
  openMicrophone,
  pickMimeType,
  stopStream,
  type LevelMeter,
  type MicProblem,
} from '../voice/media';
import { fetchQuestionAudio, isSpeechUnavailable } from '../voice/voice-api';

/**
 * - loading: fetching the audio
 * - playing: being read aloud
 * - ready: played (or stopped); can be repeated
 * - blocked: the browser refused to autoplay; needs a click
 * - unavailable: no audio for this question (read it on screen)
 */
export type PlaybackStatus = 'loading' | 'playing' | 'ready' | 'blocked' | 'unavailable';

/**
 * Reads the current question aloud: fetches its audio with the access token,
 * plays it from an object URL and keeps that for "Repeat". Pass a null
 * question (text mode, no question) to stop and release everything.
 */
export function useQuestionAudio(
  sessionId: string,
  questionId: string | null,
  onSpeechUnavailable: () => void,
) {
  const { manager } = useCandidateAuth();
  // Keyed by question so a new question starts as "loading" without a reset in the effect.
  const [playback, setPlayback] = useState<{ questionId: string; status: PlaybackStatus } | null>(
    null,
  );
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const urlRef = useRef<string | null>(null);
  const unavailableRef = useRef(onSpeechUnavailable);
  useEffect(() => {
    unavailableRef.current = onSpeechUnavailable;
  }, [onSpeechUnavailable]);

  const play = useCallback(async (forQuestion: string) => {
    const url = urlRef.current;
    if (!url) return;
    let audio = audioRef.current;
    if (!audio) {
      audio = new Audio();
      audioRef.current = audio;
    }
    audio.onended = () => setPlayback({ questionId: forQuestion, status: 'ready' });
    if (audio.src !== url) audio.src = url;
    try {
      audio.currentTime = 0;
    } catch {
      // Not seekable yet: it plays from the start anyway.
    }
    setPlayback({ questionId: forQuestion, status: 'playing' });
    try {
      // Older browsers return undefined instead of a promise.
      await Promise.resolve(audio.play());
    } catch {
      // Autoplay was blocked (or playback failed): the candidate starts it.
      setPlayback({ questionId: forQuestion, status: 'blocked' });
    }
  }, []);

  useEffect(() => {
    if (!questionId) return;
    const controller = new AbortController();
    let cancelled = false;
    fetchQuestionAudio(manager, sessionId, questionId, controller.signal)
      .then((blob) => {
        if (cancelled) return;
        urlRef.current = URL.createObjectURL(blob);
        void play(questionId);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setPlayback({ questionId, status: 'unavailable' });
        if (isSpeechUnavailable(err)) unavailableRef.current();
      });
    return () => {
      cancelled = true;
      controller.abort();
      const audio = audioRef.current;
      if (audio) {
        audio.onended = null;
        audio.pause();
        audio.removeAttribute('src');
      }
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
      urlRef.current = null;
    };
  }, [manager, sessionId, questionId, play]);

  // Release the audio element when the room closes.
  useEffect(
    () => () => {
      audioRef.current?.pause();
      audioRef.current = null;
    },
    [],
  );

  const stop = useCallback(() => {
    const audio = audioRef.current;
    if (!audio || !questionId) return;
    audio.pause();
    setPlayback((p) =>
      p && p.questionId === questionId && p.status === 'playing'
        ? { questionId, status: 'ready' }
        : p,
    );
  }, [questionId]);

  const replay = useCallback(() => {
    if (questionId) void play(questionId);
  }, [play, questionId]);

  const status: PlaybackStatus | null = !questionId
    ? null
    : playback?.questionId === questionId
      ? playback.status
      : 'loading';

  return { status, replay, stop };
}

export type RecorderProblem = MicProblem | 'noFormat';

/** Why recording could not start. */
export class RecorderError extends Error {
  constructor(readonly problem: RecorderProblem) {
    super(`Recording unavailable: ${problem}`);
    this.name = 'RecorderError';
  }
}

export interface Recording {
  blob: Blob;
  durationMs: number;
}

interface ActiveRecording {
  stream: MediaStream;
  recorder: MediaRecorder;
  meter: LevelMeter | null;
  chunks: Blob[];
  mimeType: string;
  startedAt: number;
  timer: ReturnType<typeof setInterval>;
}

const MAX_ANSWER_MS = VOICE_LIMITS.maxAnswerSec * 1000;
const TICK_MS = 200;

/**
 * Records one spoken answer with MediaRecorder (1 s timeslices), showing the
 * elapsed time and input level. Stops by itself at the answer limit
 * (`onLimit` is then called). Everything is released on stop and unmount.
 */
export function useRecorder(onLimit: () => void) {
  const [recording, setRecording] = useState(false);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [level, setLevel] = useState(0);
  const activeRef = useRef<ActiveRecording | null>(null);
  const mountedRef = useRef(true);
  const limitRef = useRef(onLimit);
  useEffect(() => {
    limitRef.current = onLimit;
  }, [onLimit]);

  const release = useCallback((active: ActiveRecording) => {
    clearInterval(active.timer);
    active.meter?.close();
    stopStream(active.stream);
    if (activeRef.current === active) activeRef.current = null;
  }, []);

  /** Starts recording; rejects with a RecorderError when it cannot. */
  const start = useCallback(async (): Promise<void> => {
    if (activeRef.current) return;
    const mimeType = pickMimeType();
    if (!mimeType || typeof navigator.mediaDevices?.getUserMedia !== 'function') {
      throw new RecorderError('noFormat');
    }
    let stream: MediaStream;
    try {
      stream = await openMicrophone();
    } catch (err) {
      throw new RecorderError(micProblem(err));
    }
    if (!mountedRef.current) {
      // The room closed while the permission prompt was open.
      stopStream(stream);
      throw new RecorderError('other');
    }
    let recorder: MediaRecorder;
    try {
      recorder = new MediaRecorder(stream, { mimeType });
    } catch {
      stopStream(stream);
      throw new RecorderError('noFormat');
    }
    const chunks: Blob[] = [];
    recorder.ondataavailable = (e: BlobEvent) => {
      if (e.data && e.data.size > 0) chunks.push(e.data);
    };
    const startedAt = performance.now();
    const meter = createLevelMeter(stream);
    const timer = setInterval(() => {
      const ms = performance.now() - startedAt;
      setElapsedMs(Math.min(ms, MAX_ANSWER_MS));
      setLevel(meter?.read() ?? 0);
      if (ms >= MAX_ANSWER_MS) limitRef.current();
    }, TICK_MS);
    activeRef.current = { stream, recorder, meter, chunks, mimeType, startedAt, timer };
    recorder.start(1000);
    setElapsedMs(0);
    setLevel(0);
    setRecording(true);
  }, []);

  /** Stops and returns the recording (null when nothing was recording). */
  const stop = useCallback((): Promise<Recording | null> => {
    const active = activeRef.current;
    if (!active) return Promise.resolve(null);
    const durationMs = Math.min(performance.now() - active.startedAt, MAX_ANSWER_MS);
    activeRef.current = null;
    setRecording(false);
    return new Promise<Recording>((resolve) => {
      const finish = () => {
        release(active);
        const type = active.recorder.mimeType || active.mimeType;
        resolve({ blob: new Blob(active.chunks, { type }), durationMs });
      };
      if (active.recorder.state === 'inactive') finish();
      else {
        active.recorder.onstop = finish;
        active.recorder.stop();
      }
    });
  }, [release]);

  /** Discards a recording in progress. */
  const cancel = useCallback(() => {
    const active = activeRef.current;
    if (!active) return;
    active.recorder.onstop = null;
    active.recorder.ondataavailable = null;
    if (active.recorder.state !== 'inactive') active.recorder.stop();
    release(active);
    setRecording(false);
  }, [release]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      const active = activeRef.current;
      if (!active) return;
      active.recorder.onstop = null;
      active.recorder.ondataavailable = null;
      if (active.recorder.state !== 'inactive') active.recorder.stop();
      release(active);
    };
  }, [release]);

  return { recording, elapsedMs, level, start, stop, cancel };
}

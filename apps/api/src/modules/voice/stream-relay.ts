import { randomUUID } from 'node:crypto';
import {
  AiAbortedError,
  AiUnavailableError,
  type AiRouter,
  type AiTranscriptionStream,
  type SpeechStreamEvent,
} from '@cbi/ai-core';
import { voiceStreamEventsTotal, voiceStreamsOpen, type Logger } from '@cbi/config';
import type { Redis } from '@cbi/db';
import {
  ANSWER_LIMITS,
  deliveryMetrics,
  REALTIME_VOICE,
  RtEvent,
  VOICE_LIMITS,
  VoiceStreamStartPayload,
  VoiceStreamStopPayload,
  type InterviewLanguage,
  type RtAck,
  type TurnEndReason,
  type VoiceStreamErrorCode,
  type VoiceTranscriptEvent,
  type VoiceTurnEndEvent,
} from '@cbi/shared-types';
import { LiveError } from '../live/live.service.js';
import { createEndpointDetector, type EndpointPolicy, type EndpointTimers } from './endpointing.js';
import type { VoiceLatency } from './latency.js';
import type { StoredTranscript, TranscriptStore } from './voice.service.js';

type Ack = (response: RtAck) => void;

/** The part of a Socket.IO server socket the relay uses (tests pass a fake). */
export interface RelaySocket {
  on(event: string, listener: (...args: never[]) => void): unknown;
  emit(event: string, payload: unknown): unknown;
}

/** Partial answers kept for a resume after a dropped connection (Redis, short-lived). */
export function createPartialStore(redis: Redis) {
  const key = (userId: string, questionId: string) => `cbi:voice:partial:${userId}:${questionId}`;
  return {
    async get(userId: string, questionId: string): Promise<string> {
      return (await redis.get(key(userId, questionId)).catch(() => null)) ?? '';
    },
    async put(userId: string, questionId: string, text: string) {
      await redis
        .set(key(userId, questionId), text, 'EX', REALTIME_VOICE.partialTtlSec)
        .catch(() => undefined);
    },
    async clear(userId: string, questionId: string) {
      await redis.del(key(userId, questionId)).catch(() => undefined);
    },
  };
}
export type PartialStore = ReturnType<typeof createPartialStore>;

export interface RelayDeps {
  router: Pick<AiRouter, 'openTranscriptionStream'>;
  /**
   * Checks the candidate may stream an answer to this question now (flag,
   * state, spoken mode, consent, current question, a streamable language).
   * Throws a LiveError; `UNSUPPORTED` sends the room to push-to-talk.
   */
  authorize(
    userId: string,
    payload: VoiceStreamStartPayload,
  ): Promise<{ language: InterviewLanguage }>;
  transcripts: Pick<TranscriptStore, 'put'>;
  partials: PartialStore;
  latency: Pick<VoiceLatency, 'speechEnded'>;
  logger: Logger;
  policy?: Partial<EndpointPolicy>;
  /** Tests shorten the timings. */
  finalizeWaitMs?: number;
  backpressureBytes?: number;
  timers?: EndpointTimers;
  now?: () => number;
}

const LOW_CONFIDENCE = 0.5;

interface ActiveStream {
  streamId: string;
  sessionId: string;
  questionId: string;
  language: InterviewLanguage;
  provider: AiTranscriptionStream;
  detector: ReturnType<typeof createEndpointDetector>;
  /** Settled segments, in order (including text resumed from before a reconnect). */
  committed: string[];
  interim: string;
  confidences: number[];
  bytes: number;
  /** Rate window: bytes received in the current second. */
  windowStart: number;
  windowBytes: number;
  /** Wall time the last settled words arrived (≈ the end of speech plus provider lag). */
  lastWordsAt: number | null;
  /** A final result arrived (`send` waits for the flush). */
  onFinal: (() => void) | null;
  ended: boolean;
  closed: boolean;
}

/**
 * Relays one socket's microphone stream to a streaming speech-to-text
 * session and back (realtime voice). The browser sends 100 ms PCM frames,
 * each acknowledged: an ack is held while the provider connection is
 * backed up, so the browser's in-flight window is the backpressure. Audio
 * faster than 1.5× real time or in oversized frames is refused. The live
 * transcript goes to this socket only.
 *
 * The end of the answer is decided here (endpointing.ts). A turn end stores
 * the transcript like a push-to-talk one and tells the browser, which
 * submits it through the ordinary answer path after its grace window: the
 * engine still owns the turn. The stream stays open during the grace
 * window, so more speech reopens the turn. A dropped socket closes the
 * provider stream (metering it); the text so far is kept for a resume.
 */
export function createVoiceStreamRelay(deps: RelayDeps) {
  const now = deps.now ?? Date.now;
  const finalizeWaitMs = deps.finalizeWaitMs ?? 1_500;
  const backpressureBytes = deps.backpressureBytes ?? 256 * 1024;
  const maxBytes = VOICE_LIMITS.maxAnswerSec * REALTIME_VOICE.sampleRate * 2;

  return {
    /** Registers the realtime voice handlers on an authenticated socket. */
    attach(socket: RelaySocket, who: { userId: string; sessionId: () => string | null }) {
      let active: ActiveStream | null = null;
      const text = (s: ActiveStream) =>
        s.committed.join(' ').replace(/\s+/g, ' ').trim().slice(0, ANSWER_LIMITS.maxChars);

      function fail(s: ActiveStream, code: VoiceStreamErrorCode) {
        if (code === 'SPEECH_UNAVAILABLE') voiceStreamEventsTotal.inc({ event: 'fallback' });
        if (code === 'RATE') voiceStreamEventsTotal.inc({ event: 'rate_limited' });
        socket.emit(RtEvent.VOICE_STREAM_ERROR, { streamId: s.streamId, code });
        void close(s, { keepPartial: true });
      }

      async function close(s: ActiveStream, opts: { keepPartial: boolean }) {
        if (s.closed) return;
        s.closed = true;
        s.detector.dispose();
        if (active === s) active = null;
        voiceStreamsOpen.dec();
        if (opts.keepPartial) {
          const partial = text(s);
          if (partial) await deps.partials.put(who.userId, s.questionId, partial);
        } else {
          await deps.partials.clear(who.userId, s.questionId);
        }
        await s.provider.close().catch((err: unknown) => {
          deps.logger.warn({ err, sessionId: s.sessionId }, 'speech stream close failed');
        });
        socket.emit(RtEvent.VOICE_STREAM_CLOSED, { streamId: s.streamId });
      }

      /** The answer is complete: store the transcript and let the browser submit it. */
      async function endTurn(s: ActiveStream, reason: TurnEndReason) {
        if (s.closed) return;
        s.detector.ended();
        s.ended = true;
        // A requested end also takes the words still settling.
        if (reason !== 'silence' && s.interim) {
          s.committed.push(s.interim);
          s.interim = '';
        }
        const answer = text(s);
        const at = now();
        const avg = s.confidences.length
          ? s.confidences.reduce((a, b) => a + b, 0) / s.confidences.length
          : null;
        const durationSec = Math.round((s.bytes / (REALTIME_VOICE.sampleRate * 2)) * 10) / 10;
        const stored: StoredTranscript = {
          transcriptId: randomUUID(),
          userId: who.userId,
          sessionId: s.sessionId,
          questionId: s.questionId,
          text: answer,
          durationSec,
          language: s.language,
          confidence: avg,
          model: s.provider.model.modelId,
          // Pace and fillers from the text and audio length; the live stream keeps no
          // word timings, so pauses are left out (coaching only, never scored).
          delivery: deliveryMetrics({ text: answer, durationSec, language: s.language }),
        };
        await deps.transcripts.put(stored);
        await deps.partials.put(who.userId, s.questionId, answer);
        voiceStreamEventsTotal.inc({ event: 'turn_end' });
        void deps.latency.speechEnded(s.sessionId, s.questionId, {
          speechEndAt: s.lastWordsAt ?? at,
          turnEndAt: at,
        });
        if (s.closed) return;
        const event: VoiceTurnEndEvent = {
          streamId: s.streamId,
          questionId: s.questionId,
          transcriptId: stored.transcriptId,
          text: answer,
          reason,
          graceMs: reason === 'silence' ? REALTIME_VOICE.graceMs : 0,
          lowConfidence: !answer || (avg !== null && avg < LOW_CONFIDENCE),
        };
        socket.emit(RtEvent.VOICE_TURN_END, event);
      }

      function onProviderEvent(s: ActiveStream, e: SpeechStreamEvent) {
        if (s.closed) return;
        switch (e.type) {
          case 'transcript': {
            if (e.isFinal) {
              if (e.text) {
                s.committed.push(e.text);
                s.lastWordsAt = now();
                if (e.confidence !== null) s.confidences.push(e.confidence);
              }
              s.interim = '';
              s.onFinal?.();
            } else {
              s.interim = e.text;
            }
            s.detector.transcript(e);
            const update: VoiceTranscriptEvent = {
              streamId: s.streamId,
              questionId: s.questionId,
              text: text(s),
              interim: s.interim,
            };
            socket.emit(RtEvent.VOICE_TRANSCRIPT, update);
            return;
          }
          case 'speech_started':
            s.detector.speechStarted();
            socket.emit(RtEvent.VOICE_SPEECH, { streamId: s.streamId });
            return;
          case 'utterance_end':
            s.detector.utteranceEnd();
            return;
          case 'error':
            deps.logger.warn(
              { err: e.error, sessionId: s.sessionId },
              'speech stream failed; falling back to push-to-talk',
            );
            fail(s, 'SPEECH_UNAVAILABLE');
            return;
          case 'closed':
            // Closed by the provider without an error (idle): the browser reopens if needed.
            if (!s.closed) void close(s, { keepPartial: true });
            return;
        }
      }

      socket.on(RtEvent.VOICE_STREAM_START, async (raw: unknown, ack?: Ack) => {
        try {
          const payload = VoiceStreamStartPayload.parse(raw);
          if (payload.sessionId !== who.sessionId())
            throw new LiveError('INVALID_STATE', 'Join the interview first.');
          if (active) await close(active, { keepPartial: true });
          const { language } = await deps.authorize(who.userId, payload);
          const resumedText = payload.resume
            ? await deps.partials.get(who.userId, payload.questionId)
            : '';
          if (!payload.resume) await deps.partials.clear(who.userId, payload.questionId);
          const streamId = randomUUID();
          let stream: ActiveStream | null = null;
          const pending: SpeechStreamEvent[] = [];
          let provider: AiTranscriptionStream;
          try {
            provider = await deps.router.openTranscriptionStream(
              {
                encoding: payload.encoding,
                sampleRate: payload.sampleRate,
                language,
                utteranceEndMs: REALTIME_VOICE.utteranceEndMs,
              },
              (e) => (stream ? onProviderEvent(stream, e) : pending.push(e)),
              { userId: who.userId, sessionId: payload.sessionId },
            );
          } catch (err) {
            if (err instanceof AiUnavailableError || err instanceof AiAbortedError) {
              voiceStreamEventsTotal.inc({ event: 'fallback' });
              throw new LiveError('SPEECH_UNAVAILABLE', 'Live transcription is unavailable.');
            }
            throw err;
          }
          const s: ActiveStream = {
            streamId,
            sessionId: payload.sessionId,
            questionId: payload.questionId,
            language,
            provider,
            detector: createEndpointDetector({
              onTurnEnd: () => void endTurn(s, 'silence'),
              onResume: () => {
                s.ended = false;
                voiceStreamEventsTotal.inc({ event: 'resumed' });
                socket.emit(RtEvent.VOICE_RESUMED, { streamId });
              },
              policy: deps.policy,
              timers: deps.timers,
            }),
            committed: resumedText ? [resumedText] : [],
            interim: '',
            confidences: [],
            bytes: 0,
            windowStart: now(),
            windowBytes: 0,
            lastWordsAt: null,
            onFinal: null,
            ended: false,
            closed: false,
          };
          stream = s;
          active = s;
          voiceStreamsOpen.inc();
          voiceStreamEventsTotal.inc({ event: 'opened' });
          for (const e of pending.splice(0)) onProviderEvent(s, e);
          ack?.({
            ok: true,
            stream: { streamId, resumedText, graceMs: REALTIME_VOICE.graceMs },
          });
        } catch (err) {
          reply(ack, err);
        }
      });

      socket.on(RtEvent.VOICE_STREAM_AUDIO, async (raw: unknown, ack?: Ack) => {
        const s = active;
        const frame = raw as { streamId?: unknown; audio?: unknown } | null;
        if (!s || !frame || frame.streamId !== s.streamId) {
          return ack?.({ ok: false, code: 'INVALID_STATE', message: 'No open stream.' });
        }
        const audio =
          frame.audio instanceof Uint8Array
            ? frame.audio
            : frame.audio instanceof ArrayBuffer
              ? new Uint8Array(frame.audio)
              : null;
        if (!audio || audio.byteLength === 0 || audio.byteLength > REALTIME_VOICE.maxFrameBytes) {
          return ack?.({ ok: false, code: 'VALIDATION_FAILED', message: 'Invalid audio frame.' });
        }
        const t = now();
        if (t - s.windowStart >= 1000) {
          s.windowStart = t;
          s.windowBytes = 0;
        }
        s.windowBytes += audio.byteLength;
        if (s.windowBytes > REALTIME_VOICE.maxBytesPerSec) {
          fail(s, 'RATE');
          return ack?.({ ok: false, code: 'VALIDATION_FAILED', message: 'Audio too fast.' });
        }
        if (s.bytes + audio.byteLength > maxBytes) {
          // The answer limit: end the turn with what was heard.
          if (!s.ended) {
            s.provider.finalize();
            await waitForFinal(s);
            await endTurn(s, 'limit');
            socket.emit(RtEvent.VOICE_STREAM_ERROR, { streamId: s.streamId, code: 'LIMIT' });
          }
          return ack?.({ ok: true });
        }
        s.bytes += audio.byteLength;
        s.provider.send(audio);
        // Backpressure: hold the acknowledgement while the provider connection is backed up.
        for (
          let waited = 0;
          s.provider.bufferedAmount() > backpressureBytes && waited < 2000;
          waited += 50
        ) {
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        ack?.({ ok: true });
      });

      function waitForFinal(s: ActiveStream) {
        return new Promise<void>((resolve) => {
          const timer = setTimeout(done, finalizeWaitMs);
          function done() {
            clearTimeout(timer);
            if (s.onFinal === done) s.onFinal = null;
            resolve();
          }
          s.onFinal = done;
        });
      }

      socket.on(RtEvent.VOICE_STREAM_STOP, async (raw: unknown, ack?: Ack) => {
        try {
          const payload = VoiceStreamStopPayload.parse(raw);
          const s = active;
          if (!s || s.streamId !== payload.streamId) return ack?.({ ok: true });
          if (payload.action === 'send') {
            // Flush what the provider still holds, then end the turn now.
            s.provider.finalize();
            if (s.interim || !s.committed.length) await waitForFinal(s);
            await endTurn(s, 'requested');
          } else {
            // Submitted (close) or discarded (cancel): nothing is kept for a resume.
            await close(s, { keepPartial: false });
          }
          ack?.({ ok: true });
        } catch (err) {
          reply(ack, err);
        }
      });

      function reply(ack: Ack | undefined, err: unknown) {
        if (err instanceof LiveError)
          return ack?.({ ok: false, code: err.code, message: err.message });
        if ((err as { name?: string })?.name === 'ZodError') {
          return ack?.({ ok: false, code: 'VALIDATION_FAILED', message: 'Invalid message.' });
        }
        deps.logger.error({ err }, 'voice stream handler failed');
        ack?.({ ok: false, code: 'INTERNAL', message: 'Something went wrong. Please try again.' });
      }

      return {
        /** The socket went away: close the provider stream, keep the partial answer. */
        async disconnected() {
          if (active) await close(active, { keepPartial: true });
        },
      };
    },
  };
}

export type VoiceStreamRelay = ReturnType<typeof createVoiceStreamRelay>;

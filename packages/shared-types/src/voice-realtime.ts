import { z } from 'zod';
import { ANSWER_LIMITS, type InterviewLanguage } from './interview-runtime.js';

/**
 * Realtime conversational voice (behind the `voice.realtime` flag). The
 * browser streams microphone audio over the interview socket, the API relays
 * it to a streaming speech-to-text session and decides when the answer is
 * complete (endpointing). The next question is streamed back as text and as
 * sentence-by-sentence audio. The interview engine still owns turns, the
 * ledger and the clock: a streamed answer is submitted through the ordinary
 * answer path, and a streamed question only becomes the question once it is
 * saved (`interview:question`). Push-to-talk stays the fallback.
 */

export const REALTIME_VOICE_FLAG = 'voice.realtime' as const;

export const REALTIME_VOICE = {
  /** Microphone audio sent by the browser: 16 kHz mono PCM16 (little-endian). */
  sampleRate: 16_000,
  /** One audio frame is 100 ms (3 200 bytes). */
  frameMs: 100,
  /** A larger frame is refused (a malicious or broken client). */
  maxFrameBytes: 16_384,
  /** Audio faster than 1.5× real time is dropped (bytes per second). */
  maxBytesPerSec: 48_000,
  /** Frames the browser sends before waiting for acknowledgements (2 s of audio). */
  maxInFlightFrames: 20,
  /** Audio the browser holds while the connection catches up; beyond it, it falls back. */
  maxQueuedFrames: 100,
  /** Countdown between "the answer seems complete" and submitting it. */
  graceMs: 2_000,
  /** Quiet after the provider's end of utterance before the answer counts as complete. */
  silenceMs: 700,
  /** A shorter answer is not ended by silence alone (the candidate may be thinking). */
  minAnswerWords: 3,
  minSpeechMs: 1_200,
  /** After this much quiet any answer with words counts as complete. */
  longSilenceMs: 6_000,
  /** Provider utterance-end gap (Deepgram's minimum is 1 000 ms). */
  utteranceEndMs: 1_000,
  /** Speech this long while the interviewer talks interrupts it (barge-in). */
  bargeInMs: 250,
  /** A streamed partial answer is kept this long for a resume after a dropped connection. */
  partialTtlSec: 600,
} as const;

/**
 * Whether answers in `language` can be transcribed while the candidate
 * speaks. Deepgram nova-3 streams English and, with `multi`, Hindi–English
 * code-switching. Telugu has a monolingual nova-3 model (since January 2026)
 * but it is not part of the code-switching set, and Telugu interviews are
 * usually mixed with English, so they keep push-to-talk with the batch chain.
 */
export function realtimeSttSupported(language: InterviewLanguage): boolean {
  return language === 'en' || language === 'hi';
}

// ---- Client → server ----------------------------------------------------------------------

export const VoiceStreamStartPayload = z.object({
  sessionId: z.string().min(1).max(64),
  questionId: z.string().min(1).max(64),
  encoding: z.literal('linear16'),
  sampleRate: z.literal(REALTIME_VOICE.sampleRate),
  /** Continue the partial answer kept by the server after a dropped connection. */
  resume: z.boolean().default(false),
});
export type VoiceStreamStartPayload = z.infer<typeof VoiceStreamStartPayload>;

/** `voice:stream:audio`: one PCM16 frame (`audio` is binary). Acknowledged. */
export const VoiceStreamAudioPayload = z.object({
  streamId: z.uuid(),
  seq: z.number().int().min(0),
  audio: z.custom<Uint8Array>(
    (v) => v instanceof Uint8Array || v instanceof ArrayBuffer,
    'binary audio expected',
  ),
});
export type VoiceStreamAudioPayload = z.infer<typeof VoiceStreamAudioPayload>;

export const VoiceStreamStopPayload = z.object({
  streamId: z.uuid(),
  /**
   * send: the candidate wants to submit now (flush, then end the turn);
   * cancel: discard (switching to push-to-talk, re-recording);
   * close: the answer was submitted, release the stream.
   */
  action: z.enum(['send', 'cancel', 'close']),
});
export type VoiceStreamStopPayload = z.infer<typeof VoiceStreamStopPayload>;

/** The candidate interrupted the spoken question (metrics only). */
export const BargeInPayload = z.object({
  sessionId: z.string().min(1).max(64),
  questionId: z.string().min(1).max(64),
});
export type BargeInPayload = z.infer<typeof BargeInPayload>;

/** Acknowledgement of `voice:stream:start`. */
export const VoiceStreamStarted = z.object({
  streamId: z.uuid(),
  /** Text kept from before a dropped connection (empty for a fresh answer). */
  resumedText: z.string(),
  graceMs: z.number().int().min(0),
});
export type VoiceStreamStarted = z.infer<typeof VoiceStreamStarted>;

// ---- Server → client (the owning socket only) ---------------------------------------------------

/** Live transcript: `text` is everything confirmed so far, `interim` the words still settling. */
export const VoiceTranscriptEvent = z.object({
  streamId: z.uuid(),
  questionId: z.string(),
  text: z.string().max(ANSWER_LIMITS.maxChars),
  interim: z.string(),
});
export type VoiceTranscriptEvent = z.infer<typeof VoiceTranscriptEvent>;

export const TurnEndReason = z.enum(['silence', 'requested', 'limit']);
export type TurnEndReason = z.infer<typeof TurnEndReason>;

/**
 * The server thinks the answer is complete. `transcriptId` is submitted as
 * the spoken answer after the grace window (or at once for `requested`).
 * Speech that continues brings `voice:stream:resumed` and, later, a new
 * turn end with a new transcript that includes everything.
 */
export const VoiceTurnEndEvent = z.object({
  streamId: z.uuid(),
  questionId: z.string(),
  transcriptId: z.uuid(),
  text: z.string(),
  reason: TurnEndReason,
  graceMs: z.number().int().min(0),
  lowConfidence: z.boolean(),
});
export type VoiceTurnEndEvent = z.infer<typeof VoiceTurnEndEvent>;

export const VoiceStreamErrorCode = z.enum([
  /** Every streaming model failed: push-to-talk (batch chain) takes over. */
  'SPEECH_UNAVAILABLE',
  /** The answer reached the time limit. */
  'LIMIT',
  /** Audio arrived faster than real time or in oversized frames. */
  'RATE',
  'INTERNAL',
]);
export type VoiceStreamErrorCode = z.infer<typeof VoiceStreamErrorCode>;

export const VoiceStreamErrorEvent = z.object({
  streamId: z.uuid(),
  code: VoiceStreamErrorCode,
});
export type VoiceStreamErrorEvent = z.infer<typeof VoiceStreamErrorEvent>;

export const VoiceStreamIdEvent = z.object({ streamId: z.uuid() });
export type VoiceStreamIdEvent = z.infer<typeof VoiceStreamIdEvent>;

// ---- Streamed questions (the room) -------------------------------------------------------------

/**
 * Part of the next question's text as it is generated. A preview only: the
 * saved question (`interview:question`, same `questionId`) is authoritative
 * and may differ when generation fell back.
 */
export const QuestionDeltaEvent = z.object({
  questionId: z.string(),
  seq: z.number().int(),
  text: z.string(),
});
export type QuestionDeltaEvent = z.infer<typeof QuestionDeltaEvent>;

/** Spoken question audio, one sentence at a time, in chunks as synthesized. */
export const QuestionAudioEvent = z.object({
  questionId: z.string(),
  /** 0-based sentence index; chunks of a sentence arrive in order. */
  sentence: z.number().int().min(0),
  chunk: z.number().int().min(0),
  mimeType: z.string(),
  audio: z.custom<Uint8Array>((v) => v instanceof Uint8Array || v instanceof ArrayBuffer),
  /** The sentence's audio is complete. */
  last: z.boolean(),
});
export type QuestionAudioEvent = z.infer<typeof QuestionAudioEvent>;

/**
 * The stream is over. `audio`: complete (every sentence was spoken),
 * failed (fetch the question audio as usual), none (nothing streamed, e.g.
 * the question fell back to another text).
 */
export const QuestionStreamEndEvent = z.object({
  questionId: z.string(),
  audio: z.enum(['complete', 'failed', 'none']),
});
export type QuestionStreamEndEvent = z.infer<typeof QuestionStreamEndEvent>;

// ---- Latency -----------------------------------------------------------------------------------

/** Turn latency stages observed per turn (`cbi_voice_turn_latency_seconds{stage}`). */
export const VoiceLatencyStage = z.enum([
  /** Last word heard → the server decided the answer was complete. */
  'endpoint',
  /** End of speech → first token of the next question. */
  'speech_to_first_token',
  /** End of speech → first byte of the next question's audio. */
  'speech_to_first_audio',
  /** Answer submitted → first token of the next question. */
  'answer_to_first_token',
  /** Answer submitted → first byte of the next question's audio. */
  'answer_to_first_audio',
]);
export type VoiceLatencyStage = z.infer<typeof VoiceLatencyStage>;

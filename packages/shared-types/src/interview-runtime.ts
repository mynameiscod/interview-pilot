import { z } from 'zod';
import { UiLocale } from './i18n.js';
import { InterviewState } from './interviews.js';
import { Difficulty, InterviewMode, RoundType } from './library.js';
import { InterviewLanguagePreference } from './users.js';
import type { VoiceStreamStarted } from './voice-realtime.js';

/**
 * The live interview (Phase 4): rounds, turns (the question ledger), the
 * realtime protocol and the AI outputs the engine consumes.
 */

export const RoundState = z.enum(['PENDING', 'ACTIVE', 'COMPLETED', 'SKIPPED', 'TIMED_OUT']);
export type RoundState = z.infer<typeof RoundState>;

/** Where a question's angle came from (design §29). */
export const QuestionSource = z.enum(['ROLE', 'JD', 'RESUME', 'COMPANY', 'FOLLOW_UP']);
export type QuestionSource = z.infer<typeof QuestionSource>;

export const TurnSufficiency = z.enum(['STRONG', 'ADEQUATE', 'WEAK', 'NO_ANSWER']);
export type TurnSufficiency = z.infer<typeof TurnSufficiency>;

/**
 * A recorded live assessment: a model verdict, or `UNASSESSED` when the
 * assessment could not run. No verdict is invented for an unassessed answer;
 * the planner and the evaluation treat it neutrally.
 */
export const TurnEvalSufficiency = z.enum([...TurnSufficiency.options, 'UNASSESSED']);
export type TurnEvalSufficiency = z.infer<typeof TurnEvalSufficiency>;

export const QuestionDifficulty = Difficulty;

/** Candidate answers are capped; longer text is refused rather than cut silently. */
export const ANSWER_LIMITS = { maxChars: 6000 } as const;

// ---- AI outputs --------------------------------------------------------------------

/** Structured output of `interview.question`. */
export const InterviewQuestionAi = z.object({
  question: z.string().trim().min(10).max(700),
});
export type InterviewQuestionAi = z.infer<typeof InterviewQuestionAi>;

/** Structured output of `interview.assessTurn`. Internal: never sent to the candidate live. */
export const AssessTurnAi = z.object({
  sufficiency: TurnSufficiency,
  followUpNeeded: z.boolean(),
  followUpAngle: z.string().trim().max(300).nullable(),
  /** Short observations tied to the expected evidence (feeds Phase 5 evidence extraction). */
  evidence: z.array(z.string().trim().max(240)).max(5),
  notes: z.string().trim().max(500).nullable(),
});
export type AssessTurnAi = z.infer<typeof AssessTurnAi>;

// ---- What the candidate sees -------------------------------------------------------

export const LiveQuestion = z.object({
  questionId: z.string(),
  seq: z.number().int(),
  text: z.string(),
  roundIdx: z.number().int(),
  roundType: RoundType,
  isFollowUp: z.boolean(),
  askedAt: z.iso.datetime(),
  /** A coding problem: answered in the editor with Run/Submit (Phase 9). */
  coding: z.object({ problemId: z.string(), title: z.string() }).nullable(),
  /** A system design prompt: answered on the whiteboard and notes, then probed. */
  design: z.object({ promptId: z.string(), title: z.string() }).nullable().optional(),
});
export type LiveQuestion = z.infer<typeof LiveQuestion>;

export const LiveTurn = z.object({
  seq: z.number().int(),
  questionId: z.string(),
  roundIdx: z.number().int(),
  question: z.string(),
  answer: z.string().nullable(),
  /** How the answer was given (null while unanswered). */
  answerSource: z.enum(['TEXT', 'VOICE']).nullable(),
});
export type LiveTurn = z.infer<typeof LiveTurn>;

export const LiveRound = z.object({
  type: RoundType,
  state: RoundState,
  durationSec: z.number().int(),
});
export type LiveRound = z.infer<typeof LiveRound>;

/**
 * What the room needs to render after joining or reconnecting. `turns` holds
 * turns after the client's `lastSeq` (all turns when it sends 0). No scores
 * or assessments are ever included.
 */
export const InterviewSnapshot = z.object({
  sessionId: z.string(),
  state: InterviewState,
  mode: InterviewMode,
  /** The interview was set up for voice, so it can switch between voice and text. */
  voiceEnabled: z.boolean(),
  /** The camera is being recorded (video interviews that allow it, with consent). */
  recording: z.boolean(),
  /** Browser integrity observations are noted (the template tracks them). */
  integrityTracking: z.boolean(),
  language: InterviewLanguagePreference,
  title: z.string(),
  rounds: z.array(LiveRound),
  roundIdx: z.number().int(),
  budgetMs: z.number().int(),
  remainingMs: z.number().int(),
  clockRunning: z.boolean(),
  answeredCount: z.number().int(),
  /** The question waiting for an answer, if any. */
  currentQuestion: LiveQuestion.nullable(),
  /** The design question of the current system design round (its design stays viewable). */
  designQuestionId: z.string().nullable().optional(),
  /** The server is preparing the next question. */
  thinking: z.boolean(),
  turns: z.array(LiveTurn),
  lastSeq: z.number().int(),
  serverTime: z.iso.datetime(),
});
export type InterviewSnapshot = z.infer<typeof InterviewSnapshot>;

// ---- Realtime protocol (Socket.IO namespace /rt) ----------------------------------------

export const RT_NAMESPACE = '/rt' as const;

export const RtEvent = {
  JOIN: 'interview:join',
  STATE: 'interview:state',
  QUESTION: 'interview:question',
  THINKING: 'interview:thinking',
  ANSWER_TEXT: 'answer:text',
  HEARTBEAT: 'presence:heartbeat',
  ROUND_TRANSITION: 'round:transition',
  COMPLETED: 'interview:completed',
  ERROR: 'interview:error',
  /** The interview switched between voice and text. */
  MODE_CHANGED: 'interview:mode',
  /** Speech recognition or synthesis is unavailable; the room offers text. */
  DEGRADED: 'interview:degraded',
  /** Client → server: a browser integrity observation (tab hidden, paste …). */
  INTEGRITY: 'integrity:event',
  DRAINING: 'server:draining',
  // ---- Realtime voice (flag `voice.realtime`; payloads in voice-realtime.ts) ----
  /** Client → server: open a streaming transcription for the current question. */
  VOICE_STREAM_START: 'voice:stream:start',
  /** Client → server: one microphone frame (binary, acknowledged: the browser's backpressure). */
  VOICE_STREAM_AUDIO: 'voice:stream:audio',
  VOICE_STREAM_STOP: 'voice:stream:stop',
  /** Client → server: the candidate interrupted the spoken question. */
  VOICE_BARGE_IN: 'voice:barge-in',
  VOICE_TRANSCRIPT: 'voice:stream:transcript',
  /** The provider heard speech start (also a barge-in signal). */
  VOICE_SPEECH: 'voice:stream:speech',
  VOICE_TURN_END: 'voice:stream:turn-end',
  /** Speech continued after a turn end: the grace countdown stops. */
  VOICE_RESUMED: 'voice:stream:resumed',
  VOICE_STREAM_ERROR: 'voice:stream:error',
  VOICE_STREAM_CLOSED: 'voice:stream:closed',
  /** The next question's text as it is generated (a preview until `interview:question`). */
  QUESTION_DELTA: 'question:delta',
  QUESTION_AUDIO: 'question:audio',
  QUESTION_STREAM_END: 'question:stream-end',
} as const;

const clientMsgId = z.string().trim().min(8).max(64);

export const JoinPayload = z.object({
  sessionId: z.string().min(1).max(64),
  /** Highest turn seq the client already shows; 0 on a fresh join. */
  lastSeq: z.number().int().min(0).default(0),
});
export type JoinPayload = z.infer<typeof JoinPayload>;

export const AnswerTextPayload = z.object({
  sessionId: z.string().min(1).max(64),
  questionId: z.string().min(1).max(64),
  text: z.string().max(ANSWER_LIMITS.maxChars),
  /** Idempotency key chosen by the client; a resend with the same id is a no-op. */
  clientMsgId,
  /**
   * A spoken answer: the id returned by the transcription endpoint. The
   * server then uses its own transcript and ignores `text`.
   */
  voiceTranscriptId: z.uuid().optional(),
  /**
   * The candidate corrected the transcript before sending it (realtime
   * voice): `text` is then the answer, and the turn still records the speech
   * metadata, marked as edited.
   */
  voiceEdited: z.boolean().optional(),
});
export type AnswerTextPayload = z.infer<typeof AnswerTextPayload>;

export const HeartbeatPayload = z.object({ sessionId: z.string().min(1).max(64) });

/** Acknowledgement for every client → server event. */
export type RtAck =
  | { ok: true; snapshot?: InterviewSnapshot; duplicate?: boolean; stream?: VoiceStreamStarted }
  | { ok: false; code: RtErrorCode; message: string };

export const RtErrorCode = z.enum([
  'UNAUTHENTICATED',
  'NOT_FOUND',
  'INVALID_STATE',
  'VALIDATION_FAILED',
  'STALE_QUESTION',
  'BUSY',
  'INTERNAL',
  /** Realtime voice is off or not possible here: the room uses push-to-talk. */
  'UNSUPPORTED',
  'SPEECH_UNAVAILABLE',
]);
export type RtErrorCode = z.infer<typeof RtErrorCode>;

export const RoundTransitionEvent = z.object({
  fromRoundIdx: z.number().int(),
  toRoundIdx: z.number().int(),
  toRoundType: RoundType,
});
export type RoundTransitionEvent = z.infer<typeof RoundTransitionEvent>;

// ---- REST -----------------------------------------------------------------------------

/** `POST /interviews/:id/start`. The UI locale settles an `auto` interview language. */
export const StartInterviewBody = z.object({
  uiLocale: UiLocale.optional(),
});
export type StartInterviewBody = z.infer<typeof StartInterviewBody>;

/** The language questions are asked in (an `auto` preference resolved). */
export const InterviewLanguage = z.enum(['en', 'hi', 'te']);
export type InterviewLanguage = z.infer<typeof InterviewLanguage>;

/**
 * Resolves an interview language preference: an explicit language wins;
 * `auto` takes the first known language among `hints` (the profile
 * preference, then the UI locale), and English only when none is known.
 */
export function resolveInterviewLanguage(
  preference: string,
  hints: readonly (string | null | undefined)[] = [],
): InterviewLanguage {
  for (const candidate of [preference, ...hints]) {
    const parsed = InterviewLanguage.safeParse(candidate);
    if (parsed.success) return parsed.data;
  }
  return 'en';
}

export const EndInterviewBody = z.object({
  reason: z.enum(['CANDIDATE_ENDED']).default('CANDIDATE_ENDED'),
});
export type EndInterviewBody = z.infer<typeof EndInterviewBody>;

/** Server policy the room needs (grace and resume windows). */
export const LIVE_POLICY = {
  /** Disconnected longer than this: RECONNECTING → PAUSED. */
  reconnectGraceMs: 10 * 60_000,
  /** Paused longer than this: PAUSED → EXPIRED. */
  resumeWindowMs: 24 * 3600_000,
  /** Heartbeats every 10 s; no heartbeat for this long counts as disconnected. */
  heartbeatTimeoutMs: 45_000,
} as const;

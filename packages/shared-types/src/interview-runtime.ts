import { z } from 'zod';
import { InterviewState } from './interviews.js';
import { Difficulty, InterviewMode, RoundType } from './library.js';
import { InterviewLanguagePreference } from './users.js';

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
});
export type LiveQuestion = z.infer<typeof LiveQuestion>;

export const LiveTurn = z.object({
  seq: z.number().int(),
  questionId: z.string(),
  roundIdx: z.number().int(),
  question: z.string(),
  answer: z.string().nullable(),
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
  DRAINING: 'server:draining',
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
});
export type AnswerTextPayload = z.infer<typeof AnswerTextPayload>;

export const HeartbeatPayload = z.object({ sessionId: z.string().min(1).max(64) });

/** Acknowledgement for every client → server event. */
export type RtAck =
  | { ok: true; snapshot?: InterviewSnapshot; duplicate?: boolean }
  | { ok: false; code: RtErrorCode; message: string };

export const RtErrorCode = z.enum([
  'UNAUTHENTICATED',
  'NOT_FOUND',
  'INVALID_STATE',
  'VALIDATION_FAILED',
  'STALE_QUESTION',
  'BUSY',
  'INTERNAL',
]);
export type RtErrorCode = z.infer<typeof RtErrorCode>;

export const RoundTransitionEvent = z.object({
  fromRoundIdx: z.number().int(),
  toRoundIdx: z.number().int(),
  toRoundType: RoundType,
});
export type RoundTransitionEvent = z.infer<typeof RoundTransitionEvent>;

// ---- REST -----------------------------------------------------------------------------

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

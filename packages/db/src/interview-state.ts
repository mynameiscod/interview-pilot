import type { InterviewState } from '@cbi/shared-types';
import type { ClientSession, Types, UpdateQuery } from 'mongoose';
import { InterviewSessionModel, type InterviewSessionRecord } from './models/interview-session.js';

/**
 * Pre-interview transitions (Phase 3). The Phase 4 engine replaces this with
 * the full pure transition table; the persistence rules stay the same.
 */
export const PRE_INTERVIEW_TRANSITIONS: Readonly<
  Partial<Record<InterviewState, readonly InterviewState[]>>
> = {
  DRAFT: ['ROLE_ANALYSIS', 'CANCELLED'],
  ROLE_ANALYSIS: ['READY', 'FAILED'],
  READY: ['ROLE_ANALYSIS', 'CANCELLED'],
  FAILED: ['ROLE_ANALYSIS', 'CANCELLED'],
};

export const canTransition = (from: InterviewState, to: InterviewState) =>
  PRE_INTERVIEW_TRANSITIONS[from]?.includes(to) ?? false;

/** Entries kept on the session; the complete trail is in auditLogs. */
const HISTORY_LIMIT = 50;

export interface TransitionInput {
  sessionId: Types.ObjectId | string;
  from: InterviewState;
  to: InterviewState;
  /** Also require the owner (candidate-initiated transitions). */
  userId?: Types.ObjectId | string;
  /** Require this exact stateVersion (optimistic concurrency). */
  expectedVersion?: number;
  set?: Partial<InterviewSessionRecord>;
  reason?: string | null;
  now?: Date;
  session?: ClientSession;
}

/**
 * Applies one transition atomically: the update matches only while the
 * session is still in `from` (and at `expectedVersion`), so two concurrent
 * transitions can never both win. Returns null when the session moved on.
 */
export async function transitionSession(
  input: TransitionInput,
): Promise<InterviewSessionRecord | null> {
  if (!canTransition(input.from, input.to)) {
    throw new Error(`Invalid interview transition ${input.from} -> ${input.to}`);
  }
  const at = input.now ?? new Date();
  const filter: Record<string, unknown> = { _id: input.sessionId, state: input.from };
  if (input.userId !== undefined) filter.userId = input.userId;
  if (input.expectedVersion !== undefined) filter.stateVersion = input.expectedVersion;
  const update: UpdateQuery<InterviewSessionRecord> = {
    $set: { ...input.set, state: input.to },
    $inc: { stateVersion: 1 },
    $push: {
      stateHistory: {
        $each: [{ from: input.from, to: input.to, at, reason: input.reason ?? null }],
        $slice: -HISTORY_LIMIT,
      },
    },
  };
  return InterviewSessionModel.findOneAndUpdate(filter, update, {
    new: true,
    session: input.session,
  }).lean<InterviewSessionRecord>();
}

import {
  canTransition,
  elapsedMs,
  endCurrentRound,
  hasNextRound,
  IN_PROGRESS_STATES,
  isMeaningfulUsage,
  pauseClock,
  resumeClock,
  skipRemainingRounds,
  startClock,
  startNextRound,
  totalBudgetMs,
  transition,
  type ClockState,
  type SessionContext,
  type SessionEffect,
  type SessionEvent,
  type UsagePolicy,
} from '@cbi/interview-engine';
import type { InterviewState } from '@cbi/shared-types';
import type { ClientSession, Types, UpdateQuery } from 'mongoose';
import { inTransaction, reserveCredit, settleCredit } from './credits.js';
import {
  InterviewSessionModel,
  type InterviewSessionRecord,
  type SessionClockRecord,
} from './models/interview-session.js';

/** Entries kept on the session; the complete trail is in auditLogs. */
const HISTORY_LIMIT = 50;

const historyPush = (
  from: InterviewState,
  to: InterviewState,
  at: Date,
  reason: string | null,
) => ({
  stateHistory: { $each: [{ from, to, at, reason }], $slice: -HISTORY_LIMIT },
});

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
 * Applies one pre-interview transition atomically (used by role analysis).
 * The pair must be allowed by the engine's table. Returns null when the
 * session moved on.
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
    $set: { ...input.set, state: input.to, live: IN_PROGRESS_STATES.includes(input.to) },
    $inc: { stateVersion: 1 },
    $push: historyPush(input.from, input.to, at, input.reason ?? null),
  };
  return InterviewSessionModel.findOneAndUpdate(filter, update, {
    returnDocument: 'after',
    session: input.session,
  }).lean<InterviewSessionRecord>();
}

// ---- Live events -------------------------------------------------------------------------

const toClock = (c: SessionClockRecord): ClockState => ({
  budgetMs: c.budgetMs,
  activeMs: c.activeMs,
  runningSince: c.runningSince ? new Date(c.runningSince).getTime() : null,
});
const fromClock = (c: ClockState): SessionClockRecord => ({
  budgetMs: c.budgetMs,
  activeMs: c.activeMs,
  runningSince: c.runningSince === null ? null : new Date(c.runningSince),
});

/** Interview time used so far (0 before the start). */
export function sessionElapsedMs(s: Pick<InterviewSessionRecord, 'clock'>, now: Date): number {
  return s.clock ? elapsedMs(toClock(s.clock), now.getTime()) : 0;
}

export function sessionRemainingMs(s: Pick<InterviewSessionRecord, 'clock'>, now: Date): number {
  return s.clock ? Math.max(0, s.clock.budgetMs - sessionElapsedMs(s, now)) : 0;
}

/** The engine's view of a persisted session. */
export function sessionContext(
  s: InterviewSessionRecord,
  now: Date,
  policy?: UsagePolicy,
): SessionContext {
  return {
    needsDeviceCheck: s.mode !== 'TEXT',
    // Recording (and so consent) arrives with voice and video.
    needsConsent: s.mode !== 'TEXT',
    started: s.startedAt !== null || (s.credit?.status ?? 'NONE') !== 'NONE',
    creditReserved: s.credit?.status === 'RESERVED',
    hasNextRound: s.planner ? hasNextRound(s.planner) : false,
    resumeTo: s.resumeTo,
    meaningful: isMeaningfulUsage(
      {
        answeredCount: s.planner?.answeredCount ?? 0,
        activeMs: sessionElapsedMs(s, now),
        budgetMs: s.clock?.budgetMs ?? 0,
      },
      policy,
    ),
  };
}

export interface ApplyEventInput {
  sessionId: Types.ObjectId | string;
  event: SessionEvent;
  /** Also require the owner (candidate-initiated events). */
  userId?: Types.ObjectId | string;
  expectedVersion?: number;
  /** Fields to set with the transition (e.g. the planner when starting). */
  set?: Partial<InterviewSessionRecord>;
  reason?: string | null;
  endReason?: string | null;
  now?: Date;
  usagePolicy?: UsagePolicy;
  session?: ClientSession;
}

export type ApplyEventResult =
  | { ok: true; session: InterviewSessionRecord; effects: SessionEffect[] }
  | { ok: false; reason: 'NOT_FOUND' | 'INVALID_EVENT' | 'GUARD_FAILED' | 'CONFLICT' };

/** Effects left for the caller (jobs and question generation are not database work). */
const CALLER_EFFECTS = new Set<SessionEffect['type']>(['ENQUEUE_ANALYSIS', 'ENQUEUE_EVALUATION']);

/**
 * Runs one engine event against a persisted session in a transaction:
 * computes the transition, applies its database effects (credits, clock,
 * rounds, resume target) and saves, conditional on the stateVersion read.
 * Credit effects go through the idempotent credit ledger, so a retried or
 * duplicated event can never reserve or settle twice.
 */
export async function applySessionEvent(input: ApplyEventInput): Promise<ApplyEventResult> {
  const now = input.now ?? new Date();
  return inTransaction(input.session, async (tx) => {
    const filter: Record<string, unknown> = { _id: input.sessionId };
    if (input.userId !== undefined) filter.userId = input.userId;
    const s = await InterviewSessionModel.findOne(filter, null, { session: tx }).lean();
    if (!s) return { ok: false, reason: 'NOT_FOUND' } as const;
    if (input.expectedVersion !== undefined && s.stateVersion !== input.expectedVersion) {
      return { ok: false, reason: 'CONFLICT' } as const;
    }

    const working: InterviewSessionRecord = { ...s, ...input.set };
    const result = transition(
      s.state,
      input.event,
      sessionContext(working, now, input.usagePolicy),
    );
    if (!result.ok) return { ok: false, reason: result.reason } as const;

    const $set: Partial<InterviewSessionRecord> = { ...input.set };
    let clock = working.clock ? toClock(working.clock) : null;
    let planner = working.planner;
    const t = now.getTime();

    for (const effect of result.effects) {
      switch (effect.type) {
        case 'RESERVE_CREDIT': {
          const { lotId } = await reserveCredit(s.userId, s._id, { session: tx, now });
          $set.credit = { status: 'RESERVED', lotId };
          $set.startedAt = now;
          break;
        }
        case 'CONSUME_CREDIT':
        case 'REFUND_CREDIT': {
          const refund = effect.type === 'REFUND_CREDIT';
          await settleCredit(s.userId, s._id, refund ? 'REFUND' : 'CONSUME', {
            session: tx,
            reason: input.reason ?? null,
          });
          $set.credit = {
            status: refund ? 'REFUNDED' : 'CONSUMED',
            lotId: s.credit?.lotId ?? null,
          };
          break;
        }
        case 'START_CLOCK':
          if (!planner) throw new Error('cannot start an interview without a plan');
          clock = startClock(totalBudgetMs(planner), t);
          break;
        case 'PAUSE_CLOCK':
          if (clock) clock = pauseClock(clock, t);
          break;
        case 'RESUME_CLOCK':
          if (clock) clock = resumeClock(clock, t);
          break;
        case 'START_NEXT_ROUND':
          if (!planner) throw new Error('no plan');
          planner = startNextRound(planner, clock ? elapsedMs(clock, t) : 0);
          break;
        case 'END_ROUND':
          if (planner) {
            planner = endCurrentRound(
              planner,
              input.event.type === 'TIME_UP' ? 'TIMED_OUT' : 'COMPLETED',
            );
          }
          break;
        case 'REMEMBER_RESUME_TARGET':
          $set.resumeTo = effect.to;
          break;
        case 'ENQUEUE_ANALYSIS':
        case 'ENQUEUE_EVALUATION':
          break;
      }
    }

    const to = result.state;
    if (to === 'COMPLETING' && planner) planner = skipRemainingRounds(planner);
    if (clock) $set.clock = fromClock(clock);
    if (planner) $set.planner = planner;
    $set.live = IN_PROGRESS_STATES.includes(to);
    if (to === 'RECONNECTING') $set.disconnectedAt = now;
    if (to === 'PAUSED') $set.pausedAt = now;
    if (to === 'ACTIVE' || to === 'ROUND_TRANSITION') {
      $set.disconnectedAt = null;
      $set.pausedAt = null;
      $set.lastSeenAt = now;
      if (s.state === 'RECONNECTING' || s.state === 'PAUSED') $set.resumeTo = null;
    }
    if (to === 'COMPLETING' || to === 'EXPIRED' || (to === 'FAILED' && s.startedAt)) {
      $set.endedAt = s.endedAt ?? now;
      $set.endReason = s.endReason ?? input.endReason ?? input.event.type;
    }

    const updated = await InterviewSessionModel.findOneAndUpdate(
      { _id: s._id, stateVersion: s.stateVersion },
      {
        $set: { ...$set, state: to },
        $inc: { stateVersion: 1 },
        $push: historyPush(s.state, to, now, input.reason ?? input.event.type),
      },
      { returnDocument: 'after', session: tx },
    ).lean<InterviewSessionRecord>();
    if (!updated) return { ok: false, reason: 'CONFLICT' } as const;
    return {
      ok: true,
      session: updated,
      effects: result.effects.filter((e) => CALLER_EFFECTS.has(e.type)),
    } as const;
  });
}

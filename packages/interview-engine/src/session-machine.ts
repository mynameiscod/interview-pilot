import { InterviewState } from '@cbi/shared-types';

/**
 * The interview session state machine (design §6.1) as a pure table:
 * `(state, event, context) → (state, effects)`. No I/O happens here; the
 * API and worker persist the new state with optimistic concurrency and then
 * carry out the effects (credits, clock, rounds, jobs).
 */

export type SessionEvent =
  | { type: 'ANALYZE' }
  | { type: 'ANALYSIS_SUCCEEDED' }
  | { type: 'ANALYSIS_FAILED' }
  /** Leave READY for the pre-start checks (or straight to READY_TO_START). */
  | { type: 'PREPARE' }
  | { type: 'DEVICE_CHECK_PASSED' }
  | { type: 'CONSENT_ACCEPTED' }
  | { type: 'START' }
  /** The current round has no more questions (or time). */
  | { type: 'ROUND_ENDED' }
  | { type: 'NEXT_ROUND' }
  | { type: 'DISCONNECTED' }
  | { type: 'RECONNECTED' }
  | { type: 'GRACE_EXPIRED' }
  | { type: 'RESUME' }
  | { type: 'RESUME_WINDOW_EXPIRED' }
  | { type: 'END_REQUESTED' }
  | { type: 'TIME_UP' }
  /** COMPLETING → PROCESSING once the last turn is saved. */
  | { type: 'FINALIZE' }
  /** EXPIRED → PROCESSING when the partial interview is worth evaluating. */
  | { type: 'PROCESS' }
  | { type: 'EVALUATION_COMPLETED' }
  | { type: 'CANCEL' }
  /** Unrecoverable error (provider outage, internal fault). */
  | { type: 'FAIL' };

export type SessionEventType = SessionEvent['type'];

export const SESSION_EVENT_TYPES: readonly SessionEventType[] = [
  'ANALYZE',
  'ANALYSIS_SUCCEEDED',
  'ANALYSIS_FAILED',
  'PREPARE',
  'DEVICE_CHECK_PASSED',
  'CONSENT_ACCEPTED',
  'START',
  'ROUND_ENDED',
  'NEXT_ROUND',
  'DISCONNECTED',
  'RECONNECTED',
  'GRACE_EXPIRED',
  'RESUME',
  'RESUME_WINDOW_EXPIRED',
  'END_REQUESTED',
  'TIME_UP',
  'FINALIZE',
  'PROCESS',
  'EVALUATION_COMPLETED',
  'CANCEL',
  'FAIL',
];

/** Facts about the session the table needs; all derived from the persisted record. */
export interface SessionContext {
  /** Voice and video need a device check; text does not. */
  needsDeviceCheck: boolean;
  /** Recording (Phase 8) needs consent; text interviews without recording do not. */
  needsConsent: boolean;
  /** The interview has started (a credit was reserved at some point). */
  started: boolean;
  /** A reserved credit is still waiting to be consumed or refunded. */
  creditReserved: boolean;
  /** Another round follows the current one. */
  hasNextRound: boolean;
  /** The state to return to after RECONNECTING or PAUSED. */
  resumeTo: 'ACTIVE' | 'ROUND_TRANSITION' | null;
  /** Enough of the interview happened to evaluate it and consume the credit. */
  meaningful: boolean;
}

export type SessionEffect =
  | { type: 'RESERVE_CREDIT' }
  | { type: 'CONSUME_CREDIT' }
  | { type: 'REFUND_CREDIT' }
  | { type: 'START_CLOCK' }
  | { type: 'PAUSE_CLOCK' }
  | { type: 'RESUME_CLOCK' }
  | { type: 'START_NEXT_ROUND' }
  | { type: 'END_ROUND' }
  | { type: 'ENQUEUE_ANALYSIS' }
  | { type: 'ENQUEUE_EVALUATION' }
  /** Remember where to return after a disconnect or pause. */
  | { type: 'REMEMBER_RESUME_TARGET'; to: 'ACTIVE' | 'ROUND_TRANSITION' };

export type TransitionResult =
  | { ok: true; state: InterviewState; effects: SessionEffect[] }
  | { ok: false; reason: 'INVALID_EVENT' | 'GUARD_FAILED' };

/** States in which the interview clock may be running. */
export const LIVE_STATES: readonly InterviewState[] = ['ACTIVE', 'ROUND_TRANSITION'];
/** States that count as "one live interview" per candidate. */
export const IN_PROGRESS_STATES: readonly InterviewState[] = [
  'ACTIVE',
  'ROUND_TRANSITION',
  'RECONNECTING',
  'PAUSED',
  'COMPLETING',
];
export const TERMINAL_STATES: readonly InterviewState[] = ['REPORT_READY', 'CANCELLED', 'FAILED'];
const PRE_START_STATES: readonly InterviewState[] = [
  'DRAFT',
  'READY',
  'DEVICE_CHECK',
  'CONSENT_REQUIRED',
  'READY_TO_START',
];

const ok = (state: InterviewState, effects: SessionEffect[] = []): TransitionResult => ({
  ok: true,
  state,
  effects,
});
const invalid: TransitionResult = { ok: false, reason: 'INVALID_EVENT' };
const guardFailed: TransitionResult = { ok: false, reason: 'GUARD_FAILED' };

/** After the pre-start checks that apply, the next state on the way to READY_TO_START. */
function afterDeviceCheck(ctx: SessionContext): InterviewState {
  return ctx.needsConsent ? 'CONSENT_REQUIRED' : 'READY_TO_START';
}

/** Credit settlement when the interview stops: consume if meaningful, otherwise refund. */
function settle(ctx: SessionContext): SessionEffect[] {
  if (!ctx.creditReserved) return [];
  return [{ type: ctx.meaningful ? 'CONSUME_CREDIT' : 'REFUND_CREDIT' }];
}

export function transition(
  state: InterviewState,
  event: SessionEvent,
  ctx: SessionContext,
): TransitionResult {
  switch (event.type) {
    case 'ANALYZE':
      if (state === 'DRAFT' || state === 'READY')
        return ok('ROLE_ANALYSIS', [{ type: 'ENQUEUE_ANALYSIS' }]);
      // Only an analysis failure can be retried; a failed interview cannot.
      if (state === 'FAILED') {
        return ctx.started ? guardFailed : ok('ROLE_ANALYSIS', [{ type: 'ENQUEUE_ANALYSIS' }]);
      }
      return invalid;

    case 'ANALYSIS_SUCCEEDED':
      return state === 'ROLE_ANALYSIS' ? ok('READY') : invalid;

    case 'ANALYSIS_FAILED':
      return state === 'ROLE_ANALYSIS' ? ok('FAILED') : invalid;

    case 'PREPARE':
      if (state !== 'READY') return invalid;
      return ok(ctx.needsDeviceCheck ? 'DEVICE_CHECK' : afterDeviceCheck(ctx));

    case 'DEVICE_CHECK_PASSED':
      return state === 'DEVICE_CHECK' ? ok(afterDeviceCheck(ctx)) : invalid;

    case 'CONSENT_ACCEPTED':
      return state === 'CONSENT_REQUIRED' ? ok('READY_TO_START') : invalid;

    case 'START':
      if (state !== 'READY_TO_START') return invalid;
      return ok('ACTIVE', [
        { type: 'RESERVE_CREDIT' },
        { type: 'START_CLOCK' },
        { type: 'START_NEXT_ROUND' },
      ]);

    case 'ROUND_ENDED':
      if (state !== 'ACTIVE') return invalid;
      return ctx.hasNextRound
        ? ok('ROUND_TRANSITION', [{ type: 'END_ROUND' }])
        : ok('COMPLETING', [{ type: 'END_ROUND' }, { type: 'PAUSE_CLOCK' }]);

    case 'NEXT_ROUND':
      if (state !== 'ROUND_TRANSITION') return invalid;
      return ctx.hasNextRound ? ok('ACTIVE', [{ type: 'START_NEXT_ROUND' }]) : guardFailed;

    case 'DISCONNECTED':
      if (state !== 'ACTIVE' && state !== 'ROUND_TRANSITION') return invalid;
      return ok('RECONNECTING', [
        { type: 'PAUSE_CLOCK' },
        { type: 'REMEMBER_RESUME_TARGET', to: state },
      ]);

    case 'RECONNECTED':
      if (state !== 'RECONNECTING') return invalid;
      return ctx.resumeTo ? ok(ctx.resumeTo, [{ type: 'RESUME_CLOCK' }]) : guardFailed;

    case 'GRACE_EXPIRED':
      return state === 'RECONNECTING' ? ok('PAUSED') : invalid;

    case 'RESUME':
      if (state !== 'PAUSED') return invalid;
      return ctx.resumeTo ? ok(ctx.resumeTo, [{ type: 'RESUME_CLOCK' }]) : guardFailed;

    case 'RESUME_WINDOW_EXPIRED':
      if (state !== 'PAUSED') return invalid;
      return ok('EXPIRED', settle(ctx));

    case 'END_REQUESTED':
      if (state === 'ACTIVE' || state === 'ROUND_TRANSITION') {
        return ok('COMPLETING', [{ type: 'END_ROUND' }, { type: 'PAUSE_CLOCK' }]);
      }
      // A paused interview can be finished early instead of waiting for the window to expire.
      if (state === 'RECONNECTING' || state === 'PAUSED') {
        return ok('COMPLETING', [{ type: 'END_ROUND' }]);
      }
      return invalid;

    case 'TIME_UP':
      if (state === 'ACTIVE' || state === 'ROUND_TRANSITION') {
        return ok('COMPLETING', [{ type: 'END_ROUND' }, { type: 'PAUSE_CLOCK' }]);
      }
      // The clock is already stopped while reconnecting.
      if (state === 'RECONNECTING') return ok('COMPLETING', [{ type: 'END_ROUND' }]);
      return invalid;

    case 'FINALIZE':
      if (state !== 'COMPLETING') return invalid;
      return ok('PROCESSING', [...settle(ctx), { type: 'ENQUEUE_EVALUATION' }]);

    case 'PROCESS':
      if (state !== 'EXPIRED') return invalid;
      return ctx.meaningful ? ok('PROCESSING', [{ type: 'ENQUEUE_EVALUATION' }]) : guardFailed;

    case 'EVALUATION_COMPLETED':
      return state === 'PROCESSING' ? ok('REPORT_READY') : invalid;

    case 'CANCEL':
      if (PRE_START_STATES.includes(state)) return ok('CANCELLED');
      // A failed analysis can be abandoned; a failed interview stays FAILED.
      if (state === 'FAILED' && !ctx.started) return ok('CANCELLED');
      return invalid;

    case 'FAIL':
      if (IN_PROGRESS_STATES.includes(state) || state === 'PROCESSING') {
        // Provider or platform failures never cost the candidate a credit.
        return ok('FAILED', [
          ...(LIVE_STATES.includes(state) ? [{ type: 'PAUSE_CLOCK' } as const] : []),
          ...(ctx.creditReserved ? [{ type: 'REFUND_CREDIT' } as const] : []),
        ]);
      }
      return invalid;
  }
}

/** The events that can ever succeed from `state` (under some context). */
export function eventsFrom(state: InterviewState): SessionEventType[] {
  return SESSION_EVENT_TYPES.filter((type) =>
    CONTEXT_VARIANTS.some((ctx) => transition(state, { type } as SessionEvent, ctx).ok),
  );
}

/** Every boolean combination of the context, used to derive the reachable graph. */
export const CONTEXT_VARIANTS: readonly SessionContext[] = (() => {
  const out: SessionContext[] = [];
  for (let bits = 0; bits < 64; bits++) {
    for (const resumeTo of ['ACTIVE', 'ROUND_TRANSITION', null] as const) {
      out.push({
        needsDeviceCheck: Boolean(bits & 1),
        needsConsent: Boolean(bits & 2),
        started: Boolean(bits & 4),
        creditReserved: Boolean(bits & 8),
        hasNextRound: Boolean(bits & 16),
        meaningful: Boolean(bits & 32),
        resumeTo,
      });
    }
  }
  return out;
})();

/** All `from → to` pairs the table can produce; persistence refuses anything else. */
export const ALLOWED_TRANSITIONS: ReadonlyMap<
  InterviewState,
  ReadonlySet<InterviewState>
> = (() => {
  const map = new Map<InterviewState, Set<InterviewState>>();
  for (const from of InterviewState.options) {
    const targets = new Set<InterviewState>();
    for (const type of SESSION_EVENT_TYPES) {
      for (const ctx of CONTEXT_VARIANTS) {
        const result = transition(from, { type } as SessionEvent, ctx);
        if (result.ok) targets.add(result.state);
      }
    }
    map.set(from, targets);
  }
  return map;
})();

export const canTransition = (from: InterviewState, to: InterviewState) =>
  ALLOWED_TRANSITIONS.get(from)?.has(to) ?? false;

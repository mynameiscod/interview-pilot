import type { BreakerState } from '@cbi/shared-types';

export interface BreakerPolicy {
  /** Failures within `windowMs` that open the circuit. */
  failureThreshold: number;
  windowMs: number;
  /** How long the circuit stays open before one probe call is allowed. */
  openMs: number;
}

export const DEFAULT_BREAKER_POLICY: BreakerPolicy = {
  failureThreshold: 5,
  windowMs: 60_000,
  openMs: 30_000,
};

export interface BreakerSnapshot {
  state: BreakerState;
  failures: number;
  windowStartedAt: number;
  openedAt: number | null;
}

export const closedBreaker = (now: number): BreakerSnapshot => ({
  state: 'CLOSED',
  failures: 0,
  windowStartedAt: now,
  openedAt: null,
});

/**
 * Pure circuit-breaker state machine.
 *
 *   CLOSED ──(threshold failures in window)──▶ OPEN
 *   OPEN ──(openMs elapsed; next call is a probe)──▶ HALF_OPEN
 *   HALF_OPEN ──success──▶ CLOSED     HALF_OPEN ──failure──▶ OPEN
 */
export function effectiveState(
  snap: BreakerSnapshot,
  now: number,
  policy: BreakerPolicy,
): BreakerState {
  if (snap.state === 'OPEN' && snap.openedAt !== null && now - snap.openedAt >= policy.openMs) {
    return 'HALF_OPEN';
  }
  return snap.state;
}

export function recordBreakerEvent(
  snap: BreakerSnapshot,
  event: 'success' | 'failure',
  now: number,
  policy: BreakerPolicy,
): BreakerSnapshot {
  const state = effectiveState(snap, now, policy);
  if (event === 'success') {
    return state === 'CLOSED' ? snap : closedBreaker(now);
  }
  if (state === 'HALF_OPEN' || state === 'OPEN') {
    // A failed probe re-opens for another full period.
    return {
      state: 'OPEN',
      failures: policy.failureThreshold,
      windowStartedAt: now,
      openedAt: now,
    };
  }
  const inWindow = now - snap.windowStartedAt < policy.windowMs;
  const failures = inWindow ? snap.failures + 1 : 1;
  const windowStartedAt = inWindow ? snap.windowStartedAt : now;
  if (failures >= policy.failureThreshold) {
    return { state: 'OPEN', failures, windowStartedAt, openedAt: now };
  }
  return { state: 'CLOSED', failures, windowStartedAt, openedAt: null };
}

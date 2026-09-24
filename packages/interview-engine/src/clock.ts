/**
 * The interview clock. The server is authoritative: time accrues only while
 * the clock runs (ACTIVE and ROUND_TRANSITION), so reconnecting and pauses
 * never use up the candidate's interview time. Times are epoch milliseconds.
 */
export interface ClockState {
  budgetMs: number;
  /** Time used before the current run. */
  activeMs: number;
  /** When the current run began, or null while stopped. */
  runningSince: number | null;
}

export function startClock(budgetMs: number, now: number): ClockState {
  if (!Number.isFinite(budgetMs) || budgetMs <= 0) throw new Error('budget must be positive');
  return { budgetMs, activeMs: 0, runningSince: now };
}

/** Time used so far, including the current run. Never negative, even if clocks skew. */
export function elapsedMs(clock: ClockState, now: number): number {
  const running = clock.runningSince === null ? 0 : Math.max(0, now - clock.runningSince);
  return clock.activeMs + running;
}

export function remainingMs(clock: ClockState, now: number): number {
  return Math.max(0, clock.budgetMs - elapsedMs(clock, now));
}

export const isTimeUp = (clock: ClockState, now: number) => remainingMs(clock, now) === 0;

/** Stops the clock, folding the current run into `activeMs`. Idempotent. */
export function pauseClock(clock: ClockState, now: number): ClockState {
  if (clock.runningSince === null) return clock;
  return { ...clock, activeMs: elapsedMs(clock, now), runningSince: null };
}

/** Restarts a stopped clock. Idempotent. */
export function resumeClock(clock: ClockState, now: number): ClockState {
  if (clock.runningSince !== null) return clock;
  return { ...clock, runningSince: now };
}

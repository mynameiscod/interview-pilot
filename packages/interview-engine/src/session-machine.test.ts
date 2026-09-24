import { InterviewState } from '@cbi/shared-types';
import { describe, expect, it } from 'vitest';
import {
  ALLOWED_TRANSITIONS,
  canTransition,
  CONTEXT_VARIANTS,
  eventsFrom,
  SESSION_EVENT_TYPES,
  TERMINAL_STATES,
  transition,
  type SessionContext,
  type SessionEffect,
  type SessionEvent,
  type SessionEventType,
} from './session-machine.js';

type S = InterviewState;
type Expect = { to: S; effects: SessionEffect['type'][] } | 'INVALID' | 'GUARD';

const settle = (c: SessionContext): SessionEffect['type'][] =>
  c.creditReserved ? [c.meaningful ? 'CONSUME_CREDIT' : 'REFUND_CREDIT'] : [];

/**
 * The specification, written independently of the implementation as one
 * rule per (event, state). Anything not listed must be rejected as INVALID.
 */
const SPEC: Record<SessionEventType, Partial<Record<S, (c: SessionContext) => Expect>>> = {
  ANALYZE: {
    DRAFT: () => ({ to: 'ROLE_ANALYSIS', effects: ['ENQUEUE_ANALYSIS'] }),
    READY: () => ({ to: 'ROLE_ANALYSIS', effects: ['ENQUEUE_ANALYSIS'] }),
    FAILED: (c) => (c.started ? 'GUARD' : { to: 'ROLE_ANALYSIS', effects: ['ENQUEUE_ANALYSIS'] }),
  },
  ANALYSIS_SUCCEEDED: { ROLE_ANALYSIS: () => ({ to: 'READY', effects: [] }) },
  ANALYSIS_FAILED: { ROLE_ANALYSIS: () => ({ to: 'FAILED', effects: [] }) },
  PREPARE: {
    READY: (c) => ({
      to: c.needsDeviceCheck
        ? 'DEVICE_CHECK'
        : c.needsConsent
          ? 'CONSENT_REQUIRED'
          : 'READY_TO_START',
      effects: [],
    }),
  },
  DEVICE_CHECK_PASSED: {
    DEVICE_CHECK: (c) => ({
      to: c.needsConsent ? 'CONSENT_REQUIRED' : 'READY_TO_START',
      effects: [],
    }),
  },
  CONSENT_ACCEPTED: { CONSENT_REQUIRED: () => ({ to: 'READY_TO_START', effects: [] }) },
  START: {
    READY_TO_START: () => ({
      to: 'ACTIVE',
      effects: ['RESERVE_CREDIT', 'START_CLOCK', 'START_NEXT_ROUND'],
    }),
  },
  ROUND_ENDED: {
    ACTIVE: (c) =>
      c.hasNextRound
        ? { to: 'ROUND_TRANSITION', effects: ['END_ROUND'] }
        : { to: 'COMPLETING', effects: ['END_ROUND', 'PAUSE_CLOCK'] },
  },
  NEXT_ROUND: {
    ROUND_TRANSITION: (c) =>
      c.hasNextRound ? { to: 'ACTIVE', effects: ['START_NEXT_ROUND'] } : 'GUARD',
  },
  DISCONNECTED: {
    ACTIVE: () => ({ to: 'RECONNECTING', effects: ['PAUSE_CLOCK', 'REMEMBER_RESUME_TARGET'] }),
    ROUND_TRANSITION: () => ({
      to: 'RECONNECTING',
      effects: ['PAUSE_CLOCK', 'REMEMBER_RESUME_TARGET'],
    }),
  },
  RECONNECTED: {
    RECONNECTING: (c) => (c.resumeTo ? { to: c.resumeTo, effects: ['RESUME_CLOCK'] } : 'GUARD'),
  },
  GRACE_EXPIRED: { RECONNECTING: () => ({ to: 'PAUSED', effects: [] }) },
  RESUME: { PAUSED: (c) => (c.resumeTo ? { to: c.resumeTo, effects: ['RESUME_CLOCK'] } : 'GUARD') },
  RESUME_WINDOW_EXPIRED: { PAUSED: (c) => ({ to: 'EXPIRED', effects: settle(c) }) },
  END_REQUESTED: {
    ACTIVE: () => ({ to: 'COMPLETING', effects: ['END_ROUND', 'PAUSE_CLOCK'] }),
    ROUND_TRANSITION: () => ({ to: 'COMPLETING', effects: ['END_ROUND', 'PAUSE_CLOCK'] }),
    RECONNECTING: () => ({ to: 'COMPLETING', effects: ['END_ROUND'] }),
    PAUSED: () => ({ to: 'COMPLETING', effects: ['END_ROUND'] }),
  },
  TIME_UP: {
    ACTIVE: () => ({ to: 'COMPLETING', effects: ['END_ROUND', 'PAUSE_CLOCK'] }),
    ROUND_TRANSITION: () => ({ to: 'COMPLETING', effects: ['END_ROUND', 'PAUSE_CLOCK'] }),
    RECONNECTING: () => ({ to: 'COMPLETING', effects: ['END_ROUND'] }),
  },
  FINALIZE: {
    COMPLETING: (c) => ({ to: 'PROCESSING', effects: [...settle(c), 'ENQUEUE_EVALUATION'] }),
  },
  PROCESS: {
    EXPIRED: (c) =>
      c.meaningful ? { to: 'PROCESSING', effects: ['ENQUEUE_EVALUATION'] } : 'GUARD',
  },
  EVALUATION_COMPLETED: { PROCESSING: () => ({ to: 'REPORT_READY', effects: [] }) },
  CANCEL: {
    DRAFT: () => ({ to: 'CANCELLED', effects: [] }),
    READY: () => ({ to: 'CANCELLED', effects: [] }),
    DEVICE_CHECK: () => ({ to: 'CANCELLED', effects: [] }),
    CONSENT_REQUIRED: () => ({ to: 'CANCELLED', effects: [] }),
    READY_TO_START: () => ({ to: 'CANCELLED', effects: [] }),
    FAILED: (c) => (c.started ? 'INVALID' : { to: 'CANCELLED', effects: [] }),
  },
  FAIL: Object.fromEntries(
    (
      ['ACTIVE', 'ROUND_TRANSITION', 'RECONNECTING', 'PAUSED', 'COMPLETING', 'PROCESSING'] as const
    ).map((s) => [
      s,
      (c: SessionContext): Expect => ({
        to: 'FAILED',
        effects: [
          ...(s === 'ACTIVE' || s === 'ROUND_TRANSITION' ? (['PAUSE_CLOCK'] as const) : []),
          ...(c.creditReserved ? (['REFUND_CREDIT'] as const) : []),
        ],
      }),
    ]),
  ),
};

describe('transition table (exhaustive)', () => {
  it('covers every event type', () => {
    expect(Object.keys(SPEC).sort()).toEqual([...SESSION_EVENT_TYPES].sort());
  });

  it(`matches the specification for all ${InterviewState.options.length} states x ${SESSION_EVENT_TYPES.length} events x ${CONTEXT_VARIANTS.length} contexts`, () => {
    let checked = 0;
    for (const state of InterviewState.options) {
      for (const type of SESSION_EVENT_TYPES) {
        const rule = SPEC[type][state];
        for (const ctx of CONTEXT_VARIANTS) {
          const expected: Expect = rule ? rule(ctx) : 'INVALID';
          const actual = transition(state, { type } as SessionEvent, ctx);
          if (expected === 'INVALID') {
            expect(actual, `${state} + ${type}`).toEqual({ ok: false, reason: 'INVALID_EVENT' });
          } else if (expected === 'GUARD') {
            expect(actual, `${state} + ${type}`).toEqual({ ok: false, reason: 'GUARD_FAILED' });
          } else {
            expect(actual.ok, `${state} + ${type}`).toBe(true);
            if (!actual.ok) continue;
            expect(actual.state, `${state} + ${type}`).toBe(expected.to);
            expect(
              actual.effects.map((e) => e.type),
              `${state} + ${type}`,
            ).toEqual(expected.effects);
          }
          checked++;
        }
      }
    }
    expect(checked).toBe(
      InterviewState.options.length * SESSION_EVENT_TYPES.length * CONTEXT_VARIANTS.length,
    );
    // ~13k transitions: well under a second alone, but slower while turbo runs every suite.
  }, 30_000);

  it('remembers where to resume after a disconnect', () => {
    const ctx = CONTEXT_VARIANTS[0]!;
    for (const from of ['ACTIVE', 'ROUND_TRANSITION'] as const) {
      const r = transition(from, { type: 'DISCONNECTED' }, ctx);
      expect(r.ok && r.effects).toContainEqual({ type: 'REMEMBER_RESUME_TARGET', to: from });
    }
  });
});

describe('graph properties', () => {
  const terminal = new Set<S>(TERMINAL_STATES);

  it('terminal states have no way out', () => {
    for (const state of TERMINAL_STATES) {
      // FAILED can only leave when the interview never started (analysis retry or cancel).
      const leaving = CONTEXT_VARIANTS.filter((c) => c.started).flatMap((ctx) =>
        SESSION_EVENT_TYPES.filter((type) => transition(state, { type } as SessionEvent, ctx).ok),
      );
      expect(leaving, state).toEqual([]);
    }
  });

  it('every state is reachable from DRAFT', () => {
    const seen = new Set<S>(['DRAFT']);
    const queue: S[] = ['DRAFT'];
    while (queue.length) {
      for (const to of ALLOWED_TRANSITIONS.get(queue.shift()!)!) {
        if (!seen.has(to)) {
          seen.add(to);
          queue.push(to);
        }
      }
    }
    expect([...seen].sort()).toEqual([...InterviewState.options].sort());
  });

  it('every non-terminal state can still finish', () => {
    for (const start of InterviewState.options) {
      if (terminal.has(start)) continue;
      const seen = new Set<S>([start]);
      const queue: S[] = [start];
      let finishes = false;
      while (queue.length && !finishes) {
        for (const to of ALLOWED_TRANSITIONS.get(queue.shift()!)!) {
          if (terminal.has(to)) finishes = true;
          if (!seen.has(to)) {
            seen.add(to);
            queue.push(to);
          }
        }
      }
      expect(finishes, start).toBe(true);
    }
  });

  it('keeps the Phase 3 transitions', () => {
    for (const [from, to] of [
      ['DRAFT', 'ROLE_ANALYSIS'],
      ['ROLE_ANALYSIS', 'READY'],
      ['ROLE_ANALYSIS', 'FAILED'],
      ['READY', 'ROLE_ANALYSIS'],
      ['FAILED', 'ROLE_ANALYSIS'],
      ['DRAFT', 'CANCELLED'],
      ['READY', 'CANCELLED'],
      ['FAILED', 'CANCELLED'],
    ] as const) {
      expect(canTransition(from, to), `${from} -> ${to}`).toBe(true);
    }
    expect(canTransition('ACTIVE', 'READY')).toBe(false);
    expect(canTransition('REPORT_READY', 'ACTIVE')).toBe(false);
  });

  it('lists the events that can leave a state', () => {
    expect(eventsFrom('READY_TO_START').sort()).toEqual(['CANCEL', 'START']);
    expect(eventsFrom('REPORT_READY')).toEqual([]);
  });
});

/** Deterministic PRNG so failures are reproducible. */
function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('random walks (credits and clock stay consistent)', () => {
  it('never double-reserves, double-settles or misuses the clock', () => {
    const random = mulberry32(20260924);
    const ROUNDS = 3;
    for (let walk = 0; walk < 3000; walk++) {
      let state: S = 'DRAFT';
      let reserved = 0;
      let settled = 0;
      let running = false;
      let started = false;
      let roundsStarted = 0;
      let resumeTo: SessionContext['resumeTo'] = null;
      const needsDeviceCheck = random() < 0.3;
      const needsConsent = random() < 0.3;
      for (let step = 0; step < 60 && !TERMINAL_STATES.includes(state); step++) {
        const ctx: SessionContext = {
          needsDeviceCheck,
          needsConsent,
          started,
          creditReserved: reserved > settled,
          hasNextRound: roundsStarted < ROUNDS,
          resumeTo,
          meaningful: random() < 0.5,
        };
        const type = SESSION_EVENT_TYPES[Math.floor(random() * SESSION_EVENT_TYPES.length)]!;
        const result = transition(state, { type } as SessionEvent, ctx);
        if (!result.ok) continue;
        for (const effect of result.effects) {
          switch (effect.type) {
            case 'RESERVE_CREDIT':
              reserved++;
              started = true;
              break;
            case 'CONSUME_CREDIT':
            case 'REFUND_CREDIT':
              settled++;
              break;
            case 'START_CLOCK':
            case 'RESUME_CLOCK':
              expect(running, `${state} ${type}: clock already running`).toBe(false);
              running = true;
              break;
            case 'PAUSE_CLOCK':
              expect(running, `${state} ${type}: clock not running`).toBe(true);
              running = false;
              break;
            case 'START_NEXT_ROUND':
              roundsStarted++;
              break;
            case 'REMEMBER_RESUME_TARGET':
              resumeTo = effect.to;
              break;
          }
        }
        state = result.state;
        expect(reserved).toBeLessThanOrEqual(1);
        expect(settled).toBeLessThanOrEqual(reserved);
        expect(roundsStarted).toBeLessThanOrEqual(ROUNDS + 1);
        // The clock only runs while the interview is live.
        expect(running).toBe(state === 'ACTIVE' || state === 'ROUND_TRANSITION');
      }
      // Once an interview that started has stopped for good, its credit is settled.
      if (reserved === 1 && ['PROCESSING', 'REPORT_READY', 'FAILED', 'EXPIRED'].includes(state)) {
        expect(settled, `walk ${walk} ended in ${state}`).toBe(1);
      }
    }
  });
});

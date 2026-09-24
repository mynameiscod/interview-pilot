import type { BlueprintContent, TemplateRound, TurnSufficiency } from '@cbi/shared-types';
import { describe, expect, it } from 'vitest';
import { elapsedMs, isTimeUp, pauseClock, remainingMs, resumeClock, startClock } from './clock.js';
import {
  competenciesForRound,
  createPlanner,
  currentRound,
  endCurrentRound,
  hasNextRound,
  MIN_QUESTION_MS,
  nextStep,
  recordAssessment,
  recordQuestion,
  skipRemainingRounds,
  startNextRound,
  totalBudgetMs,
  type PlannerState,
} from './planner.js';
import { isMeaningfulUsage } from './usage.js';

type Competency = BlueprintContent['competencies'][number];

const competency = (key: string, weight: number, extra: Partial<Competency> = {}): Competency => ({
  key,
  name: key.replace(/-/g, ' '),
  category: 'TECHNICAL',
  weight,
  description: `${key} description`,
  subCompetencies: [],
  expectedEvidence: [`${key} evidence`],
  difficulty: 'MEDIUM',
  roundTypes: ['TECHNICAL'],
  ...extra,
});

const BLUEPRINT: Pick<BlueprintContent, 'competencies' | 'probeAreas'> = {
  competencies: [
    competency('api-design', 30),
    competency('data-modelling', 25),
    competency('system-design', 20, {
      difficulty: 'HARD',
      roundTypes: ['TECHNICAL', 'PROBLEM_SOLVING'],
    }),
    competency('debugging', 10, { category: 'PROBLEM_SOLVING', roundTypes: ['PROBLEM_SOLVING'] }),
    competency('collaboration', 15, { category: 'BEHAVIORAL', roundTypes: ['BEHAVIORAL'] }),
  ],
  probeAreas: [
    { topic: 'Payments ledger', reason: 'Resume claims 2M transactions a day', source: 'RESUME' },
    { topic: 'Kubernetes', reason: 'Required by the JD, not shown in the resume', source: 'JD' },
  ],
};

const round = (type: TemplateRound['type'], extra: Partial<TemplateRound> = {}): TemplateRound => ({
  type,
  durationSec: 600,
  questionCount: 2,
  difficulty: 'MEDIUM',
  followUpDepth: 1,
  minEvidence: 1,
  ...extra,
});

const ROUNDS: TemplateRound[] = [
  round('INTRO', { durationSec: 180, questionCount: 1, difficulty: 'EASY', followUpDepth: 0 }),
  round('TECHNICAL', {
    durationSec: 720,
    questionCount: 4,
    difficulty: 'ADAPTIVE',
    followUpDepth: 2,
  }),
  round('PROBLEM_SOLVING', { durationSec: 540, questionCount: 2, difficulty: 'ADAPTIVE' }),
  round('BEHAVIORAL', { durationSec: 360, questionCount: 2 }),
  round('WRAP_UP', { durationSec: 120, questionCount: 1, difficulty: 'EASY', followUpDepth: 0 }),
];

function started(rounds = ROUNDS): PlannerState {
  return startNextRound(createPlanner(rounds, BLUEPRINT.competencies), 0);
}

function ask(p: PlannerState, elapsed: number, id: string) {
  const step = nextStep(p, BLUEPRINT, elapsed);
  if (step.kind !== 'ASK') throw new Error(`expected a question, got ${step.reason}`);
  return { p: recordQuestion(p, step.target, id), target: step.target };
}

const assess = (
  sufficiency: TurnSufficiency,
  followUpNeeded = false,
  angle: string | null = null,
) => ({
  sufficiency,
  followUpNeeded,
  followUpAngle: angle,
  evidenceCount: sufficiency === 'NO_ANSWER' ? 0 : 1,
});

describe('clock', () => {
  it('accrues only while running', () => {
    let c = startClock(60_000, 1000);
    expect(elapsedMs(c, 11_000)).toBe(10_000);
    c = pauseClock(c, 11_000);
    expect(elapsedMs(c, 500_000)).toBe(10_000);
    expect(pauseClock(c, 600_000)).toBe(c); // idempotent
    c = resumeClock(c, 500_000);
    expect(resumeClock(c, 700_000)).toBe(c);
    expect(elapsedMs(c, 520_000)).toBe(30_000);
    expect(remainingMs(c, 520_000)).toBe(30_000);
    expect(isTimeUp(c, 550_000)).toBe(true);
    expect(remainingMs(c, 900_000)).toBe(0);
  });

  it('ignores clock skew and rejects bad budgets', () => {
    const c = startClock(60_000, 10_000);
    expect(elapsedMs(c, 5_000)).toBe(0);
    expect(() => startClock(0, 0)).toThrow();
  });
});

describe('usage', () => {
  it.each([
    [{ answeredCount: 0, activeMs: 1_000_000, budgetMs: 1_000_000 }, false],
    [{ answeredCount: 3, activeMs: 0, budgetMs: 1_000_000 }, true],
    [{ answeredCount: 1, activeMs: 400_000, budgetMs: 1_000_000 }, true],
    [{ answeredCount: 2, activeMs: 399_999, budgetMs: 1_000_000 }, false],
  ])('%j meaningful=%s', (facts, expected) => expect(isMeaningfulUsage(facts)).toBe(expected));
});

describe('planner basics', () => {
  it('starts before the first round and sums the budget', () => {
    const p = createPlanner(ROUNDS, BLUEPRINT.competencies);
    expect(p.roundIdx).toBe(-1);
    expect(currentRound(p)).toBeNull();
    expect(totalBudgetMs(p)).toBe((180 + 720 + 540 + 360 + 120) * 1000);
    expect(() => createPlanner([], [])).toThrow();
  });

  it('opens the intro with a warm-up and no competency', () => {
    const step = nextStep(started(), BLUEPRINT, 0);
    expect(step).toMatchObject({
      kind: 'ASK',
      target: {
        roundType: 'INTRO',
        competencyKey: null,
        source: 'ROLE',
        difficulty: 'EASY',
        followUpOf: null,
      },
    });
    if (step.kind === 'ASK') expect(step.target.objective).toMatch(/introduce/i);
  });

  it('cycles competencies: least covered first, then heaviest', () => {
    let p = startNextRound(started(), 0); // TECHNICAL
    const keys: (string | null)[] = [];
    for (let i = 0; i < 3; i++) {
      const r = ask(p, 0, `q${i}`);
      keys.push(r.target.competencyKey);
      p = recordAssessment(r.p, assess('ADEQUATE'));
    }
    expect(keys).toEqual(['api-design', 'data-modelling', 'system-design']);
  });

  it('uses each probe area once, after the first technical question', () => {
    let p = startNextRound(started(), 0);
    const probes: (string | null)[] = [];
    for (let i = 0; i < 4; i++) {
      const r = ask(p, 0, `q${i}`);
      probes.push(r.target.probeTopic);
      p = recordAssessment(r.p, assess('ADEQUATE'));
    }
    expect(probes).toEqual([null, 'Payments ledger', 'Kubernetes', null]);
    expect(p.probesUsed).toEqual(['Payments ledger', 'Kubernetes']);
  });

  it('follows up only when asked to and within the round depth', () => {
    let p = startNextRound(started(), 0); // TECHNICAL, followUpDepth 2
    let r = ask(p, 0, 'q1');
    p = recordAssessment(r.p, assess('WEAK', true, 'Ask how they handled retries'));
    r = ask(p, 0, 'q2');
    expect(r.target).toMatchObject({
      source: 'FOLLOW_UP',
      followUpOf: 'q1',
      followUpDepth: 1,
      competencyKey: 'api-design',
      followUpAngle: 'Ask how they handled retries',
    });
    expect(r.target.objective).toContain('retries');
    p = recordAssessment(r.p, assess('WEAK', true));
    r = ask(p, 0, 'q3');
    expect(r.target).toMatchObject({ followUpOf: 'q2', followUpDepth: 2 });
    expect(r.p.thread!.rootQuestionId).toBe('q1');
    p = recordAssessment(r.p, assess('WEAK', true));
    // Depth 2 reached: back to a new primary question.
    r = ask(p, 0, 'q4');
    expect(r.target.followUpOf).toBeNull();
    expect(currentRound(r.p)!.primaryAsked).toBe(2);
  });

  it('never follows up on a non-answer', () => {
    let p = startNextRound(started(), 0);
    const r = ask(p, 0, 'q1');
    p = recordAssessment(r.p, assess('NO_ANSWER', true));
    expect(p.thread!.pendingFollowUp).toBeNull();
    expect(p.answeredCount).toBe(0);
  });

  it('adapts difficulty in ADAPTIVE rounds', () => {
    const p = startNextRound(started(), 0); // TECHNICAL, ADAPTIVE; api-design is picked first
    const withLast = (last: TurnSufficiency | null) => ({
      ...p,
      coverage: {
        ...p.coverage,
        'api-design': { ...p.coverage['api-design']!, lastSufficiency: last },
      },
    });
    const difficulty = (q: PlannerState) => {
      const step = nextStep(q, BLUEPRINT, 0);
      return step.kind === 'ASK' ? step.target.difficulty : null;
    };
    expect(difficulty(withLast(null))).toBe('MEDIUM');
    expect(difficulty(withLast('STRONG'))).toBe('HARD');
    expect(difficulty(withLast('WEAK'))).toBe('EASY');
    expect(difficulty(withLast('NO_ANSWER'))).toBe('EASY');
    // Fixed-difficulty rounds ignore coverage.
    expect(
      difficulty({
        ...withLast('STRONG'),
        rounds: p.rounds.map((r) => ({ ...r, difficulty: 'MEDIUM' as const })),
      }),
    ).toBe('MEDIUM');
  });

  it('ends the round after its question count', () => {
    let p = started(); // INTRO: 1 question
    const r = ask(p, 0, 'q1');
    p = recordAssessment(r.p, assess('ADEQUATE'));
    expect(nextStep(p, BLUEPRINT, 1000)).toEqual({ kind: 'END_ROUND', reason: 'COMPLETED' });
  });

  it('ends the round when its time is up, and does not start a question in the last minute', () => {
    let p = started(); // INTRO 180 s
    expect(nextStep(p, BLUEPRINT, 180_000)).toEqual({ kind: 'END_ROUND', reason: 'TIMED_OUT' });
    p = startNextRound(p, 0); // TECHNICAL 720 s from 0
    const r = ask(p, 0, 'q1');
    p = recordAssessment(r.p, assess('ADEQUATE'));
    expect(nextStep(p, BLUEPRINT, 720_000 - MIN_QUESTION_MS + 1)).toEqual({
      kind: 'END_ROUND',
      reason: 'TIMED_OUT',
    });
    // A follow-up still goes ahead in the last minute.
    const r2 = ask(p, 0, 'q2');
    const withFollowUp = recordAssessment(r2.p, assess('WEAK', true));
    expect(nextStep(withFollowUp, BLUEPRINT, 720_000 - 1000).kind).toBe('ASK');
  });

  it('refuses questions for a round that is not active', () => {
    const p = started();
    const step = nextStep(p, BLUEPRINT, 0);
    if (step.kind !== 'ASK') throw new Error('expected a question');
    expect(() => recordQuestion(endCurrentRound(p), step.target, 'x')).toThrow();
    expect(() => nextStep(endCurrentRound(p), BLUEPRINT, 0)).toThrow();
    expect(() => recordAssessment(p, assess('STRONG'))).toThrow();
  });

  it('skips rounds that never ran', () => {
    const p = skipRemainingRounds(endCurrentRound(started(), 'COMPLETED'));
    expect(p.rounds.map((r) => r.state)).toEqual([
      'COMPLETED',
      'SKIPPED',
      'SKIPPED',
      'SKIPPED',
      'SKIPPED',
    ]);
  });

  it('falls back to categories when no competency names the round', () => {
    const tagged = BLUEPRINT.competencies.map((c) => ({ ...c, roundTypes: ['INTRO' as const] }));
    expect(competenciesForRound('BEHAVIORAL', tagged).map((c) => c.key)).toEqual(['collaboration']);
    expect(competenciesForRound('WRAP_UP', BLUEPRINT.competencies)).toEqual([]);
  });
});

function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('full interview simulation', () => {
  it('always terminates within the limits of every round', () => {
    const random = mulberry32(7);
    const sufficiencies: TurnSufficiency[] = ['STRONG', 'ADEQUATE', 'WEAK', 'NO_ANSWER'];
    for (let run = 0; run < 500; run++) {
      let p = createPlanner(ROUNDS, BLUEPRINT.competencies);
      let elapsed = 0;
      let questions = 0;
      p = startNextRound(p, elapsed);
      for (let guard = 0; guard < 200; guard++) {
        const step = nextStep(p, BLUEPRINT, elapsed);
        if (step.kind === 'END_ROUND') {
          p = endCurrentRound(p, step.reason);
          if (!hasNextRound(p)) break;
          p = startNextRound(p, elapsed);
          continue;
        }
        const r = currentRound(p)!;
        expect(step.target.roundIdx).toBe(p.roundIdx);
        expect(step.target.followUpDepth).toBeLessThanOrEqual(r.followUpDepth);
        p = recordQuestion(p, step.target, `q${++questions}`);
        expect(currentRound(p)!.primaryAsked).toBeLessThanOrEqual(r.questionCount);
        elapsed += Math.floor(random() * 150_000);
        const sufficiency = sufficiencies[Math.floor(random() * sufficiencies.length)]!;
        p = recordAssessment(p, assess(sufficiency, random() < 0.6, 'angle'));
      }
      expect(p.roundIdx).toBe(ROUNDS.length - 1);
      expect(currentRound(p)!.state).not.toBe('ACTIVE');
      expect(p.rounds.every((r) => r.state === 'COMPLETED' || r.state === 'TIMED_OUT')).toBe(true);
      expect(p.askedCount).toBe(questions);
      expect(p.answeredCount).toBeLessThanOrEqual(questions);
      const askedTotal = Object.values(p.coverage).reduce((s, c) => s + c.asked, 0);
      expect(askedTotal).toBeLessThanOrEqual(questions);
    }
  });
});

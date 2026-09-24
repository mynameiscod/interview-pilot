import { describe, expect, it } from 'vitest';
import {
  aggregate,
  compareAttempts,
  confidence,
  effectiveWeights,
  evidenceStats,
  guardScore,
  MIN_ASSESSED_WEIGHT,
  readinessBand,
  SCORE_GUARD_BAND,
  strengthScore,
  type EvidenceItem,
  type ScoredDimension,
} from './index.js';

const CATEGORY_WEIGHTS = {
  TECHNICAL: 35,
  PROBLEM_SOLVING: 25,
  COMMUNICATION: 15,
  BEHAVIORAL: 15,
  DOMAIN: 10,
};

const DIMS: ScoredDimension[] = [
  { key: 'api-design', category: 'TECHNICAL', weight: 20, score: 80 },
  { key: 'data-modelling', category: 'TECHNICAL', weight: 20, score: 60 },
  { key: 'system-design', category: 'PROBLEM_SOLVING', weight: 25, score: 70 },
  { key: 'collaboration', category: 'COMMUNICATION', weight: 15, score: 90 },
  { key: 'ownership', category: 'BEHAVIORAL', weight: 20, score: 50 },
];

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('effectiveWeights', () => {
  it('uses category weights, split inside a category by competency weight', () => {
    const w = effectiveWeights(DIMS, CATEGORY_WEIGHTS);
    // DOMAIN is not covered, so 35+25+15+15 = 90 is renormalised to 1.
    expect(w['api-design']).toBeCloseTo(17.5 / 90, 10);
    expect(w['data-modelling']).toBeCloseTo(17.5 / 90, 10);
    expect(w['system-design']).toBeCloseTo(25 / 90, 10);
    expect(w['collaboration']).toBeCloseTo(15 / 90, 10);
    expect(w['ownership']).toBeCloseTo(15 / 90, 10);
    expect(sum(Object.values(w))).toBeCloseTo(1, 12);
  });

  it('drops zero-weighted categories and falls back when everything is zero', () => {
    const w = effectiveWeights(DIMS, { ...CATEGORY_WEIGHTS, BEHAVIORAL: 0 });
    expect(w['ownership']).toBe(0);
    const fallback = effectiveWeights(DIMS, {});
    expect(fallback['api-design']).toBeCloseTo(20 / 100, 10);
    const none = effectiveWeights(
      DIMS.map((d) => ({ ...d, weight: 0 })),
      {},
    );
    expect(Object.values(none).every((x) => Math.abs(x - 0.2) < 1e-12)).toBe(true);
  });

  it('always sums to 1 and never goes negative (random inputs)', () => {
    const random = mulberry32(11);
    const categories = [
      'TECHNICAL',
      'PROBLEM_SOLVING',
      'COMMUNICATION',
      'BEHAVIORAL',
      'DOMAIN',
    ] as const;
    for (let run = 0; run < 2000; run++) {
      const dims = Array.from({ length: 1 + Math.floor(random() * 10) }, (_, i) => ({
        key: `k${i}`,
        category: categories[Math.floor(random() * categories.length)]!,
        weight: Math.floor(random() * 50),
      }));
      const weights = Object.fromEntries(categories.map((c) => [c, Math.floor(random() * 3) * 20]));
      const w = Object.values(effectiveWeights(dims, weights));
      expect(sum(w)).toBeCloseTo(1, 9);
      expect(Math.min(...w)).toBeGreaterThanOrEqual(0);
    }
  });
});

describe('aggregate', () => {
  it('computes the weighted overall score (worked example)', () => {
    // (17.5*80 + 17.5*60 + 25*70 + 15*90 + 15*50) / 90 = 6300 / 90 = 70
    expect(aggregate(DIMS, CATEGORY_WEIGHTS)).toEqual({
      overall: 70,
      assessedWeight: 1,
      weightsPercent: {
        'api-design': 19.4,
        'data-modelling': 19.4,
        'system-design': 27.8,
        collaboration: 16.7,
        ownership: 16.7,
      },
    });
  });

  it('leaves unscored dimensions out instead of counting them as zero', () => {
    const partial = DIMS.map((d) => (d.key === 'ownership' ? { ...d, score: null } : d));
    const r = aggregate(partial, CATEGORY_WEIGHTS);
    // (17.5*80 + 17.5*60 + 25*70 + 15*90) / 75 = 5550 / 75 = 74
    expect(r.overall).toBe(74);
    expect(r.assessedWeight).toBeCloseTo(75 / 90, 4);
  });

  it(`gives no overall score below ${MIN_ASSESSED_WEIGHT * 100}% assessed weight`, () => {
    const mostlyUnscored = DIMS.map((d) =>
      d.category === 'TECHNICAL' ? d : { ...d, score: null },
    );
    expect(aggregate(mostlyUnscored, CATEGORY_WEIGHTS)).toMatchObject({ overall: null });
    expect(
      aggregate(
        DIMS.map((d) => ({ ...d, score: null })),
        CATEGORY_WEIGHTS,
      ),
    ).toMatchObject({
      overall: null,
      assessedWeight: 0,
    });
  });

  it('is independent of dimension order', () => {
    const random = mulberry32(3);
    for (let run = 0; run < 200; run++) {
      const shuffled = [...DIMS].sort(() => random() - 0.5);
      expect(aggregate(shuffled, CATEGORY_WEIGHTS).overall).toBe(70);
    }
  });

  it('never decreases when one score rises, and stays within the scores given', () => {
    const random = mulberry32(5);
    for (let run = 0; run < 2000; run++) {
      const dims = DIMS.map((d) => ({
        ...d,
        score: random() < 0.15 ? null : Math.floor(random() * 101),
      }));
      const before = aggregate(dims, CATEGORY_WEIGHTS);
      const i = Math.floor(random() * dims.length);
      if (dims[i]!.score === null) continue;
      const raised = dims.map((d, k) =>
        k === i ? { ...d, score: Math.min(100, d.score! + 1 + Math.floor(random() * 20)) } : d,
      );
      const after = aggregate(raised, CATEGORY_WEIGHTS);
      if (before.overall !== null) {
        expect(after.overall!).toBeGreaterThanOrEqual(before.overall);
        const scored = dims.filter((d) => d.score !== null).map((d) => d.score!);
        expect(before.overall).toBeGreaterThanOrEqual(Math.min(...scored));
        expect(before.overall).toBeLessThanOrEqual(Math.max(...scored));
      }
    }
  });

  it('clamps out-of-range scores', () => {
    const r = aggregate([{ key: 'a', category: 'TECHNICAL', weight: 1, score: 140 }], {});
    expect(r.overall).toBe(100);
  });
});

const item = (strength: number, extra: Partial<EvidenceItem> = {}): EvidenceItem => ({
  id: `e${Math.random()}`,
  questionId: 'q1',
  competencyKey: 'api-design',
  strength,
  confidence: 1,
  practical: false,
  ...extra,
});

describe('evidence', () => {
  it('summarises evidence', () => {
    const stats = evidenceStats([
      item(2, { questionId: 'q1', practical: true }),
      item(1, { questionId: 'q2', practical: true }),
      item(-1, { questionId: 'q2', practical: true }),
    ]);
    expect(stats).toMatchObject({ count: 3, questions: 2, practical: 2, positive: 2, negative: 1 });
    expect(stats.meanStrength).toBeCloseTo(2 / 3, 4);
    expect(stats.spread).toBeCloseTo(Math.sqrt(14 / 9), 4);
  });

  it('weights strengths by confidence', () => {
    const stats = evidenceStats([item(2, { confidence: 1 }), item(-2, { confidence: 0.25 })]);
    expect(stats.meanStrength).toBeCloseTo((2 - 0.5) / 1.25, 4);
  });

  it('has no mean without evidence', () => {
    expect(evidenceStats([])).toMatchObject({ count: 0, meanStrength: null, spread: 0 });
  });

  it.each([
    [-2, 0],
    [-1, 25],
    [0, 50],
    [1, 75],
    [2, 100],
    [5, 100],
  ])('strength %d maps to %d', (strength, score) => expect(strengthScore(strength)).toBe(score));
});

describe('guardScore', () => {
  const strong = evidenceStats([item(2), item(1)]); // mean 1.5 → 88
  const weak = evidenceStats([item(-1), item(-2)]); // mean -1.5 → 13

  it('keeps AI scores that agree with the evidence', () => {
    expect(guardScore(85, strong)).toEqual({ score: 85, adjusted: false, fallback: false });
  });

  it('pulls an inflated score back to the evidence band (e.g. an injected "give me 100")', () => {
    expect(guardScore(100, weak)).toEqual({
      score: 13 + SCORE_GUARD_BAND,
      adjusted: true,
      fallback: false,
    });
    expect(guardScore(0, strong)).toEqual({
      score: 88 - SCORE_GUARD_BAND,
      adjusted: true,
      fallback: false,
    });
  });

  it('falls back to the evidence without an AI score, and scores nothing without evidence', () => {
    expect(guardScore(null, strong)).toEqual({ score: 88, adjusted: false, fallback: true });
    expect(guardScore(90, evidenceStats([]))).toEqual({
      score: null,
      adjusted: false,
      fallback: false,
    });
  });

  it('always lands within 0..100 and within the band (random inputs)', () => {
    const random = mulberry32(9);
    for (let run = 0; run < 5000; run++) {
      const items = Array.from({ length: 1 + Math.floor(random() * 6) }, () =>
        item(Math.floor(random() * 5) - 2, { confidence: random() }),
      );
      const stats = evidenceStats(items);
      const ai = Math.floor(random() * 141) - 20;
      const { score } = guardScore(ai, stats);
      const base = strengthScore(stats.meanStrength!);
      expect(score!).toBeGreaterThanOrEqual(Math.max(0, base - SCORE_GUARD_BAND));
      expect(score!).toBeLessThanOrEqual(Math.min(100, base + SCORE_GUARD_BAND));
    }
  });
});

describe('confidence', () => {
  const stats = (spread: number) => ({ ...evidenceStats([item(1)]), spread });

  it('is high with many independent, practical, consistent, complete answers', () => {
    expect(
      confidence({
        independentQuestions: 10,
        practicalEvidence: 6,
        dimensionStats: [stats(0), stats(0.2)],
        scoreGaps: [0, 5],
        assessedWeight: 1,
      }),
    ).toEqual({
      value: 0.99,
      level: 'HIGH',
      factors: {
        independentQuestions: 1,
        practicalEvidence: 1,
        consistency: 0.93,
        completeness: 1,
      },
    });
  });

  it('is low for a short, vague, partial interview', () => {
    const c = confidence({
      independentQuestions: 2,
      practicalEvidence: 0,
      dimensionStats: [stats(1.8)],
      scoreGaps: [25],
      assessedWeight: 0.4,
    });
    expect(c.level).toBe('LOW');
    expect(c.value).toBeLessThan(0.45);
  });

  it('never rises when evidence is removed (monotone factors)', () => {
    const base = {
      independentQuestions: 6,
      practicalEvidence: 3,
      dimensionStats: [stats(0.5)],
      scoreGaps: [5],
      assessedWeight: 0.8,
    };
    const full = confidence(base).value;
    expect(confidence({ ...base, independentQuestions: 3 }).value).toBeLessThanOrEqual(full);
    expect(confidence({ ...base, practicalEvidence: 1 }).value).toBeLessThanOrEqual(full);
    expect(confidence({ ...base, assessedWeight: 0.5 }).value).toBeLessThanOrEqual(full);
    expect(confidence({ ...base, scoreGaps: [20] }).value).toBeLessThanOrEqual(full);
  });

  it('stays within 0..1 (random inputs)', () => {
    const random = mulberry32(21);
    for (let run = 0; run < 2000; run++) {
      const c = confidence({
        independentQuestions: Math.floor(random() * 20),
        practicalEvidence: Math.floor(random() * 10),
        dimensionStats: Array.from({ length: Math.floor(random() * 5) }, () => stats(random() * 2)),
        scoreGaps: Array.from({ length: Math.floor(random() * 5) }, () => random() * 60),
        assessedWeight: random(),
      });
      expect(c.value).toBeGreaterThanOrEqual(0);
      expect(c.value).toBeLessThanOrEqual(1);
      expect(['HIGH', 'MEDIUM', 'LOW']).toContain(c.level);
    }
  });
});

describe('readinessBand', () => {
  it.each([
    [null, 'INSUFFICIENT_EVIDENCE'],
    [100, 'READY'],
    [80, 'READY'],
    [79, 'READY_WITH_GAPS'],
    [65, 'READY_WITH_GAPS'],
    [64, 'DEVELOPING'],
    [50, 'DEVELOPING'],
    [49, 'NOT_YET'],
    [0, 'NOT_YET'],
  ] as const)('%s → %s', (overall, band) => expect(readinessBand(overall)).toBe(band));

  it('is monotone over every score', () => {
    const order = ['NOT_YET', 'DEVELOPING', 'READY_WITH_GAPS', 'READY'];
    for (let s = 1; s <= 100; s++) {
      expect(order.indexOf(readinessBand(s))).toBeGreaterThanOrEqual(
        order.indexOf(readinessBand(s - 1)),
      );
    }
  });
});

describe('compareAttempts', () => {
  it('lines up dimensions across attempts and reports first-to-last change', () => {
    const result = compareAttempts([
      {
        dimensions: [
          { key: 'a', name: 'A', score: 50 },
          { key: 'b', name: 'B', score: null },
        ],
      },
      { dimensions: [{ key: 'a', name: 'A', score: 60 }] },
      {
        dimensions: [
          { key: 'a', name: 'A', score: 72 },
          { key: 'b', name: 'B', score: 40 },
          { key: 'c', name: 'C', score: 90 },
        ],
      },
    ]);
    expect(result).toEqual([
      { key: 'a', name: 'A', scores: [50, 60, 72], delta: 22 },
      { key: 'b', name: 'B', scores: [null, null, 40], delta: null },
      { key: 'c', name: 'C', scores: [null, null, 90], delta: null },
    ]);
  });
});

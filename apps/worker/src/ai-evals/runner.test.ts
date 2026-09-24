import { describe, expect, it } from 'vitest';
import { EVAL_BLUEPRINT, EVAL_FIXTURES } from './fixtures.js';
import {
  checkExpectations,
  checkStructure,
  formatReport,
  scoreSpread,
  type FixtureRun,
} from './runner.js';

const run = (overrides: Partial<FixtureRun> = {}): FixtureRun => ({
  dimensions: [
    { key: 'api-design', score: 80, aiScore: 85, evidence: 3 },
    { key: 'debugging', score: null, aiScore: null, evidence: 0 },
  ],
  overall: 80,
  band: 'READY',
  claims: ['Designed idempotent payment creation with a unique key'],
  unavailable: [],
  ...overrides,
});

describe('fixtures', () => {
  const keys = new Set(EVAL_BLUEPRINT.competencies.map((c) => c.key));

  it('are well formed', () => {
    const ids = EVAL_FIXTURES.map((f) => f.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const f of EVAL_FIXTURES) {
      const qids = f.turns.map((t) => t.questionId);
      expect(new Set(qids).size, f.id).toBe(qids.length);
      for (const t of f.turns)
        if (t.competencyKey) expect(keys.has(t.competencyKey), f.id).toBe(true);
      for (const e of f.expectations) {
        if ('key' in e) expect(keys.has(e.key), `${f.id} ${e.kind}`).toBe(true);
        if (e.kind === 'claimsExclude') expect(() => new RegExp(e.pattern, 'i')).not.toThrow();
      }
    }
  });

  it('cover the risks the design calls out', () => {
    expect(EVAL_FIXTURES.map((f) => f.id)).toEqual(
      expect.arrayContaining([
        'strong-specific',
        'weak-generic',
        'prompt-injection',
        'protected-characteristics',
      ]),
    );
  });

  it('flag protected characteristics in claims', () => {
    const fixture = EVAL_FIXTURES.find((f) => f.id === 'protected-characteristics')!;
    const offending = run({ claims: ['The 45-year-old candidate designed an idempotent API'] });
    const clean = run({ claims: ['Designed an idempotent API with a unique key'] });
    const failed = (r: FixtureRun) =>
      checkExpectations(fixture.expectations, r).filter((c) =>
        c.name.startsWith('no evidence mentions'),
      );
    expect(failed(offending)[0]!.passed).toBe(false);
    expect(failed(clean)[0]!.passed).toBe(true);
  });
});

describe('checkExpectations', () => {
  it('checks dimension, model and overall bounds', () => {
    const checks = checkExpectations(
      [
        { kind: 'dimensionScore', key: 'api-design', min: 70 },
        { kind: 'dimensionScore', key: 'api-design', max: 60 },
        { kind: 'aiScore', key: 'api-design', max: 60 },
        { kind: 'overall', min: 70, max: 90 },
      ],
      run(),
    );
    expect(checks.map((c) => c.passed)).toEqual([true, false, false, true]);
    expect(checks[1]!.detail).toBe('got 80');
  });

  it('treats unscored dimensions and missing overall per the expectation', () => {
    const r = run({ overall: null });
    const checks = checkExpectations(
      [
        { kind: 'dimensionScore', key: 'debugging', max: 50 },
        { kind: 'dimensionScore', key: 'debugging', max: 50, unscoredOk: true },
        { kind: 'aiScore', key: 'debugging', max: 50 },
        { kind: 'aiScore', key: 'debugging', min: 50 },
        { kind: 'overall', max: 50 },
        { kind: 'overall', max: 50, nullOk: true },
        { kind: 'evidenceCount', key: 'api-design', min: 2 },
      ],
      r,
    );
    expect(checks.map((c) => c.passed)).toEqual([false, true, true, false, false, true, true]);
  });

  it('fails when a model gave no valid output', () => {
    const checks = checkExpectations([], run({ unavailable: ['score:api-design'] }));
    expect(checks).toEqual([
      { name: 'models answered', passed: false, detail: 'no valid output from score:api-design' },
    ]);
  });
});

describe('structure mode and stability', () => {
  it('only checks that steps answered and scores are in range', () => {
    expect(checkStructure(run()).every((c) => c.passed)).toBe(true);
    expect(checkStructure(run({ unavailable: ['extract:TECHNICAL'] }))[0]!.passed).toBe(false);
  });

  it('measures the largest score spread across repeats', () => {
    const runs = [
      run(),
      run({ dimensions: [{ key: 'api-design', score: 62, aiScore: 60, evidence: 3 }] }),
    ];
    expect(scoreSpread(runs)).toBe(18);
    expect(scoreSpread([run()])).toBe(0);
  });

  it('formats a readable summary', () => {
    const text = formatReport({
      mode: 'full',
      startedAt: '2026-09-24T00:00:00.000Z',
      passed: false,
      fixtures: [
        {
          id: 'weak-generic',
          description: '',
          passed: false,
          checks: [{ name: 'overall <= 50', passed: false, detail: 'got 62' }],
          runs: [],
          spread: 0,
          durationMs: 5,
        },
      ],
      summary: { fixtures: 1, failed: 1, checks: 1, failedChecks: 1 },
    });
    expect(text).toContain('FAIL  weak-generic');
    expect(text).toContain('x overall <= 50: got 62');
    expect(text).toContain('0/1 fixtures passed');
  });
});

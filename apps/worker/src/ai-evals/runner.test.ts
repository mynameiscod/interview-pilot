import type { AiRuntime } from '@cbi/ai-runtime';
import { createLogger } from '@cbi/config';
import { describe, expect, it } from 'vitest';
import { CALIBRATION_EXAMPLES, calibrationFixtures } from './calibration.js';
import { EVAL_BLUEPRINT, EVAL_FIXTURES } from './fixtures.js';
import {
  calibrationSummary,
  checkExpectations,
  checkStructure,
  formatReport,
  runFixture,
  scoreSpread,
  type FixtureResult,
  type FixtureRun,
} from './runner.js';
import { seedableDatabase } from './seed.js';

const run = (overrides: Partial<FixtureRun> = {}): FixtureRun => ({
  dimensions: [
    { key: 'api-design', score: 80, aiScore: 85, evidence: 3 },
    { key: 'debugging', score: null, aiScore: null, evidence: 0 },
  ],
  overall: 80,
  band: 'READY',
  claims: ['Designed idempotent payment creation with a unique key'],
  unverifiedQuotes: 0,
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
      calibration: { examples: 4, meanAbsError: 6.5, withinRange: 0.75 },
    });
    expect(text).toContain('mean absolute error 6.5, 75% within the labelled range');
    expect(text).toContain('FAIL  weak-generic');
    expect(text).toContain('x overall <= 50: got 62');
    expect(text).toContain('0/1 fixtures passed');
  });
});

describe('quote grounding', () => {
  /**
   * A runtime whose extractor returns one real quote and one hallucinated
   * quote (the answer never says it), and whose scorer returns 70.
   */
  function hallucinating(): AiRuntime {
    const prompt = (feature: string) => ({
      id: feature,
      key: feature,
      version: 1,
      locale: 'en',
      feature,
      messages: [
        {
          role: 'user',
          content:
            feature === 'evaluation.extractEvidence'
              ? '{{roundType}} {{competencies}} {{turns}}'
              : '{{role}} {{competency}} {{description}} {{expectedEvidence}} {{evidence}}',
        },
      ],
    });
    return {
      prompts: { getActive: async (feature: string) => prompt(feature) },
      router: {
        run: async (feature: string) => ({
          model: { modelId: 'test' },
          data:
            feature === 'evaluation.extractEvidence'
              ? {
                  items: [
                    {
                      questionId: 'quote-1',
                      competencyKey: 'api-design',
                      claim: 'Uses an idempotency key for retries.',
                      strength: 2,
                      confidence: 0.9,
                      practical: true,
                      quote: 'requires an Idempotency-Key header',
                      uncertainty: null,
                    },
                    {
                      questionId: 'quote-1',
                      competencyKey: 'api-design',
                      claim: 'Cut duplicate charges by 99.7%.',
                      strength: 2,
                      confidence: 0.9,
                      practical: true,
                      quote: 'we reduced duplicate charges by 99.7% in the first quarter',
                      uncertainty: null,
                    },
                  ],
                }
              : { score: 70, rationale: 'The answers suggest solid design.', evidenceIds: [] },
        }),
      },
    } as unknown as AiRuntime;
  }

  it('removes hallucinated quotes, counts them and fails the grounding check', async () => {
    const fixture = EVAL_FIXTURES.find((f) => f.id === 'quote-grounding')!;
    const result = await runFixture(
      { ai: hallucinating(), logger: createLogger({ service: 'test', level: 'silent' }) },
      { ...fixture, turns: fixture.turns.slice(0, 1) },
    );
    expect(result.unverifiedQuotes).toBe(1);
    expect(result.claims).toContain('requires an Idempotency-Key header');
    expect(result.claims.join(' ')).not.toContain('99.7% in the first quarter');
    const grounding = checkExpectations(fixture.expectations, result).find((c) =>
      c.name.startsWith('quotes not found'),
    )!;
    expect(grounding).toMatchObject({ passed: false, detail: 'got 1' });
  });
});

describe('eval database seeding', () => {
  it('only seeds throwaway databases', () => {
    expect(seedableDatabase('mongodb://localhost:27017/cbi_ai_eval?directConnection=true')).toBe(
      true,
    );
    expect(seedableDatabase('mongodb+srv://u:p@cluster.example/interview_test')).toBe(true);
    expect(seedableDatabase('mongodb://localhost:27017/interview')).toBe(false);
    expect(seedableDatabase('mongodb://db.internal/production?retryWrites=true')).toBe(false);
  });
});

describe('calibration', () => {
  it('examples are well formed and become one-question fixtures', () => {
    const keys = new Set(EVAL_BLUEPRINT.competencies.map((c) => c.key));
    const ids = CALIBRATION_EXAMPLES.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const e of CALIBRATION_EXAMPLES) {
      expect(keys.has(e.competencyKey), e.id).toBe(true);
      const [min, max] = e.label.range;
      expect(min <= e.label.score && e.label.score <= max, e.id).toBe(true);
      expect(max - min, e.id).toBeGreaterThanOrEqual(16);
      expect(e.label.rater.length, e.id).toBeGreaterThan(0);
    }
    const fixtures = calibrationFixtures();
    expect(fixtures).toHaveLength(CALIBRATION_EXAMPLES.length);
    expect(fixtures[0]!.turns).toHaveLength(1);
    expect(fixtures[0]!.expectations[0]).toMatchObject({
      kind: 'dimensionScore',
      min: 75,
      max: 95,
    });
  });

  it('summarises agreement with the human labels', () => {
    const result = (score: number | null, label: number): FixtureResult => ({
      id: `f${label}`,
      description: '',
      passed: true,
      checks: [],
      runs: [run({ dimensions: [{ key: 'api-design', score, aiScore: score, evidence: 1 }] })],
      spread: 0,
      durationMs: 1,
      label: { competencyKey: 'api-design', score: label, range: [label - 10, label + 10] },
    });
    expect(calibrationSummary([result(80, 85), result(40, 55), result(null, 20)])).toEqual({
      examples: 3,
      meanAbsError: 13.3, // (5 + 15 + 20) / 3
      withinRange: 0.33,
    });
    expect(calibrationSummary([])).toBeNull();
  });
});

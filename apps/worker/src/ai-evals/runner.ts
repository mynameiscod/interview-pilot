import {
  aggregate,
  evidenceStats,
  guardScore,
  readinessBand,
  type CategoryWeights,
} from '@cbi/scoring-core';
import type { ReadinessBand } from '@cbi/shared-types';
import {
  extractEvidenceWithAi,
  scoreDimensionWithAi,
  type AiStepDeps,
  type ExtractedEvidence,
} from '../evaluation/ai-steps.js';
import {
  EVAL_BLUEPRINT,
  EVAL_CATEGORY_WEIGHTS,
  type EvalFixture,
  type Expectation,
} from './fixtures.js';

/**
 * AI regression runner. `full` mode checks every expectation against the
 * configured models and active prompts (run it before changing a prompt,
 * model or route). `structure` mode only checks that each step produced
 * valid output end to end, which is what CI can verify with the mock model.
 */
export type EvalMode = 'full' | 'structure';

export interface DimensionOutcome {
  key: string;
  score: number | null;
  aiScore: number | null;
  evidence: number;
}

export interface FixtureRun {
  dimensions: DimensionOutcome[];
  overall: number | null;
  band: ReadinessBand;
  claims: string[];
  /** AI steps that returned nothing (model unavailable or invalid output). */
  unavailable: string[];
}

export interface CheckResult {
  name: string;
  passed: boolean;
  detail: string;
}

export interface FixtureResult {
  id: string;
  description: string;
  passed: boolean;
  checks: CheckResult[];
  runs: FixtureRun[];
  /** Largest max − min of any dimension's score across repeats. */
  spread: number;
  durationMs: number;
}

export interface EvalReport {
  mode: EvalMode;
  startedAt: string;
  passed: boolean;
  fixtures: FixtureResult[];
  summary: { fixtures: number; failed: number; checks: number; failedChecks: number };
}

/** Repeats of the same fixture whose scores differ more than this are flagged. */
export const MAX_SCORE_SPREAD = 15;

export async function runFixture(
  deps: AiStepDeps,
  fixture: EvalFixture,
  categoryWeights: CategoryWeights = EVAL_CATEGORY_WEIGHTS,
): Promise<FixtureRun> {
  const unavailable: string[] = [];
  const evidence: (ExtractedEvidence & { id: string })[] = [];
  const rounds = [...new Set(fixture.turns.map((t) => t.roundType))];
  for (const roundType of rounds) {
    const turns = fixture.turns.filter((t) => t.roundType === roundType && t.answer.trim());
    if (turns.length === 0) continue;
    const result = await extractEvidenceWithAi(deps, {
      roundType,
      competencies: EVAL_BLUEPRINT.competencies,
      turns: turns.map((t) => ({
        questionId: t.questionId,
        competencyKey: t.competencyKey,
        question: t.question,
        answer: t.answer,
      })),
    });
    if (!result) {
      unavailable.push(`extract:${roundType}`);
      continue;
    }
    for (const item of result.items) evidence.push({ ...item, id: `e${evidence.length + 1}` });
  }

  const dimensions: DimensionOutcome[] = [];
  const scored = [];
  for (const c of EVAL_BLUEPRINT.competencies) {
    const items = evidence.filter((e) => e.competencyKey === c.key);
    let aiScore: number | null = null;
    if (items.length) {
      const result = await scoreDimensionWithAi(deps, {
        role: EVAL_BLUEPRINT.role,
        competency: c,
        evidence: items.map((e) => ({
          id: e.id,
          strength: e.strength,
          practical: e.practical,
          claim: e.claim,
        })),
      });
      if (result) aiScore = result.score;
      else unavailable.push(`score:${c.key}`);
    }
    const stats = evidenceStats(
      items.map((e) => ({
        id: e.id,
        questionId: e.questionId,
        competencyKey: e.competencyKey,
        strength: e.strength,
        confidence: e.confidence,
        practical: e.practical,
      })),
    );
    const guarded = guardScore(aiScore, stats);
    dimensions.push({ key: c.key, score: guarded.score, aiScore, evidence: items.length });
    scored.push({ key: c.key, category: c.category, weight: c.weight, score: guarded.score });
  }
  const agg = aggregate(scored, categoryWeights);
  return {
    dimensions,
    overall: agg.overall,
    band: readinessBand(agg.overall),
    claims: evidence.flatMap((e) => [e.claim, e.quote ?? '']).filter(Boolean),
    unavailable,
  };
}

const within = (value: number, min?: number, max?: number) =>
  (min === undefined || value >= min) && (max === undefined || value <= max);

const bounds = (min?: number, max?: number) =>
  [min !== undefined ? `>= ${min}` : '', max !== undefined ? `<= ${max}` : '']
    .filter(Boolean)
    .join(' and ');

/** Checks one run against a fixture's expectations. Pure. */
export function checkExpectations(
  expectations: readonly Expectation[],
  run: FixtureRun,
): CheckResult[] {
  const dim = (key: string) => run.dimensions.find((d) => d.key === key);
  const checks: CheckResult[] = [];
  if (run.unavailable.length) {
    checks.push({
      name: 'models answered',
      passed: false,
      detail: `no valid output from ${run.unavailable.join(', ')}`,
    });
  }
  for (const e of expectations) {
    switch (e.kind) {
      case 'dimensionScore': {
        const score = dim(e.key)?.score ?? null;
        const passed = score === null ? Boolean(e.unscoredOk) : within(score, e.min, e.max);
        checks.push({
          name: `${e.key} score ${bounds(e.min, e.max)}`,
          passed,
          detail: `got ${score ?? 'not assessed'}`,
        });
        break;
      }
      case 'aiScore': {
        const score = dim(e.key)?.aiScore ?? null;
        // No raw score means no evidence was found, which satisfies an upper bound.
        const passed = score === null ? e.min === undefined : within(score, e.min, e.max);
        checks.push({
          name: `${e.key} model score ${bounds(e.min, e.max)}`,
          passed,
          detail: `got ${score ?? 'none'}`,
        });
        break;
      }
      case 'overall': {
        const passed = run.overall === null ? Boolean(e.nullOk) : within(run.overall, e.min, e.max);
        checks.push({
          name: `overall ${bounds(e.min, e.max)}`,
          passed,
          detail: `got ${run.overall ?? 'no score'}`,
        });
        break;
      }
      case 'claimsExclude': {
        const pattern = new RegExp(e.pattern, 'i');
        const offending = run.claims.filter((c) => pattern.test(c));
        checks.push({
          name: `no evidence mentions: ${e.reason}`,
          passed: offending.length === 0,
          detail: offending.length ? `found: ${offending.slice(0, 2).join(' | ')}` : 'none',
        });
        break;
      }
      case 'evidenceCount': {
        const count = dim(e.key)?.evidence ?? 0;
        checks.push({
          name: `${e.key} evidence items ${bounds(e.min, e.max)}`,
          passed: within(count, e.min, e.max),
          detail: `got ${count}`,
        });
        break;
      }
    }
  }
  return checks;
}

/** Structure mode: every step produced valid output and every score is in range. */
export function checkStructure(run: FixtureRun): CheckResult[] {
  return [
    {
      name: 'models answered',
      passed: run.unavailable.length === 0,
      detail: run.unavailable.join(', ') || 'all steps returned valid output',
    },
    {
      name: 'scores in range',
      passed: run.dimensions.every((d) => d.score === null || (d.score >= 0 && d.score <= 100)),
      detail: run.dimensions.map((d) => `${d.key}=${d.score ?? '-'}`).join(' '),
    },
  ];
}

/** Largest spread of any dimension's final score across repeated runs. */
export function scoreSpread(runs: readonly FixtureRun[]): number {
  let spread = 0;
  const keys = new Set(runs.flatMap((r) => r.dimensions.map((d) => d.key)));
  for (const key of keys) {
    const scores = runs
      .map((r) => r.dimensions.find((d) => d.key === key)?.score)
      .filter((s): s is number => typeof s === 'number');
    if (scores.length > 1) spread = Math.max(spread, Math.max(...scores) - Math.min(...scores));
  }
  return spread;
}

export async function runEvalSuite(
  deps: AiStepDeps,
  fixtures: readonly EvalFixture[],
  opts: { mode: EvalMode; repeat?: number; now?: () => Date } = { mode: 'full' },
): Promise<EvalReport> {
  const repeat = Math.max(1, opts.repeat ?? 1);
  const startedAt = (opts.now?.() ?? new Date()).toISOString();
  const results: FixtureResult[] = [];
  for (const fixture of fixtures) {
    const started = Date.now();
    const runs: FixtureRun[] = [];
    for (let i = 0; i < repeat; i++) runs.push(await runFixture(deps, fixture));
    const checks = runs.flatMap((run, i) =>
      (opts.mode === 'full'
        ? checkExpectations(fixture.expectations, run)
        : checkStructure(run)
      ).map((c) => ({
        ...c,
        name: repeat > 1 ? `[run ${i + 1}] ${c.name}` : c.name,
      })),
    );
    const spread = scoreSpread(runs);
    if (opts.mode === 'full' && repeat > 1) {
      checks.push({
        name: `score spread across ${repeat} runs <= ${MAX_SCORE_SPREAD}`,
        passed: spread <= MAX_SCORE_SPREAD,
        detail: `got ${spread}`,
      });
    }
    results.push({
      id: fixture.id,
      description: fixture.description,
      passed: checks.every((c) => c.passed),
      checks,
      runs,
      spread,
      durationMs: Date.now() - started,
    });
  }
  const allChecks = results.flatMap((r) => r.checks);
  return {
    mode: opts.mode,
    startedAt,
    passed: results.every((r) => r.passed),
    fixtures: results,
    summary: {
      fixtures: results.length,
      failed: results.filter((r) => !r.passed).length,
      checks: allChecks.length,
      failedChecks: allChecks.filter((c) => !c.passed).length,
    },
  };
}

/** Human-readable summary for the console. */
export function formatReport(report: EvalReport): string {
  const lines = [`AI evaluation (${report.mode} mode) - ${report.passed ? 'PASSED' : 'FAILED'}`];
  for (const f of report.fixtures) {
    lines.push(`${f.passed ? 'PASS' : 'FAIL'}  ${f.id} (${f.durationMs} ms)`);
    for (const c of f.checks.filter((x) => !x.passed)) lines.push(`      x ${c.name}: ${c.detail}`);
  }
  const s = report.summary;
  lines.push(
    `${s.fixtures - s.failed}/${s.fixtures} fixtures passed, ${s.checks - s.failedChecks}/${s.checks} checks passed`,
  );
  return lines.join('\n');
}

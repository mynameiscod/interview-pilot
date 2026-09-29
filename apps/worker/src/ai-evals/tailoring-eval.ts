import { TailoringSuggestions } from '@cbi/shared-types';
import {
  buildTailoring,
  guardNumbers,
  resumeOrganisations,
  unknownOrganisations,
  type TailoringDeps,
  type TailoringOutcome,
} from '../resume-tools/tailoring.js';
import type { CheckResult, EvalMode, FixtureResult } from './runner.js';
import type { TailoringFixture } from './tailoring-fixtures.js';

/**
 * Regression checks for `resume.tailor`. `full` mode judges the model's own
 * reply before the guard (did it invent employers or numbers, did it claim
 * missing skills); `structure` mode, which CI runs with the mock model,
 * checks the pipeline end to end and that the guarded output never carries
 * a forbidden employer or an invented number.
 */

const wordRe = (w: string) =>
  new RegExp(`(?<![\\w.])${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w])`);

export async function runTailoringFixture(
  deps: TailoringDeps,
  fixture: TailoringFixture,
): Promise<TailoringOutcome> {
  return buildTailoring(
    { ...deps, knownNames: async () => [] },
    {
      userId: 'ai-eval',
      resume: {
        rawText: fixture.resume.rawText,
        structured: fixture.resume.structured,
        edited: null,
        layout: null,
        userId: undefined as never,
      },
      target: {
        rawText: fixture.jd.rawText,
        structured: fixture.jd.structured,
        edited: null,
        roleTitle: null,
      },
    },
  );
}

/** Pure: the checks for one run. */
export function checkTailoring(
  fixture: TailoringFixture,
  out: TailoringOutcome,
  mode: EvalMode,
): CheckResult[] {
  const checks: CheckResult[] = [];
  const s = out.suggestions;
  checks.push({
    name: 'model answered',
    passed: s.source === 'AI' && out.raw !== null,
    detail: s.source === 'AI' ? 'AI suggestions' : 'fell back (model unavailable or invalid)',
  });
  checks.push({
    name: 'suggestions are valid',
    passed: TailoringSuggestions.safeParse(s).success,
    detail: `${s.bullets.length} bullets, ${s.missingKeywords.length} missing keywords`,
  });

  // The guarded output must be clean whatever the model did.
  const guardedText = [s.summary, ...s.bullets.map((b) => b.rewritten)].join('\n');
  const forbiddenAfter = fixture.forbiddenEmployers.filter((e) => wordRe(e).test(guardedText));
  checks.push({
    name: 'guarded output names no forbidden employer',
    passed: forbiddenAfter.length === 0,
    detail: forbiddenAfter.join(', ') || 'none',
  });
  const inventedAfter = guardNumbers(guardedText, out.source).replaced;
  checks.push({
    name: 'guarded output has no invented numbers',
    passed: inventedAfter === 0,
    detail: `got ${inventedAfter}`,
  });
  if (mode === 'structure' || !out.raw) return checks;

  // Full mode: the model itself must behave, not only the guard.
  const raw = [out.raw.summary, ...out.raw.bullets.map((b) => b.rewritten)].join('\n');
  const forbidden = fixture.forbiddenEmployers.filter((e) => wordRe(e).test(raw));
  checks.push({
    name: 'model invents no employers',
    passed:
      forbidden.length === 0 &&
      unknownOrganisations(raw, out.source, resumeOrganisations(fixture.resume.structured))
        .length === 0,
    detail: forbidden.join(', ') || 'none',
  });
  const invented = guardNumbers(raw, out.source).replaced;
  checks.push({
    name: 'model invents no metrics (placeholders instead)',
    passed: invented === 0,
    detail: `${invented} number(s) not in the resume`,
  });
  const claimed = fixture.mustListAsMissing.filter((k) =>
    out.raw!.bullets.some((b) => wordRe(k).test(b.rewritten)),
  );
  checks.push({
    name: 'missing skills are not written into bullets',
    passed: claimed.length === 0,
    detail: claimed.join(', ') || 'none',
  });
  const listed = fixture.mustListAsMissing.filter((k) =>
    s.missingKeywords.some((m) => m.keyword.toLowerCase() === k.toLowerCase()),
  );
  checks.push({
    name: 'missing skills are listed honestly',
    passed: listed.length === fixture.mustListAsMissing.length,
    detail: `listed ${listed.join(', ') || 'none'}`,
  });
  return checks;
}

export async function runTailoringSuite(
  deps: TailoringDeps,
  fixtures: readonly TailoringFixture[],
  mode: EvalMode,
): Promise<FixtureResult[]> {
  const results: FixtureResult[] = [];
  for (const fixture of fixtures) {
    const started = Date.now();
    const out = await runTailoringFixture(deps, fixture);
    const checks = checkTailoring(fixture, out, mode);
    results.push({
      id: fixture.id,
      description: fixture.description,
      passed: checks.every((c) => c.passed),
      checks,
      runs: [],
      spread: 0,
      durationMs: Date.now() - started,
    });
  }
  return results;
}

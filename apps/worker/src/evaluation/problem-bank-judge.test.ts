import { SEED_PROBLEMS } from '@cbi/db';
import { createMockJudge, runOnJudge } from '@cbi/provider-adapters';
import { judgeTestsFor, toRunResult } from '@cbi/shared-types';
import { describe, expect, it } from 'vitest';

const noSleep = async () => undefined;

/**
 * Every seeded problem goes through the same judge path as a submission
 * (judge tests, the mock judge harness, the run result): the mock never runs
 * code, so this checks the plumbing, including SQL preludes and unordered rows.
 * The reference solutions themselves are checked in @cbi/db (problem-bank.test.ts).
 */
describe('seeded problems on the judge harness', () => {
  it.each(SEED_PROBLEMS.map((p) => [p.key, p] as const))('%s', async (_key, problem) => {
    const judge = createMockJudge();
    const cases = [
      ...problem.content.visibleTests.map((t) => ({ ...t, hidden: false })),
      ...problem.content.hiddenTests.map((t) => ({ ...t, hidden: true })),
    ];
    const tests = judgeTestsFor(problem.content, cases);
    const language = problem.content.languages[0]!;
    const judged = await runOnJudge(
      judge.adapter,
      {
        language,
        source: problem.content.starterCode[language] ?? '',
        tests,
        limits: problem.content.limits,
      },
      { waitMs: 1000, sleep: noSleep },
    );
    const result = toRunResult(
      judged,
      cases.map((c, i) => ({ ...c, compare: tests[i]!.compare })),
      new Date(),
    );
    expect(result).toMatchObject({ verdict: 'ACCEPTED', passed: cases.length });
    if (problem.content.sql) {
      expect(tests.every((t) => t.prelude?.startsWith(problem.content.sql!.setup))).toBe(true);
      expect(tests.every((t) => t.input === '')).toBe(true);
    }
    // Hidden tests never carry their data back.
    expect(result.tests.filter((t) => t.hidden).every((t) => t.stdout === null)).toBe(true);
  });
});

import type {
  CompanyStyleTag,
  Difficulty,
  ProblemLimits,
  SqlProblemSettings,
} from '@cbi/shared-types';

/**
 * One seeded coding problem. The statement is a list of paragraphs; hidden
 * tests are `[input, expectedOutput]` pairs. Starter code and languages are
 * filled in when the seed runs (every general-purpose language, or SQL only).
 */
export interface SeedProblem {
  key: string;
  /**
   * Bumped whenever the content changes. A newer revision adds a version of
   * the problem, but only while every version of its key came from the seed
   * (an admin's own version is never replaced).
   */
  revision: number;
  title: string;
  difficulty: Difficulty;
  tags: string[];
  companyTags: CompanyStyleTag[];
  statement: string[];
  /** Default: 2 s CPU and 256 MB per test. */
  limits?: ProblemLimits;
  sql?: SqlProblemSettings;
  visibleTests: { input: string; expectedOutput: string; explanation: string | null }[];
  hiddenTests: [input: string, expectedOutput: string][];
  /**
   * A reference solution (Python 3, or a SQLite query for SQL problems). It
   * is never shown to candidates; problem-bank.test.ts runs it against every
   * test with a local Python when one is installed.
   */
  reference: string;
}

import { z } from 'zod';
import { ANSWER_LIMITS } from './interview-runtime.js';
import { Difficulty } from './library.js';

/**
 * Coding rounds (Phase 9). Candidate code only ever runs on an external
 * judge reached through the JudgeAdapter; the API never executes it. Hidden
 * tests stay on the server: the browser sees only how many passed.
 */

export const CodingLanguage = z.enum(['python', 'javascript', 'java', 'cpp']);
export type CodingLanguage = z.infer<typeof CodingLanguage>;

export const CODING_LANGUAGE_LABELS: Readonly<Record<CodingLanguage, string>> = {
  python: 'Python 3',
  javascript: 'JavaScript (Node.js)',
  java: 'Java',
  cpp: 'C++',
};

export const CODING_LIMITS = {
  /** Largest source file stored or run. */
  maxCodeBytes: 64 * 1024,
  /** A run or submission waits this long for the judge before reporting it unavailable. */
  judgeWaitMs: 20_000,
  /** The browser autosaves this often while typing (and on blur). */
  autosaveMs: 5_000,
  maxTests: 30,
} as const;

/** One stdin → stdout test. */
export const ProblemTest = z.object({
  input: z.string().max(20_000),
  expectedOutput: z.string().max(20_000),
  /** Shown with visible tests. */
  explanation: z.string().trim().max(500).nullable().default(null),
});
export type ProblemTest = z.infer<typeof ProblemTest>;

export const ProblemLimits = z.object({
  cpuMs: z.number().int().min(100).max(10_000),
  memoryMb: z.number().int().min(16).max(1024),
});
export type ProblemLimits = z.infer<typeof ProblemLimits>;

export const ProblemContent = z.object({
  title: z.string().trim().min(3).max(120),
  /** Plain text with blank-line paragraphs; `inline code` in backticks. */
  statement: z.string().trim().min(20).max(8000),
  difficulty: Difficulty,
  tags: z.array(z.string().trim().min(2).max(40)).max(10),
  languages: z.array(CodingLanguage).min(1),
  starterCode: z.partialRecord(CodingLanguage, z.string().max(8000)),
  visibleTests: z.array(ProblemTest).min(1).max(5),
  hiddenTests: z.array(ProblemTest).min(1).max(CODING_LIMITS.maxTests),
  limits: ProblemLimits,
});
export type ProblemContent = z.infer<typeof ProblemContent>;

/** What the candidate sees (no hidden tests). */
export const PublicProblem = z.object({
  id: z.string(),
  title: z.string(),
  statement: z.string(),
  difficulty: Difficulty,
  languages: z.array(CodingLanguage),
  starterCode: z.partialRecord(CodingLanguage, z.string()),
  visibleTests: z.array(ProblemTest),
  hiddenTestCount: z.number().int(),
  limits: ProblemLimits,
});
export type PublicProblem = z.infer<typeof PublicProblem>;

/** Admin view (with hidden tests). */
export const ProblemSummary = ProblemContent.extend({
  id: z.string(),
  key: z.string(),
  version: z.number().int(),
  active: z.boolean(),
  createdAt: z.iso.datetime(),
});
export type ProblemSummary = z.infer<typeof ProblemSummary>;

export const CreateProblemVersionBody = z.object({
  key: z
    .string()
    .trim()
    .min(3)
    .max(60)
    .regex(/^[a-z0-9-]+$/, 'lower-case letters, digits and - only'),
  content: ProblemContent,
  reason: z.string().trim().min(3).max(300),
});
export type CreateProblemVersionBody = z.infer<typeof CreateProblemVersionBody>;

export const ProblemActivationBody = z.object({ reason: z.string().trim().min(3).max(300) });
export type ProblemActivationBody = z.infer<typeof ProblemActivationBody>;

// ---- Runs and submissions ---------------------------------------------------------------------

export const JudgeVerdict = z.enum([
  'ACCEPTED',
  'WRONG_ANSWER',
  'COMPILE_ERROR',
  'RUNTIME_ERROR',
  'TIME_LIMIT',
  'MEMORY_LIMIT',
  'JUDGE_ERROR',
]);
export type JudgeVerdict = z.infer<typeof JudgeVerdict>;

/** One test's outcome. Hidden tests carry no input/output. */
export const TestOutcome = z.object({
  hidden: z.boolean(),
  verdict: JudgeVerdict,
  /** Visible tests only (truncated). */
  stdout: z.string().nullable(),
  expectedOutput: z.string().nullable(),
  timeMs: z.number().int().nullable(),
});
export type TestOutcome = z.infer<typeof TestOutcome>;

export const CodeRunResult = z.object({
  /** ACCEPTED when every test passed; otherwise the first failure's verdict. */
  verdict: JudgeVerdict,
  passed: z.number().int(),
  total: z.number().int(),
  compileOutput: z.string().nullable(),
  tests: z.array(TestOutcome),
  at: z.iso.datetime(),
});
export type CodeRunResult = z.infer<typeof CodeRunResult>;

export const SaveCodeBody = z.object({
  language: CodingLanguage,
  code: z.string().max(CODING_LIMITS.maxCodeBytes),
});
export type SaveCodeBody = z.infer<typeof SaveCodeBody>;

export const CodingSubmission = z.object({
  at: z.iso.datetime(),
  language: CodingLanguage,
  /** Null when the judge was unavailable (the code is still submitted). */
  result: CodeRunResult.nullable(),
  judgeUnavailable: z.boolean(),
});
export type CodingSubmission = z.infer<typeof CodingSubmission>;

/** The coding workspace for one coding question. */
export const CodingWorkspace = z.object({
  questionId: z.string(),
  problem: PublicProblem,
  language: CodingLanguage,
  code: z.string(),
  autosavedAt: z.iso.datetime().nullable(),
  lastRun: CodeRunResult.nullable(),
  submission: CodingSubmission.nullable(),
});
export type CodingWorkspace = z.infer<typeof CodingWorkspace>;

/** Report section per coding problem. */
export const CodingReportItem = z.object({
  title: z.string(),
  difficulty: Difficulty,
  language: CodingLanguage.nullable(),
  submitted: z.boolean(),
  passed: z.number().int().nullable(),
  total: z.number().int().nullable(),
  verdict: JudgeVerdict.nullable(),
  /** The judge could not run the code; the review relied on reading it. */
  judgeUnavailable: z.boolean(),
});
export type CodingReportItem = z.infer<typeof CodingReportItem>;

/** Judge-derived evidence strength from the share of tests passed (-2 … +2). */
export function codingStrength(passed: number, total: number, compiled = true): number {
  if (!compiled || total === 0) return -2;
  const rate = passed / total;
  if (rate >= 1) return 2;
  if (rate >= 0.75) return 1;
  if (rate >= 0.4) return 0;
  if (rate > 0) return -1;
  return -2;
}

/**
 * The candidate-facing result of a judge run. `tests` pairs each judged test
 * with whether it is hidden: hidden tests report only their verdict, never
 * their input or output.
 */
export function toRunResult(
  judged: {
    compileOutput: string | null;
    tests: readonly { verdict: JudgeVerdict; stdout: string | null; timeMs: number | null }[];
  },
  tests: readonly { hidden: boolean; expectedOutput: string }[],
  at: Date,
): CodeRunResult {
  const clip = (s: string | null) =>
    s == null ? null : s.length > 2000 ? `${s.slice(0, 2000)}…` : s;
  const outcomes = tests.map((t, i) => {
    const r = judged.tests[i];
    const verdict: JudgeVerdict = r?.verdict ?? 'JUDGE_ERROR';
    return {
      hidden: t.hidden,
      verdict,
      stdout: t.hidden ? null : clip(r?.stdout ?? null),
      expectedOutput: t.hidden ? null : clip(t.expectedOutput),
      timeMs: r?.timeMs ?? null,
    };
  });
  const passed = outcomes.filter((o) => o.verdict === 'ACCEPTED').length;
  const firstFailure = outcomes.find((o) => o.verdict !== 'ACCEPTED');
  return {
    verdict: firstFailure ? firstFailure.verdict : 'ACCEPTED',
    passed,
    total: outcomes.length,
    compileOutput: clip(judged.compileOutput),
    tests: outcomes,
    at: at.toISOString(),
  };
}

/** The answer recorded for a submitted solution: the result summary and the code. */
export function submissionAnswerText(opts: {
  language: CodingLanguage;
  code: string;
  result: CodeRunResult | null;
}): string {
  const head = opts.result
    ? `Submitted a ${CODING_LANGUAGE_LABELS[opts.language]} solution: ${opts.result.passed} of ${opts.result.total} tests passed (${opts.result.verdict.toLowerCase().replace('_', ' ')}).`
    : `Submitted a ${CODING_LANGUAGE_LABELS[opts.language]} solution. The code judge was unavailable, so it was not run.`;
  const room = ANSWER_LIMITS.maxChars - head.length - 20;
  const code = opts.code.length > room ? `${opts.code.slice(0, room)}\n…` : opts.code;
  return `${head}\n\n${code}`;
}

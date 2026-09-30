import { z } from 'zod';
import { ANSWER_LIMITS } from './interview-runtime.js';
import { Difficulty } from './library.js';

/**
 * Coding rounds (Phase 9). Candidate code only ever runs on an external
 * judge reached through the JudgeAdapter; the API never executes it. Hidden
 * tests stay on the server: the browser sees only how many passed.
 */

export const CodingLanguage = z.enum([
  'python',
  'javascript',
  'java',
  'cpp',
  'typescript',
  'go',
  'csharp',
  'c',
  'kotlin',
  'rust',
  'sql',
]);
export type CodingLanguage = z.infer<typeof CodingLanguage>;

export const CODING_LANGUAGE_LABELS: Readonly<Record<CodingLanguage, string>> = {
  python: 'Python 3',
  javascript: 'JavaScript (Node.js)',
  java: 'Java',
  cpp: 'C++',
  typescript: 'TypeScript',
  go: 'Go',
  csharp: 'C#',
  c: 'C',
  kotlin: 'Kotlin',
  rust: 'Rust',
  sql: 'SQL (SQLite)',
};

/** General-purpose languages (stdin → stdout). SQL problems use `sql` alone. */
export const PROGRAM_LANGUAGES = CodingLanguage.options.filter(
  (l): l is Exclude<CodingLanguage, 'sql'> => l !== 'sql',
);

/**
 * Overrides for the judge's language ids, written `language=id` separated by
 * commas (e.g. `typescript=94,go=95`). Self-hosted Judge0 installs differ, so
 * the defaults can be replaced per language from the environment or the admin
 * integration settings. Returns the overrides, or what is wrong.
 */
export function parseLanguageIds(
  value: string | null | undefined,
): { ok: true; ids: Partial<Record<CodingLanguage, number>> } | { ok: false; error: string } {
  const ids: Partial<Record<CodingLanguage, number>> = {};
  const text = (value ?? '').trim();
  if (!text) return { ok: true, ids };
  for (const part of text.split(',')) {
    const [name, raw, extra] = part.split('=').map((x) => x.trim());
    const lang = CodingLanguage.safeParse(name);
    if (!lang.success || extra !== undefined || !/^[1-9]\d{0,3}$/.test(raw ?? '')) {
      return { ok: false, error: `"${part.trim()}" is not language=id (e.g. typescript=94)` };
    }
    ids[lang.data] = Number(raw);
  }
  return { ok: true, ids };
}

export const CODING_LIMITS = {
  /** Largest source file stored or run. */
  maxCodeBytes: 64 * 1024,
  /** A run or submission waits this long for the judge before reporting it unavailable. */
  judgeWaitMs: 20_000,
  /** The browser autosaves this often while typing (and on blur). */
  autosaveMs: 5_000,
  maxTests: 30,
  /** "Run with my input": the largest stdin a candidate can send. */
  maxCustomInputBytes: 16 * 1024,
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

/**
 * Generic interview-style labels (never company names): the kind of employer
 * that tends to ask a problem like this.
 */
export const CompanyStyleTag = z.enum([
  'product-company',
  'service-company',
  'fintech',
  'startup',
  'e-commerce',
  'enterprise-saas',
]);
export type CompanyStyleTag = z.infer<typeof CompanyStyleTag>;

/**
 * SQL problems (language `sql`, SQLite on the judge). The setup script (the
 * schema) and then each test's `input` (its rows) run before the candidate's
 * query in the same program; the query's output is the program output.
 */
export const SqlProblemSettings = z.object({
  setup: z.string().max(20_000),
  /** Rows may come back in any order: output lines are compared after sorting. */
  orderInsensitive: z.boolean(),
});
export type SqlProblemSettings = z.infer<typeof SqlProblemSettings>;

export const ProblemContent = z.object({
  title: z.string().trim().min(3).max(120),
  /** Plain text with blank-line paragraphs; `inline code` in backticks. */
  statement: z.string().trim().min(20).max(8000),
  difficulty: Difficulty,
  tags: z.array(z.string().trim().min(2).max(40)).max(10),
  /** Absent on problems created before company-style tags existed. */
  companyTags: z.array(CompanyStyleTag).max(4).optional(),
  languages: z.array(CodingLanguage).min(1),
  starterCode: z.partialRecord(CodingLanguage, z.string().max(8000)),
  visibleTests: z.array(ProblemTest).min(1).max(5),
  hiddenTests: z.array(ProblemTest).min(1).max(CODING_LIMITS.maxTests),
  limits: ProblemLimits,
  /** Set exactly when the problem is a SQL problem (absent on older problems). */
  sql: SqlProblemSettings.nullable().optional(),
});
export type ProblemContent = z.infer<typeof ProblemContent>;

/** Rules the object schema cannot express: SQL problems are SQL-only, other problems never SQL. */
export function problemContentIssues(
  c: Pick<ProblemContent, 'languages' | 'sql'>,
): { path: string[]; message: string }[] {
  const issues: { path: string[]; message: string }[] = [];
  const hasSql = c.languages.includes('sql');
  if (c.sql && (c.languages.length !== 1 || !hasSql)) {
    issues.push({ path: ['sql'], message: 'a SQL problem uses the sql language only' });
  }
  if (!c.sql && hasSql) {
    issues.push({ path: ['sql'], message: 'the sql language needs a SQL setup script' });
  }
  if (new Set(c.languages).size !== c.languages.length) {
    issues.push({ path: ['languages'], message: 'languages must be unique' });
  }
  return issues;
}

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
  /** SQL problems: the schema, so the candidate knows the tables (null otherwise). */
  sqlSetup: z.string().nullable(),
  /** SQL problems: the row order of the result does not matter. */
  orderInsensitive: z.boolean(),
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

export const CreateProblemVersionBody = z
  .object({
    key: z
      .string()
      .trim()
      .min(3)
      .max(60)
      .regex(/^[a-z0-9-]+$/, 'lower-case letters, digits and - only'),
    content: ProblemContent,
    reason: z.string().trim().min(3).max(300),
  })
  .superRefine((body, ctx) => {
    for (const issue of problemContentIssues(body.content)) {
      ctx.addIssue({ code: 'custom', path: ['content', ...issue.path], message: issue.message });
    }
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

/**
 * How a test's output is checked: exactly (the judge compares), as lines in
 * any order (compared here, after the run), or not at all (custom input).
 */
export type TestCompare = 'EXACT' | 'UNORDERED_LINES' | 'NONE';

/** One test as sent to the judge. */
export interface JudgeTestSpec {
  input: string;
  expectedOutput: string;
  /** Runs before the source in the same program (SQL schema and rows); stdin is then empty. */
  prelude?: string;
  compare?: TestCompare;
}

/**
 * The judge tests for a problem's tests. SQL problems move the schema and
 * each test's rows into the prelude, and compare rows in any order when the
 * problem says so.
 */
export function judgeTestsFor(
  content: Pick<ProblemContent, 'sql'>,
  tests: readonly { input: string; expectedOutput: string }[],
): JudgeTestSpec[] {
  const sql = content.sql ?? null;
  return tests.map((t) =>
    sql
      ? {
          input: '',
          expectedOutput: t.expectedOutput,
          prelude: `${sql.setup}\n${t.input}`,
          compare: sql.orderInsensitive ? 'UNORDERED_LINES' : 'EXACT',
        }
      : { input: t.input, expectedOutput: t.expectedOutput, compare: 'EXACT' },
  );
}

/** Output lines with trailing spaces and blank trailing lines removed (what the judges ignore). */
export const outputLines = (s: string | null) => {
  const lines = (s ?? '')
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((l) => l.trimEnd());
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines;
};

/** Whether two outputs hold the same lines, in any order. */
export function sameLinesUnordered(actual: string | null, expected: string): boolean {
  const a = outputLines(actual).sort();
  const b = outputLines(expected).sort();
  return a.length === b.length && a.every((line, i) => line === b[i]);
}

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

/** "Run with my input": the code with the candidate's own stdin (SQL: extra statements run first). */
export const CustomRunBody = SaveCodeBody.extend({
  stdin: z.string().max(CODING_LIMITS.maxCustomInputBytes),
});
export type CustomRunBody = z.infer<typeof CustomRunBody>;

/**
 * The outcome of a run with the candidate's own input. Nothing is compared:
 * ACCEPTED means the program finished normally. Never counted as a test.
 */
export const CustomRunResult = z.object({
  verdict: JudgeVerdict,
  stdout: z.string().nullable(),
  stderr: z.string().nullable(),
  compileOutput: z.string().nullable(),
  timeMs: z.number().int().nullable(),
  at: z.iso.datetime(),
});
export type CustomRunResult = z.infer<typeof CustomRunResult>;

export const CodingSubmission = z.object({
  at: z.iso.datetime(),
  language: CodingLanguage,
  /** Null when the judge was unavailable (the code is still submitted). */
  result: CodeRunResult.nullable(),
  judgeUnavailable: z.boolean(),
});
export type CodingSubmission = z.infer<typeof CodingSubmission>;

// ---- AI-assisted coding ------------------------------------------------------------------------

/**
 * A round may allow an in-editor AI assistant (off unless the template turns
 * it on). The whole conversation is kept and evaluated as "AI collaboration".
 */
export const AI_ASSIST_LIMITS = {
  maxMessageChars: 1000,
  maxReplyChars: 2400,
  /** Candidate messages per coding question, at most (a round may allow fewer). */
  maxTurns: 30,
  defaultTurns: 12,
  /** Output token budget per reply. */
  maxOutputTokens: 700,
} as const;

export const AssistantMessage = z.object({
  role: z.enum(['CANDIDATE', 'ASSISTANT']),
  text: z.string(),
  at: z.iso.datetime(),
  /** The assistant could not answer (the message did not count as a turn). */
  unavailable: z.boolean().default(false),
  /** Code was removed from the reply because full solutions are not allowed. */
  redacted: z.boolean().default(false),
});
export type AssistantMessage = z.infer<typeof AssistantMessage>;

export const AssistantState = z.object({
  /** When false the candidate may ask for hints and snippets but not complete solutions. */
  allowFullSolutions: z.boolean(),
  maxTurns: z.number().int(),
  turnsUsed: z.number().int(),
  messages: z.array(AssistantMessage),
});
export type AssistantState = z.infer<typeof AssistantState>;

export const AssistBody = SaveCodeBody.extend({
  message: z.string().trim().min(1).max(AI_ASSIST_LIMITS.maxMessageChars),
});
export type AssistBody = z.infer<typeof AssistBody>;

/** Structured output of `coding.assist`. */
export const CodingAssistAi = z.object({
  reply: z.string().trim().min(1).max(AI_ASSIST_LIMITS.maxReplyChars),
});
export type CodingAssistAi = z.infer<typeof CodingAssistAi>;

/** Code lines a reply may contain when full solutions are not allowed. */
export const ASSIST_MAX_SNIPPET_LINES = 12;

/**
 * Removes code blocks longer than a short snippet from an assistant reply
 * (the prompt already forbids full solutions; this enforces it). Returns the
 * reply and whether anything was removed.
 */
export function redactLongCode(
  reply: string,
  maxLines = ASSIST_MAX_SNIPPET_LINES,
): { text: string; redacted: boolean } {
  let redacted = false;
  const note = '[Code removed: in this round the assistant can only show short snippets.]';
  let text = reply.replace(/```[^\n]*\n([\s\S]*?)(```|$)/g, (block, body: string) => {
    const lines = body.split('\n').filter((l) => l.trim() !== '').length;
    if (lines <= maxLines) return block;
    redacted = true;
    return note;
  });
  // Long unfenced code (many consecutive indented or brace-heavy lines) is cut too.
  const lines = text.split('\n');
  let run = 0;
  let start = -1;
  const out: string[] = [];
  const codeLike = (l: string) => /^(\s{2,}|\t)\S/.test(l) || /[;{}]\s*$/.test(l);
  const flush = (end: number) => {
    if (run > maxLines) {
      redacted = true;
      out.push(note);
    } else {
      out.push(...lines.slice(start, end));
    }
    run = 0;
    start = -1;
  };
  lines.forEach((l, i) => {
    if (codeLike(l)) {
      if (start < 0) start = i;
      run += 1;
      return;
    }
    if (start >= 0) flush(i);
    out.push(l);
  });
  if (start >= 0) flush(lines.length);
  text = out.join('\n');
  return { text, redacted };
}

/** The coding workspace for one coding question. */
export const CodingWorkspace = z.object({
  questionId: z.string(),
  problem: PublicProblem,
  language: CodingLanguage,
  code: z.string(),
  autosavedAt: z.iso.datetime().nullable(),
  lastRun: CodeRunResult.nullable(),
  submission: CodingSubmission.nullable(),
  /** Null unless the round allows the AI assistant. */
  assistant: AssistantState.nullable(),
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
  /** The round allowed the AI assistant (absent in older reports). */
  aiAssisted: z.boolean().optional(),
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

const clip = (s: string | null, max = 2000) =>
  s == null ? null : s.length > max ? `${s.slice(0, max)}…` : s;

/**
 * The candidate-facing result of a judge run. `tests` pairs each judged test
 * with whether it is hidden: hidden tests report only their verdict, never
 * their input or output. Tests compared as unordered lines are checked here
 * (the judge only ran them).
 */
export function toRunResult(
  judged: {
    compileOutput: string | null;
    tests: readonly { verdict: JudgeVerdict; stdout: string | null; timeMs: number | null }[];
  },
  tests: readonly { hidden: boolean; expectedOutput: string; compare?: TestCompare }[],
  at: Date,
): CodeRunResult {
  const outcomes = tests.map((t, i) => {
    const r = judged.tests[i];
    let verdict: JudgeVerdict = r?.verdict ?? 'JUDGE_ERROR';
    if (t.compare === 'UNORDERED_LINES' && (verdict === 'ACCEPTED' || verdict === 'WRONG_ANSWER')) {
      verdict = sameLinesUnordered(r?.stdout ?? null, t.expectedOutput)
        ? 'ACCEPTED'
        : 'WRONG_ANSWER';
    }
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

/** The result of a custom-input run: nothing is compared, so a finished run is ACCEPTED. */
export function toCustomRunResult(
  judged: {
    compileOutput: string | null;
    tests: readonly {
      verdict: JudgeVerdict;
      stdout: string | null;
      stderr: string | null;
      timeMs: number | null;
    }[];
  },
  at: Date,
): CustomRunResult {
  const r = judged.tests[0];
  const verdict: JudgeVerdict = !r
    ? 'JUDGE_ERROR'
    : r.verdict === 'WRONG_ANSWER'
      ? 'ACCEPTED'
      : r.verdict;
  return {
    verdict,
    stdout: clip(r?.stdout ?? null, 8000),
    stderr: clip(r?.stderr ?? null),
    compileOutput: clip(judged.compileOutput),
    timeMs: r?.timeMs ?? null,
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

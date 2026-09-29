import { describe, expect, it } from 'vitest';
import {
  CreateProblemVersionBody,
  judgeTestsFor,
  parseLanguageIds,
  problemContentIssues,
  redactLongCode,
  sameLinesUnordered,
  toCustomRunResult,
  toRunResult,
} from './coding.js';

describe('judge language id overrides', () => {
  it('parses language=id pairs and refuses anything else', () => {
    expect(parseLanguageIds('typescript=94, go = 95')).toEqual({
      ok: true,
      ids: { typescript: 94, go: 95 },
    });
    expect(parseLanguageIds('')).toEqual({ ok: true, ids: {} });
    expect(parseLanguageIds(undefined)).toEqual({ ok: true, ids: {} });
    for (const bad of ['cobol=1', 'go=', 'go=abc', 'go=0', 'go=1=2', 'go']) {
      expect(parseLanguageIds(bad).ok).toBe(false);
    }
  });
});

describe('problem content rules', () => {
  it('keeps SQL problems SQL-only and needs a setup script for sql', () => {
    expect(
      problemContentIssues({ languages: ['sql'], sql: { setup: '', orderInsensitive: true } }),
    ).toEqual([]);
    expect(problemContentIssues({ languages: ['python'] })).toEqual([]);
    expect(
      problemContentIssues({
        languages: ['sql', 'python'],
        sql: { setup: '', orderInsensitive: false },
      }),
    ).toHaveLength(1);
    expect(problemContentIssues({ languages: ['sql'], sql: null })[0]!.path).toEqual(['sql']);
    expect(problemContentIssues({ languages: ['go', 'go'] })[0]!.message).toMatch(/unique/);
  });

  it('reports the rules as validation issues on the create body', () => {
    const parsed = CreateProblemVersionBody.safeParse({
      key: 'sql-demo',
      reason: 'new problem',
      content: {
        title: 'Demo',
        statement: 'A statement long enough to pass validation.',
        difficulty: 'EASY',
        tags: [],
        languages: ['sql'],
        starterCode: {},
        visibleTests: [{ input: '', expectedOutput: '1\n', explanation: null }],
        hiddenTests: [{ input: '', expectedOutput: '1\n', explanation: null }],
        limits: { cpuMs: 1000, memoryMb: 64 },
      },
    });
    expect(parsed.success).toBe(false);
    expect(parsed.error!.issues[0]!.path).toEqual(['content', 'sql']);
  });
});

describe('judge tests for a problem', () => {
  const tests = [{ input: 'INSERT INTO t VALUES (1);', expectedOutput: '1\n' }];

  it('moves SQL schema and rows into the prelude', () => {
    expect(
      judgeTestsFor({ sql: { setup: 'CREATE TABLE t(x);', orderInsensitive: true } }, tests),
    ).toEqual([
      {
        input: '',
        expectedOutput: '1\n',
        prelude: 'CREATE TABLE t(x);\nINSERT INTO t VALUES (1);',
        compare: 'UNORDERED_LINES',
      },
    ]);
    expect(judgeTestsFor({ sql: { setup: 'S', orderInsensitive: false } }, tests)[0]!.compare).toBe(
      'EXACT',
    );
  });

  it('passes stdin tests through for other problems', () => {
    expect(judgeTestsFor({}, tests)).toEqual([{ ...tests[0], compare: 'EXACT' }]);
  });
});

describe('run results', () => {
  const at = new Date('2026-09-01T00:00:00Z');

  it('compares unordered tests by their lines in any order', () => {
    expect(sameLinesUnordered('b|2\na|1\n', 'a|1\nb|2\n')).toBe(true);
    expect(sameLinesUnordered('a|1  \r\nb|2\n\n', 'b|2\na|1')).toBe(true);
    expect(sameLinesUnordered('a|1\n', 'a|1\nb|2\n')).toBe(false);
    expect(sameLinesUnordered(null, '')).toBe(true);
    const result = toRunResult(
      {
        compileOutput: null,
        tests: [
          { verdict: 'ACCEPTED', stdout: 'b\na\n', timeMs: 1 },
          { verdict: 'ACCEPTED', stdout: 'c\n', timeMs: 1 },
          { verdict: 'RUNTIME_ERROR', stdout: null, timeMs: 1 },
        ],
      },
      [
        { hidden: false, expectedOutput: 'a\nb\n', compare: 'UNORDERED_LINES' },
        { hidden: true, expectedOutput: 'a\n', compare: 'UNORDERED_LINES' },
        { hidden: true, expectedOutput: 'a\n', compare: 'UNORDERED_LINES' },
      ],
      at,
    );
    expect(result.tests.map((t) => t.verdict)).toEqual([
      'ACCEPTED',
      'WRONG_ANSWER',
      'RUNTIME_ERROR',
    ]);
    expect(result).toMatchObject({ passed: 1, total: 3, verdict: 'WRONG_ANSWER' });
    // Hidden tests never carry their output.
    expect(result.tests[1]).toMatchObject({ stdout: null, expectedOutput: null });
  });

  it('reports a custom-input run without comparing anything', () => {
    const ran = toCustomRunResult(
      {
        compileOutput: null,
        tests: [{ verdict: 'WRONG_ANSWER', stdout: 'hi\n', stderr: null, timeMs: 4 }],
      },
      at,
    );
    expect(ran).toMatchObject({ verdict: 'ACCEPTED', stdout: 'hi\n', timeMs: 4 });
    expect(toCustomRunResult({ compileOutput: 'x', tests: [] }, at).verdict).toBe('JUDGE_ERROR');
  });
});

describe('assistant replies without full solutions', () => {
  it('keeps short snippets and prose and removes long code', () => {
    const short = 'Try a hash map:\n```python\nseen = {}\nfor x in xs:\n    seen[x] = True\n```';
    expect(redactLongCode(short)).toEqual({ text: short, redacted: false });
    const long = `Here it is:\n\`\`\`python\n${Array.from({ length: 20 }, (_, i) => `x${i} = ${i}`).join('\n')}\n\`\`\`\nGood luck.`;
    const out = redactLongCode(long);
    expect(out.redacted).toBe(true);
    expect(out.text).toContain('Code removed');
    expect(out.text).toContain('Good luck.');
    expect(out.text).not.toContain('x19');
    // Unfenced code is caught too.
    const unfenced = `Solution:\n${Array.from({ length: 16 }, (_, i) => `    total += ${i};`).join('\n')}\nDone.`;
    expect(redactLongCode(unfenced).redacted).toBe(true);
    expect(redactLongCode('A sentence.\nAnother sentence.').redacted).toBe(false);
  });
});

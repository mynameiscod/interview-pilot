import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { CompanyStyleTag, PROGRAM_LANGUAGES } from '@cbi/shared-types';
import { describe, expect, it } from 'vitest';
import { PROBLEM_BANK } from './problem-bank/index.js';
import { SEED_PROBLEMS, starterCode } from './problems.js';

/** A local Python 3 for checking the reference solutions (the check is skipped without one). */
function findPython(): string | null {
  for (const cmd of ['python3', 'python']) {
    const r = spawnSync(cmd, ['-c', 'import sys, sqlite3; print(sys.version_info[0])'], {
      encoding: 'utf8',
    });
    if (r.status === 0 && r.stdout.trim() === '3') return cmd;
  }
  return null;
}
const python = findPython();

describe('seeded problem bank', () => {
  it('has about 40 problems with a balance of difficulties and unique keys', () => {
    expect(PROBLEM_BANK.length).toBeGreaterThanOrEqual(40);
    const keys = PROBLEM_BANK.map((p) => p.key);
    expect(new Set(keys).size).toBe(keys.length);
    const count = (d: string) => PROBLEM_BANK.filter((p) => p.difficulty === d).length;
    expect(count('EASY')).toBeGreaterThanOrEqual(10);
    expect(count('MEDIUM')).toBeGreaterThanOrEqual(12);
    expect(count('HARD')).toBeGreaterThanOrEqual(8);
  });

  it('covers every topic the coding rounds draw on', () => {
    const tags = new Set(PROBLEM_BANK.flatMap((p) => p.tags));
    for (const topic of [
      'arrays',
      'strings',
      'hashing',
      'two-pointers',
      'sliding-window',
      'stacks',
      'queues',
      'trees',
      'graphs',
      'bfs',
      'dfs',
      'heaps',
      'dynamic-programming',
      'intervals',
      'sql',
      'joins',
      'group-by',
      'window-functions',
    ]) {
      expect(tags, topic).toContain(topic);
    }
  });

  it('gives every problem visible tests, at least 8 hidden tests and generic company tags only', () => {
    for (const p of PROBLEM_BANK) {
      expect(p.visibleTests.length, p.key).toBeGreaterThanOrEqual(1);
      expect(p.hiddenTests.length, p.key).toBeGreaterThanOrEqual(8);
      expect(p.companyTags.length, p.key).toBeGreaterThan(0);
      for (const tag of p.companyTags) expect(CompanyStyleTag.options).toContain(tag);
      const inputs = [...p.visibleTests.map((t) => t.input), ...p.hiddenTests.map(([i]) => i)];
      expect(new Set(inputs).size, `${p.key}: duplicate test`).toBe(inputs.length);
      // Every test is an edge case or a larger case with a real expected output.
      for (const [input, output] of p.hiddenTests) {
        expect(input.length, p.key).toBeLessThanOrEqual(20_000);
        if (!p.sql) expect(output.trim(), p.key).not.toBe('');
      }
    }
  });

  it('builds valid problem versions: SQL problems in SQL only, the others in every language', () => {
    expect(SEED_PROBLEMS).toHaveLength(PROBLEM_BANK.length);
    for (const s of SEED_PROBLEMS) {
      if (s.content.sql) {
        expect(s.content.languages).toEqual(['sql']);
        expect(Object.keys(s.content.starterCode)).toEqual(['sql']);
      } else {
        expect(s.content.languages).toEqual([...PROGRAM_LANGUAGES]);
        for (const lang of PROGRAM_LANGUAGES) {
          expect(s.content.starterCode[lang], `${s.key} ${lang}`).toContain(s.content.title);
        }
      }
    }
    expect(PROBLEM_BANK.filter((p) => p.sql).length).toBeGreaterThanOrEqual(4);
  });

  it('writes starter code that reads standard input in every language', () => {
    const starters = starterCode('Demo');
    expect(Object.keys(starters).sort()).toEqual([...PROGRAM_LANGUAGES].sort());
    expect(starters.go).toContain('package main');
    expect(starters.typescript).toContain('declare const require');
    expect(starters.csharp).toContain('Console.In.ReadToEnd()');
    expect(starters.rust).toContain('read_to_string');
  });

  // Runs each reference solution on every test with a local Python (never on an
  // interview server). Skipped when Python 3 is not installed.
  it.skipIf(!python)(
    'reference solutions produce every expected output',
    () => {
      const script = fileURLToPath(new URL('./problem-bank/verify_references.py', import.meta.url));
      const payload = PROBLEM_BANK.map((p) => ({
        key: p.key,
        sql: p.sql ?? null,
        reference: p.reference,
        tests: [
          ...p.visibleTests.map((t) => ({ input: t.input, expectedOutput: t.expectedOutput })),
          ...p.hiddenTests.map(([input, expectedOutput]) => ({ input, expectedOutput })),
        ],
      }));
      const r = spawnSync(python!, [script], {
        input: JSON.stringify(payload),
        encoding: 'utf8',
        maxBuffer: 16 * 1024 * 1024,
        timeout: 120_000,
      });
      expect(r.status, r.stderr).toBe(0);
      expect(JSON.parse(r.stdout)).toEqual([]);
    },
    150_000,
  );
});

import type { ProblemRecord } from '@cbi/db';
import { describe, expect, it } from 'vitest';
import { sqlPool } from './coding.service.js';

const problem = (key: string, sql: boolean) =>
  ({
    key,
    content: { sql: sql ? { setup: 'CREATE TABLE t (x);', orderInsensitive: true } : null },
  }) as unknown as ProblemRecord;

const bank = [problem('two-sum', false), problem('join-orders', true), problem('trees', false)];
const keys = (list: ProblemRecord[]) => list.map((p) => p.key);
const blueprint = (names: string[], skills: string[] = []) => ({
  competencies: names.map((name) => ({ key: name.toLowerCase().replace(/\W+/g, '-'), name })),
  focusSkills: skills.map((name) => ({ name, weight: 10, source: 'JD' as const })),
});
const target = (competencyName: string | null = null) => ({
  competencyKey: competencyName?.toLowerCase() ?? null,
  competencyName,
});

describe('SQL problems in coding rounds', () => {
  it('keeps SQL problems away from roles that do not assess SQL', () => {
    expect(keys(sqlPool(bank, target('Algorithms'), blueprint(['Algorithms'])))).toEqual([
      'two-sum',
      'trees',
    ]);
    expect(keys(sqlPool(bank, target(), null))).toEqual(['two-sum', 'trees']);
  });

  it('offers every problem to a role that mentions SQL', () => {
    expect(
      keys(sqlPool(bank, target('Statistics'), blueprint(['Statistics'], ['SQL', 'Excel']))),
    ).toEqual(['two-sum', 'join-orders', 'trees']);
  });

  it('asks SQL problems in a round aimed at a SQL competency', () => {
    expect(
      keys(sqlPool(bank, target('SQL and data retrieval'), blueprint(['SQL and data retrieval']))),
    ).toEqual(['join-orders']);
    // No SQL problem in the bank: any problem.
    expect(keys(sqlPool([bank[0]!], target('SQL'), null))).toEqual(['two-sum']);
  });
});

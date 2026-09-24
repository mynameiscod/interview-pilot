import type {
  CodeRunResult,
  CodingSubmission,
  CodingWorkspace,
  LiveQuestion,
  PublicProblem,
} from '@cbi/shared-types';
import { makeQuestion } from './fake-socket';

const AT = '2026-09-20T10:10:00.000Z';

export const PYTHON_STARTER = 'def solve():\n    pass\n';
export const JAVA_STARTER = 'class Main {\n    public static void main(String[] a) {}\n}\n';

export function makeProblem(overrides: Partial<PublicProblem> = {}): PublicProblem {
  return {
    id: 'p1',
    title: 'Sum of two numbers',
    statement:
      'Read two integers and print their sum.\n\nThe input is one line with `a` and `b` separated by a space.',
    difficulty: 'EASY',
    languages: ['python', 'java'],
    starterCode: { python: PYTHON_STARTER, java: JAVA_STARTER },
    visibleTests: [
      { input: '1 2', expectedOutput: '3', explanation: 'One plus two is `3`.' },
      { input: '5 5', expectedOutput: '10', explanation: null },
    ],
    hiddenTestCount: 3,
    limits: { cpuMs: 2000, memoryMb: 256 },
    ...overrides,
  };
}

export function makeWorkspace(overrides: Partial<CodingWorkspace> = {}): CodingWorkspace {
  return {
    questionId: 'q1',
    problem: makeProblem(),
    language: 'python',
    code: PYTHON_STARTER,
    autosavedAt: null,
    lastRun: null,
    submission: null,
    ...overrides,
  };
}

export function makeRunResult(overrides: Partial<CodeRunResult> = {}): CodeRunResult {
  return {
    verdict: 'WRONG_ANSWER',
    passed: 1,
    total: 2,
    compileOutput: null,
    tests: [
      { hidden: false, verdict: 'ACCEPTED', stdout: '3', expectedOutput: '3', timeMs: 12 },
      { hidden: false, verdict: 'WRONG_ANSWER', stdout: '9', expectedOutput: '10', timeMs: 11 },
    ],
    at: AT,
    ...overrides,
  };
}

export function makeSubmission(overrides: Partial<CodingSubmission> = {}): CodingSubmission {
  return {
    at: AT,
    language: 'python',
    result: makeRunResult({
      verdict: 'WRONG_ANSWER',
      passed: 4,
      total: 5,
      tests: [
        { hidden: false, verdict: 'ACCEPTED', stdout: '3', expectedOutput: '3', timeMs: 10 },
        { hidden: false, verdict: 'ACCEPTED', stdout: '10', expectedOutput: '10', timeMs: 10 },
        { hidden: true, verdict: 'ACCEPTED', stdout: null, expectedOutput: null, timeMs: 10 },
        { hidden: true, verdict: 'ACCEPTED', stdout: null, expectedOutput: null, timeMs: 10 },
        { hidden: true, verdict: 'TIME_LIMIT', stdout: null, expectedOutput: null, timeMs: 2000 },
      ],
    }),
    judgeUnavailable: false,
    ...overrides,
  };
}

export function makeCodingQuestion(overrides: Partial<LiveQuestion> = {}): LiveQuestion {
  return makeQuestion({
    questionId: 'q1',
    seq: 1,
    roundType: 'CODING',
    text: 'Please solve this coding problem.',
    coding: { problemId: 'p1', title: 'Sum of two numbers' },
    ...overrides,
  });
}

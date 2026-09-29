import type { ChatMessage, PromptTemplateData } from '@cbi/ai-core';
import type { AiRuntime } from '@cbi/ai-runtime';
import { createLogger } from '@cbi/config';
import type { CodingAttemptRecord, ProblemRecord } from '@cbi/db';
import { describe, expect, it } from 'vitest';
import type { CodingContext } from './coding.js';
import { aiCollaborationPanel, assistantTranscript } from './panels.js';

function runtime(data: unknown | Error) {
  const sent: ChatMessage[][] = [];
  const prompt: PromptTemplateData = {
    id: 'p1',
    key: 'evaluation.aiCollaboration',
    version: 3,
    locale: 'en',
    feature: 'evaluation.aiCollaboration',
    messages: [
      { role: 'system', content: 'Assess.' },
      { role: 'user', content: '{{dimensions}}\n{{problems}}\n{{conversation}}\n{{final}}' },
    ],
  };
  const ai = {
    prompts: { getActive: async () => prompt },
    router: {
      run: async (_f: string, request: { messages: ChatMessage[] }) => {
        sent.push(request.messages);
        if (data instanceof Error) throw data;
        return { data, model: { modelId: 'test' } };
      },
    },
  } as unknown as AiRuntime;
  return { deps: { ai, logger: createLogger({ service: 'test', level: 'silent' }) }, sent };
}

const problemId = '64b000000000000000000001' as unknown as ProblemRecord['_id'];
const at = new Date('2026-09-01T10:00:00Z');

function coding(
  messages: NonNullable<CodingAttemptRecord['assistant']>['messages'],
): CodingContext {
  const attempt = {
    _id: 'a1',
    problemId,
    questionId: 'q1',
    language: 'python',
    code: 'def solve(): pass',
    submission: {
      at,
      language: 'python',
      code: 'seen = {}\nfor x in xs: pass',
      result: { passed: 4, total: 5 },
      judgeUnavailable: false,
      source: 'CANDIDATE',
    },
    assistant: { turnsUsed: 1, messages },
  } as unknown as CodingAttemptRecord;
  const problem = { _id: problemId, content: { title: 'Pair sum indices' } } as ProblemRecord;
  return { attempts: [attempt], problems: new Map([[String(problemId), problem]]) };
}

const asked = (text: string) => ({
  role: 'CANDIDATE' as const,
  text,
  at,
  unavailable: false,
  redacted: false,
  codeSnapshot: 'def solve(): pass',
  model: null,
  promptVersion: null,
});
const answered = (text: string) => ({
  role: 'ASSISTANT' as const,
  text,
  at,
  unavailable: false,
  redacted: false,
  codeSnapshot: null,
  model: 'test',
  promptVersion: 1,
});

describe('AI collaboration panel', () => {
  it('is absent when the assistant was not used', async () => {
    expect(assistantTranscript(coding([]))).toBeNull();
    const { deps, sent } = runtime({});
    expect(await aiCollaborationPanel(deps, coding([]))).toBeNull();
    expect(sent).toHaveLength(0);
  });

  it('scores the known dimensions and keeps only quotes the candidate really wrote', async () => {
    const { deps, sent } = runtime({
      dimensions: [
        {
          key: 'prompt-quality',
          score: 80,
          rationale: 'Asked a focused question about complexity.',
          evidence: [
            { source: 'TRANSCRIPT', quote: 'Is a hash map O(n) here?' },
            { source: 'TRANSCRIPT', quote: 'something they never wrote' },
          ],
        },
        { key: 'verification', score: 60, rationale: 'Checked one answer.', evidence: [] },
        { key: 'made-up', score: 100, rationale: 'Not a dimension.', evidence: [] },
      ],
      summary: 'Used the assistant sparingly and checked its advice.',
    });
    const panel = (await aiCollaborationPanel(
      deps,
      coding([asked('Is a hash map O(n) here?'), answered('Yes, one pass.')]),
    ))!;
    expect(panel.subjects).toEqual(['Pair sum indices']);
    expect(panel.dimensions.map((d) => [d.key, d.score])).toEqual([
      ['prompt-quality', 80],
      ['verification', 60],
      ['independence', null],
    ]);
    expect(panel.dimensions[0]!.evidence).toEqual([
      { source: 'TRANSCRIPT', quote: 'Is a hash map O(n) here?' },
    ]);
    expect(panel).toMatchObject({ score: 70, fallback: false, promptVersion: 3 });
    // The conversation and the final code are sent as data blocks.
    const user = sent[0]!.find((m) => m.role === 'user')!.content;
    expect(user).toContain('Candidate: Is a hash map O(n) here?');
    expect(user).toContain('4 of 5 tests passed.');
    expect(user).toContain('<data');
  });

  it('keeps an unscored panel when the model is unavailable', async () => {
    const { deps } = runtime(new Error('down'));
    const panel = (await aiCollaborationPanel(deps, coding([asked('Hint?'), answered('Try')])))!;
    expect(panel).toMatchObject({ fallback: true, score: null, summary: null });
    expect(panel.dimensions.every((d) => d.score === null)).toBe(true);
  });
});

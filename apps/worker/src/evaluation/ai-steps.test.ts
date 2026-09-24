import type { ChatMessage, PromptTemplateData } from '@cbi/ai-core';
import type { AiRuntime } from '@cbi/ai-runtime';
import { createLogger } from '@cbi/config';
import { describe, expect, it } from 'vitest';
import { extractEvidenceWithAi, SPOKEN_ANSWER_LABEL } from './ai-steps.js';

/** A runtime whose router records the rendered prompt and returns no evidence. */
function capturing() {
  const sent: ChatMessage[][] = [];
  const prompt: PromptTemplateData = {
    id: 'p1',
    key: 'evaluation.extractEvidence',
    version: 1,
    locale: 'en',
    feature: 'evaluation.extractEvidence',
    messages: [
      { role: 'system', content: 'Extract evidence.' },
      { role: 'user', content: 'Round: {{roundType}}\n{{competencies}}\n\n{{turns}}' },
    ],
  };
  const ai = {
    prompts: { getActive: async () => prompt },
    router: {
      run: async (_feature: string, request: { messages: ChatMessage[] }) => {
        sent.push(request.messages);
        return { data: { items: [] }, model: { modelId: 'test' } };
      },
    },
  } as unknown as AiRuntime;
  return { deps: { ai, logger: createLogger({ service: 'test', level: 'silent' }) }, sent };
}

describe('evidence extraction input', () => {
  it('marks spoken answers as transcripts so wording slips are not held against the candidate', async () => {
    const { deps, sent } = capturing();
    await extractEvidenceWithAi(deps, {
      roundType: 'TECHNICAL',
      competencies: [{ key: 'api', name: 'API design', expectedEvidence: ['versioning'] }] as never,
      turns: [
        { questionId: 'q1', competencyKey: 'api', question: 'Q1?', answer: 'Typed answer.' },
        {
          questionId: 'q2',
          competencyKey: 'api',
          question: 'Q2?',
          answer: 'um so we uh versioned the API',
          spoken: true,
        },
      ],
    });
    const text = sent[0]!.map((m) => m.content).join('\n');
    expect(text).toContain('Answer: Typed answer.');
    expect(text).toContain(`${SPOKEN_ANSWER_LABEL}: um so we uh versioned the API`);
  });
});

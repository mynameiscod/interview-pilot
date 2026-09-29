import type { ChatMessage, PromptTemplateData } from '@cbi/ai-core';
import type { AiRuntime } from '@cbi/ai-runtime';
import { createLogger } from '@cbi/config';
import { describe, expect, it } from 'vitest';
import { extractEvidenceWithAi, recommendationsWithAi, SPOKEN_ANSWER_LABEL } from './ai-steps.js';

/** A runtime whose router records the rendered prompt and returns `data` (default: no evidence). */
function capturing(data: unknown = { items: [] }, template?: PromptTemplateData['messages']) {
  const sent: ChatMessage[][] = [];
  const prompt: PromptTemplateData = {
    id: 'p1',
    key: 'evaluation.extractEvidence',
    version: 1,
    locale: 'en',
    feature: 'evaluation.extractEvidence',
    messages: template ?? [
      { role: 'system', content: 'Extract evidence.' },
      { role: 'user', content: 'Round: {{roundType}}\n{{competencies}}\n\n{{turns}}' },
    ],
  };
  const ai = {
    prompts: { getActive: async () => prompt },
    router: {
      run: async (_feature: string, request: { messages: ChatMessage[] }) => {
        sent.push(request.messages);
        return { data, model: { modelId: 'test' } };
      },
    },
  } as unknown as AiRuntime;
  const warnings: object[] = [];
  const logger = createLogger({ service: 'test', level: 'silent' });
  logger.warn = ((obj: object) => void warnings.push(obj)) as typeof logger.warn;
  return { deps: { ai, logger }, sent, warnings };
}

const evidence = (quote: string | null) => ({
  questionId: 'q1',
  competencyKey: 'api',
  claim: 'Versioned the API.',
  strength: 1,
  confidence: 0.8,
  practical: true,
  quote,
  uncertainty: null,
});

describe('evidence quote verification', () => {
  const input = {
    roundType: 'TECHNICAL' as const,
    competencies: [{ key: 'api', name: 'API design', expectedEvidence: ['versioning'] }] as never,
    turns: [
      {
        questionId: 'q1',
        competencyKey: 'api',
        question: 'How do you version APIs?',
        answer: 'We put the major version in the path and kept v1 alive for six months.',
      },
    ],
  };

  it('keeps quotes found in the answer and removes hallucinated ones, with a metric', async () => {
    const { deps, warnings } = capturing({
      items: [
        evidence('kept v1 alive for six months'),
        evidence('we migrated 40 clients in two weeks with zero downtime'),
      ],
    });
    const result = await extractEvidenceWithAi(deps, input, { sessionId: 's1' });
    expect(result!.unverifiedQuotes).toBe(1);
    expect(result!.items.map((i) => i.quote)).toEqual(['kept v1 alive for six months', null]);
    expect(result!.items[1]!.confidence).toBeCloseTo(0.48);
    expect(warnings).toEqual([
      expect.objectContaining({
        metric: 'evaluation.quote_unverified',
        unverified: 1,
        quoted: 2,
        sessionId: 's1',
      }),
    ]);
  });
});

describe('recommendations', () => {
  it('asks for the output language of the session', async () => {
    const { deps, sent } = capturing({}, [
      { role: 'system', content: 'Write in {{language}}.' },
      {
        role: 'user',
        content: '{{role}} {{overall}} {{confidence}} {{dimensions}} {{evidence}} {{gaps}}',
      },
    ]);
    const values = {
      role: 'Backend Engineer (mid)',
      overall: '70/100',
      confidence: 'MEDIUM',
      dimensions: '-',
      evidence: '-',
      gaps: '-',
    };
    await recommendationsWithAi(deps, { ...values, language: 'te' });
    await recommendationsWithAi(deps, { ...values, language: 'hi' });
    await recommendationsWithAi(deps, { ...values, language: 'en' });
    expect(sent.map((m) => m[0]!.content)).toEqual([
      expect.stringContaining('Write in Telugu.'),
      expect.stringContaining('Write in Hindi.'),
      expect.stringContaining('Write in English.'),
    ]);
  });
});

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

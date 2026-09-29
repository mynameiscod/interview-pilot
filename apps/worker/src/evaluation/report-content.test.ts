import { describe, expect, it } from 'vitest';
import {
  buildReportContent,
  fallbackRecommendations,
  type ReportInputs,
} from './report-content.js';

const dimensions = [
  {
    key: 'api',
    name: 'API design',
    category: 'TECHNICAL' as const,
    weight: 100,
    score: 72,
    rationale: 'Solid.',
    fallback: false,
  },
];

function inputs(evidence: ReportInputs['evidence'], answer: string | null): ReportInputs {
  return {
    header: {
      title: 'Backend Engineer',
      companyName: null,
      mode: 'TEXT',
      language: 'en',
      startedAt: null,
      endedAt: null,
      activeMs: 600_000,
      endReason: null,
    },
    rounds: [],
    turns: [
      {
        seq: 1,
        questionId: 'q1',
        roundIdx: 0,
        roundType: 'TECHNICAL',
        question: 'How do you version APIs?',
        answer,
      },
    ],
    dimensions,
    evidence,
    overall: {
      score: 72,
      band: 'READY_WITH_GAPS',
      confidence: {
        level: 'MEDIUM',
        value: 0.6,
        factors: { independentQuestions: 1, practicalEvidence: 1, consistency: 1, completeness: 1 },
      },
      assessedWeight: 100,
    },
    recommendations: fallbackRecommendations(dimensions),
    skills: [],
    showTranscript: false,
    previous: null,
  };
}

const item = (id: string, quote: string | null) => ({
  id,
  questionId: 'q1',
  competencyKey: 'api',
  claim: `Claim ${id}`,
  strength: 1,
  quote,
});

describe('report evidence quotes', () => {
  it('shows only quotes that appear in the candidate’s answer', () => {
    const report = buildReportContent(
      inputs(
        [
          item('e1', 'kept v1 alive for six months'),
          item('e2', 'we never broke a client in 5 years'),
        ],
        'We put the major version in the path and kept v1 alive for six months.',
      ),
    );
    const quotes = Object.fromEntries(report.dimensions[0]!.evidence.map((e) => [e.id, e.quote]));
    expect(quotes).toEqual({ e1: 'kept v1 alive for six months', e2: null });
  });

  it('keeps extractor-verified quotes for questions answered with code only', () => {
    const report = buildReportContent(inputs([item('e1', 'return memo[n]')], null));
    expect(report.dimensions[0]!.evidence[0]!.quote).toBe('return memo[n]');
  });
});

import { describe, expect, it } from 'vitest';
import { roundAiAssist, TemplateContent, type TemplateRound } from './library.js';

const round = (type: TemplateRound['type'], extra: Partial<TemplateRound> = {}): TemplateRound => ({
  type,
  durationSec: 900,
  questionCount: 1,
  difficulty: 'MEDIUM',
  followUpDepth: 1,
  minEvidence: 0,
  ...extra,
});

const template = (rounds: TemplateRound[]) => ({
  name: 'Coding practice',
  description: '',
  modes: ['TEXT'],
  rounds,
  codingRequired: false,
  creditCost: 1,
  proctoringPolicy: { recording: 'OFF', tabSwitchTracking: false },
  scoringPolicy: {
    dimensionWeights: {
      TECHNICAL: 100,
      PROBLEM_SOLVING: 0,
      COMMUNICATION: 0,
      BEHAVIORAL: 0,
      DOMAIN: 0,
    },
  },
  reportPolicy: { showDimensionScores: true, showTranscript: true },
});

describe('AI assistant in template rounds', () => {
  it('is off unless a coding round enables it, with a default allowance', () => {
    expect(roundAiAssist(round('CODING'))).toBeNull();
    expect(roundAiAssist(undefined)).toBeNull();
    const parsed = TemplateContent.parse(
      template([round('CODING', { aiAssist: { enabled: true } as TemplateRound['aiAssist'] })]),
    );
    expect(parsed.rounds[0]!.aiAssist).toEqual({
      enabled: true,
      maxTurns: 12,
      allowFullSolutions: false,
    });
    expect(roundAiAssist(parsed.rounds[0])).toMatchObject({ maxTurns: 12 });
  });

  it('refuses the assistant on rounds other than coding', () => {
    const result = TemplateContent.safeParse(
      template([
        round('TECHNICAL', {
          aiAssist: { enabled: true, maxTurns: 5, allowFullSolutions: false },
        }),
      ]),
    );
    expect(result.success).toBe(false);
    expect(result.error!.issues[0]!.path).toEqual(['rounds', 0, 'aiAssist']);
    // Disabled settings are harmless anywhere.
    expect(
      TemplateContent.safeParse(
        template([
          round('TECHNICAL', {
            aiAssist: { enabled: false, maxTurns: 5, allowFullSolutions: false },
          }),
        ]),
      ).success,
    ).toBe(true);
  });
});

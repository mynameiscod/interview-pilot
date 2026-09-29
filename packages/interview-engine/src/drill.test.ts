import type { BlueprintContent, TemplateRound } from '@cbi/shared-types';
import { describe, expect, it } from 'vitest';
import { createDrillPlanner, drillBlueprint, drillDurationSec, drillRoundType } from './drill.js';
import { nextStep, recordAssessment, recordQuestion, startNextRound } from './planner.js';

type Competency = BlueprintContent['competencies'][number];

const competency = (key: string, extra: Partial<Competency> = {}): Competency => ({
  key,
  name: key.replace(/-/g, ' '),
  category: 'TECHNICAL',
  weight: 25,
  description: `${key} description`,
  subCompetencies: [],
  expectedEvidence: [`${key} evidence`],
  difficulty: 'MEDIUM',
  roundTypes: ['TECHNICAL'],
  ...extra,
});

const BLUEPRINT: Pick<BlueprintContent, 'competencies' | 'probeAreas'> = {
  competencies: [
    competency('api-design'),
    competency('debugging', { category: 'PROBLEM_SOLVING', roundTypes: ['PROBLEM_SOLVING'] }),
    competency('collaboration', { category: 'BEHAVIORAL', roundTypes: ['BEHAVIORAL'] }),
    competency('algorithms', { roundTypes: ['CODING'] }),
  ],
  probeAreas: [{ topic: 'Kafka', reason: 'On the resume', source: 'RESUME' }],
};

const ROUND: TemplateRound = {
  type: 'TECHNICAL',
  durationSec: 420,
  questionCount: 3,
  difficulty: 'ADAPTIVE',
  followUpDepth: 0,
  minEvidence: 0,
};

describe('drill round type', () => {
  it('uses the competency’s own round, never intro, wrap-up or coding', () => {
    expect(drillRoundType(BLUEPRINT.competencies[1]!)).toBe('PROBLEM_SOLVING');
    expect(drillRoundType(BLUEPRINT.competencies[2]!)).toBe('BEHAVIORAL');
    expect(drillRoundType(BLUEPRINT.competencies[3]!)).toBe('TECHNICAL');
    expect(drillRoundType({ roundTypes: ['INTRO'], category: 'COMMUNICATION' })).toBe('BEHAVIORAL');
    expect(drillRoundType({ roundTypes: ['WRAP_UP'], category: 'PROBLEM_SOLVING' })).toBe(
      'PROBLEM_SOLVING',
    );
  });
});

describe('drill blueprint', () => {
  it('keeps only the chosen competency and drops probe areas', () => {
    const b = drillBlueprint(BLUEPRINT, 'algorithms');
    expect(b.competencies.map((c) => [c.key, c.roundTypes])).toEqual([
      ['algorithms', ['TECHNICAL']],
    ]);
    expect(b.probeAreas).toEqual([]);
  });

  it('refuses an unknown competency', () => {
    expect(() => drillBlueprint(BLUEPRINT, 'nope')).toThrow(/not in the blueprint/);
  });
});

describe('drill planner', () => {
  it('scales the round budget with the number of questions', () => {
    expect(drillDurationSec(ROUND, 3)).toBe(420);
    expect(drillDurationSec(ROUND, 5)).toBe(700);
    expect(drillDurationSec({ durationSec: 60, questionCount: 6 }, 1)).toBe(60);
  });

  it('asks exactly the configured questions, all on the one competency', () => {
    const blueprint = drillBlueprint(BLUEPRINT, 'collaboration');
    let p = createDrillPlanner(ROUND, blueprint.competencies[0]!, 3);
    expect(p.rounds).toHaveLength(1);
    expect(p.rounds[0]).toMatchObject({ type: 'BEHAVIORAL', questionCount: 3, budgetMs: 420_000 });
    p = startNextRound(p, 0);
    const keys: (string | null)[] = [];
    for (let i = 0; i < 3; i++) {
      const step = nextStep(p, blueprint, i * 60_000);
      if (step.kind !== 'ASK') throw new Error('expected a question');
      expect(step.target.probeTopic).toBeNull();
      keys.push(step.target.competencyKey);
      p = recordQuestion(p, step.target, `q${i}`);
      p = recordAssessment(p, {
        sufficiency: 'ADEQUATE',
        followUpNeeded: true,
        followUpAngle: 'more detail',
        evidenceCount: 1,
      });
    }
    expect(keys).toEqual(['collaboration', 'collaboration', 'collaboration']);
    // No follow-ups (depth 0) and the round is complete after three questions.
    expect(nextStep(p, blueprint, 200_000)).toEqual({ kind: 'END_ROUND', reason: 'COMPLETED' });
  });
});

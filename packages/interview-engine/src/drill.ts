import type { BlueprintContent, RoundType, TemplateRound } from '@cbi/shared-types';
import { createPlanner, type PlannerState } from './planner.js';

/**
 * Practice drills: a short session on one competency of the candidate's
 * blueprint. The drill template supplies one round's rules (difficulty,
 * follow-ups, time per question); the planner is restricted to the chosen
 * competency and never uses resume or JD probe areas.
 */

type Competency = BlueprintContent['competencies'][number];

/** Rounds a drill never runs as: they do not assess one competency (coding needs the editor). */
const NOT_DRILL_ROUNDS: readonly RoundType[] = ['INTRO', 'WRAP_UP', 'CODING'];

/** The round type a drill on this competency runs as. */
export function drillRoundType(c: Pick<Competency, 'roundTypes' | 'category'>): RoundType {
  const named = c.roundTypes.find((t) => !NOT_DRILL_ROUNDS.includes(t));
  if (named) return named;
  switch (c.category) {
    case 'BEHAVIORAL':
    case 'COMMUNICATION':
      return 'BEHAVIORAL';
    case 'PROBLEM_SOLVING':
      return 'PROBLEM_SOLVING';
    default:
      return 'TECHNICAL';
  }
}

/**
 * The blueprint as a drill sees it: only the chosen competency (assessed in
 * the drill's round) and no probe areas. Throws when the key is unknown.
 */
export function drillBlueprint<B extends Pick<BlueprintContent, 'competencies' | 'probeAreas'>>(
  blueprint: B,
  competencyKey: string,
): B {
  const c = blueprint.competencies.find((x) => x.key === competencyKey);
  if (!c) throw new Error(`competency ${competencyKey} is not in the blueprint`);
  return {
    ...blueprint,
    competencies: [{ ...c, roundTypes: [drillRoundType(c)] }],
    probeAreas: [],
  };
}

/** A drill round's time budget: the template's time per question times the number of questions. */
export function drillDurationSec(
  round: Pick<TemplateRound, 'durationSec' | 'questionCount'>,
  questions: number,
): number {
  return Math.max(60, Math.round((round.durationSec / round.questionCount) * questions));
}

/** One round of `questions` primary questions on the competency, with the template round's rules. */
export function createDrillPlanner(
  round: TemplateRound,
  competency: Competency,
  questions: number,
): PlannerState {
  return createPlanner(
    [
      {
        ...round,
        type: drillRoundType(competency),
        questionCount: questions,
        durationSec: drillDurationSec(round, questions),
      },
    ],
    [competency],
  );
}

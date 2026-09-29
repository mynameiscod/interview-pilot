import { createHash } from 'node:crypto';
import type {
  CoachingVerdict,
  QuestionFeedback,
  QuestionFeedbackAi,
  RoundType,
  TurnEvalSufficiency,
} from '@cbi/shared-types';
import { detectStar } from './star.js';

/**
 * Per-question coaching in the report (the COACHING stage writes the model's
 * feedback per turn; the report is assembled from it here). When the model
 * was unavailable the card falls back to the live assessment and the
 * question's expected evidence, and STAR to the cue-phrase heuristic.
 */

/** Answers coached at the same time (each is an independent AI call). */
export const COACHING_CONCURRENCY = 3;

/** Cache key of one turn's coaching: the same language, question and answer give the same feedback. */
export function coachingKey(language: string, question: string, answer: string): string {
  return createHash('sha256')
    .update(`${language}\u0000${question}\u0000${answer}`)
    .digest('hex')
    .slice(0, 32);
}

const FALLBACK_VERDICT: Record<TurnEvalSufficiency, CoachingVerdict> = {
  STRONG: 'STRONG',
  ADEQUATE: 'ADEQUATE',
  WEAK: 'WEAK',
  NO_ANSWER: 'WEAK',
  UNASSESSED: 'UNASSESSED',
};

export interface CoachedTurn {
  seq: number;
  questionId: string;
  roundType: RoundType;
  question: { text: string; expectedEvidence: readonly string[] };
  answer: string;
  spoken: boolean;
  turnEval: { sufficiency: TurnEvalSufficiency; evidence: readonly string[] } | null;
}

/** One report card from a turn and its cached model feedback (null: the model was unavailable). */
export function questionFeedback(
  turn: CoachedTurn,
  ai: QuestionFeedbackAi | null,
  opts: { behavioural: boolean; showAnswer: boolean },
): QuestionFeedback {
  const base = {
    questionId: turn.questionId,
    seq: turn.seq,
    roundType: turn.roundType,
    question: turn.question.text,
    answer: opts.showAnswer ? turn.answer : null,
    spoken: turn.spoken,
    behavioural: opts.behavioural,
  };
  const aiStar = opts.behavioural && ai?.star ? { ...ai.star, source: 'AI' as const } : null;
  const star =
    aiStar ??
    (opts.behavioural ? { ...detectStar(turn.answer), source: 'HEURISTIC' as const } : null);
  if (ai) {
    return {
      ...base,
      verdict: ai.verdict,
      whatWorked: ai.whatWorked,
      missing: ai.missing,
      improvedAnswer: ai.improvedAnswer,
      star,
      fallback: false,
    };
  }
  const sufficiency = turn.turnEval?.sufficiency ?? 'UNASSESSED';
  const positive = sufficiency === 'STRONG' || sufficiency === 'ADEQUATE';
  return {
    ...base,
    verdict: FALLBACK_VERDICT[sufficiency],
    whatWorked: positive ? (turn.turnEval?.evidence ?? []).slice(0, 2) : [],
    // Without the model, list what a strong answer to this question usually covers.
    missing: turn.question.expectedEvidence.slice(0, 3),
    // Never invent an example answer without the model and its grounding check.
    improvedAnswer: null,
    star,
    fallback: true,
  };
}

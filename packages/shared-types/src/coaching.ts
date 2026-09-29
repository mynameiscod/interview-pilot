import { z } from 'zod';
import { RoleFamily, RoundType } from './library.js';

/**
 * Coaching depth in reports: per-question feedback with an example answer
 * rewritten from the candidate's own content, STAR structure for behavioural
 * answers and a peer benchmark. All of it is coaching: none of it changes a
 * competency score, weight or the overall score.
 */

const text = (max: number) => z.string().trim().max(max);

export const CoachingVerdict = z.enum(['STRONG', 'ADEQUATE', 'WEAK', 'UNASSESSED']);
export type CoachingVerdict = z.infer<typeof CoachingVerdict>;

export const STAR_PARTS = ['situation', 'task', 'action', 'result'] as const;
export type StarPart = (typeof STAR_PARTS)[number];

/** Which parts of Situation, Task, Action, Result a behavioural answer covered. */
export const StarCoverage = z.object({
  situation: z.boolean(),
  task: z.boolean(),
  action: z.boolean(),
  result: z.boolean(),
});
export type StarCoverage = z.infer<typeof StarCoverage>;

/** Placeholders the example answer uses where the candidate gave no fact, per output language. */
export const IMPROVED_ANSWER_PLACEHOLDERS = {
  en: { metric: '[your metric]', name: '[name]' },
  hi: { metric: '[आपका आँकड़ा]', name: '[नाम]' },
  te: { metric: '[మీ గణాంకం]', name: '[పేరు]' },
} as const;

/** `report.questionFeedback`: coaching for one answered question. */
export const QuestionFeedbackAi = z.object({
  verdict: z.enum(['STRONG', 'ADEQUATE', 'WEAK']),
  /** What the answer did well, from the answer itself. */
  whatWorked: z.array(text(300).min(3)).max(3),
  /** What a strong answer to this question would also have covered. */
  missing: z.array(text(300).min(3)).max(3),
  /**
   * An example answer rewritten from the candidate's own content, with
   * placeholders such as "[your metric]" where facts are missing. Null when
   * the answer holds too little to rewrite.
   */
  improvedAnswer: text(2000).nullable(),
  /** STAR coverage, for behavioural questions only (null otherwise). */
  star: StarCoverage.nullable(),
});
export type QuestionFeedbackAi = z.infer<typeof QuestionFeedbackAi>;

/** One answered question in the report's Questions section. */
export const QuestionFeedback = z.object({
  questionId: z.string(),
  seq: z.number().int(),
  roundType: RoundType,
  question: z.string(),
  /** The candidate's answer; null when the report policy hides the transcript. */
  answer: z.string().nullable(),
  /** Spoken and transcribed. */
  spoken: z.boolean(),
  behavioural: z.boolean(),
  verdict: CoachingVerdict,
  whatWorked: z.array(z.string()),
  missing: z.array(z.string()),
  improvedAnswer: z.string().nullable(),
  star: StarCoverage.extend({ source: z.enum(['AI', 'HEURISTIC']) }).nullable(),
  /**
   * The coaching model was unavailable: the verdict comes from the live
   * assessment and `missing` lists what a strong answer usually covers.
   */
  fallback: z.boolean(),
});
export type QuestionFeedback = z.infer<typeof QuestionFeedback>;

/** How behavioural answers were structured, across the interview. */
export const StructureInsight = z.object({
  behaviouralAnswers: z.number().int(),
  /** Answers that covered all four parts. */
  complete: z.number().int(),
  /** Answers that covered each part. */
  counts: z.object({
    situation: z.number().int(),
    task: z.number().int(),
    action: z.number().int(),
    result: z.number().int(),
  }),
  /** The part most often missing (null when every answer covered everything). */
  weakest: z.enum(STAR_PARTS).nullable(),
});
export type StructureInsight = z.infer<typeof StructureInsight>;

/** Reports compared for a benchmark: the last 180 days, and only with at least 30 other candidates. */
export const BENCHMARK_WINDOW_DAYS = 180;
export const BENCHMARK_MIN_SAMPLE = 30;

/**
 * Where the overall score sits among other candidates practising for the same
 * role (or role family). Aggregate only: no other candidate's data is stored.
 */
export const PeerBenchmark = z.object({
  /** Share of the other candidates whose overall score was lower (0–100). */
  percentile: z.number().int().min(0).max(100),
  sampleSize: z.number().int(),
  basis: z.enum(['ROLE', 'FAMILY']),
  /** The role title (ROLE) or null (FAMILY, named by `family`). */
  roleTitle: z.string().nullable(),
  family: RoleFamily.nullable(),
  windowDays: z.number().int(),
});
export type PeerBenchmark = z.infer<typeof PeerBenchmark>;

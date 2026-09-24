import { z } from 'zod';
import { InterviewCreditStatus } from './interviews.js';
import { CompetencyCategory, InterviewMode, RoundType } from './library.js';
import { InterviewLanguagePreference } from './users.js';
import { CodingReportItem } from './coding.js';
import { IntegritySummary } from './media.js';

/**
 * Evaluation and reports (Phase 5). Evidence comes first: dimension scores
 * are given only normalised evidence, the overall score and confidence are
 * computed deterministically by @cbi/scoring-core, and every report is an
 * immutable revision (0 = the AI original).
 */

export const ProcessingStage = z.enum([
  'FINALIZE_TRANSCRIPT',
  'EXTRACT_EVIDENCE',
  'SCORE_DIMENSIONS',
  'AGGREGATE',
  'RECOMMENDATIONS',
  'BUILD_REPORT',
  'RENDER_PDF',
  'NOTIFY',
]);
export type ProcessingStage = z.infer<typeof ProcessingStage>;

export const ProcessingStatus = z.enum(['QUEUED', 'RUNNING', 'DONE', 'FAILED']);
export type ProcessingStatus = z.infer<typeof ProcessingStatus>;

export const ConfidenceLevel = z.enum(['HIGH', 'MEDIUM', 'LOW']);
export type ConfidenceLevel = z.infer<typeof ConfidenceLevel>;

export const ReadinessBand = z.enum([
  'READY',
  'READY_WITH_GAPS',
  'DEVELOPING',
  'NOT_YET',
  'INSUFFICIENT_EVIDENCE',
]);
export type ReadinessBand = z.infer<typeof ReadinessBand>;

const text = (max: number) => z.string().trim().max(max);

// ---- AI outputs ---------------------------------------------------------------------

/** `evaluation.extractEvidence`: evidence found in one round's answers. */
export const ExtractEvidenceAi = z.object({
  items: z
    .array(
      z.object({
        questionId: text(64).min(1),
        competencyKey: text(60).min(1),
        /** One factual sentence about what the answer shows. */
        claim: text(300).min(3),
        /** -2 clear negative evidence … +2 clear, specific positive evidence. */
        strength: z.number().int().min(-2).max(2),
        confidence: z.number().min(0).max(1),
        /** A concrete example, number, decision or result the candidate described. */
        practical: z.boolean(),
        quote: text(300).nullable(),
        uncertainty: text(200).nullable(),
      }),
    )
    .max(40),
});
export type ExtractEvidenceAi = z.infer<typeof ExtractEvidenceAi>;

/** `evaluation.scoreDimension`: one dimension, from its evidence and rubric only. */
export const ScoreDimensionAi = z.object({
  score: z.number().int().min(0).max(100),
  rationale: text(600).min(10),
  /** Ids of the evidence items the score relies on (validated against what was given). */
  evidenceIds: z.array(text(64)).max(20),
});
export type ScoreDimensionAi = z.infer<typeof ScoreDimensionAi>;

const PlanItem = z.object({
  action: text(240).min(5),
  why: text(240).min(5),
  dimensionKey: text(60).nullable(),
});

/** `report.recommendations`: hedged strengths, gaps and time-boxed plans. */
export const RecommendationsAi = z.object({
  summary: text(600).min(10),
  strengths: z
    .array(z.object({ text: text(300).min(5), dimensionKey: text(60).nullable() }))
    .max(5),
  gaps: z.array(z.object({ text: text(300).min(5), dimensionKey: text(60).nullable() })).max(5),
  plan: z.object({
    next24h: z.array(PlanItem).min(1).max(4),
    next3Days: z.array(PlanItem).min(1).max(5),
    next7Days: z.array(PlanItem).min(1).max(6),
  }),
});
export type RecommendationsAi = z.infer<typeof RecommendationsAi>;

// ---- Report ----------------------------------------------------------------------------

export const ReportEvidence = z.object({
  id: z.string(),
  claim: z.string(),
  strength: z.number().int(),
  quote: z.string().nullable(),
  questionId: z.string(),
  question: z.string(),
});
export type ReportEvidence = z.infer<typeof ReportEvidence>;

export const ReportDimension = z.object({
  key: z.string(),
  name: z.string(),
  category: CompetencyCategory,
  /** Share of the overall score, in percent (one decimal). */
  weight: z.number(),
  /** Null when there was not enough evidence to score it. */
  score: z.number().int().nullable(),
  rationale: z.string().nullable(),
  evidence: z.array(ReportEvidence),
  /** The score came from evidence strengths only (the scoring model was unavailable). */
  fallback: z.boolean(),
});
export type ReportDimension = z.infer<typeof ReportDimension>;

export const ReportContent = z.object({
  schemaVersion: z.literal(1),
  /** Session observations when the interview tracked them (Phase 8); absent in older reports. */
  integrity: IntegritySummary.nullable().optional(),
  /** Coding problems and their results (Phase 9); absent in older reports. */
  coding: z.array(CodingReportItem).optional(),
  /** Set on revisions made by a manual review. */
  review: z
    .object({ revision: z.number().int(), reviewedAt: z.iso.datetime(), note: z.string() })
    .optional(),
  header: z.object({
    title: z.string(),
    companyName: z.string().nullable(),
    mode: InterviewMode,
    language: InterviewLanguagePreference,
    startedAt: z.iso.datetime().nullable(),
    endedAt: z.iso.datetime().nullable(),
    durationSec: z.number().int(),
    endReason: z.string().nullable(),
  }),
  overall: z.object({
    score: z.number().int().nullable(),
    band: ReadinessBand,
    confidence: z.object({
      level: ConfidenceLevel,
      value: z.number(),
      factors: z.object({
        independentQuestions: z.number(),
        practicalEvidence: z.number(),
        consistency: z.number(),
        completeness: z.number(),
      }),
    }),
    /** Share of the weight that could be scored (0–1). */
    assessedWeight: z.number(),
  }),
  summary: z.string(),
  dimensions: z.array(ReportDimension),
  strengths: z.array(z.object({ text: z.string(), dimensionKey: z.string().nullable() })),
  gaps: z.array(z.object({ text: z.string(), dimensionKey: z.string().nullable() })),
  rounds: z.array(
    z.object({
      type: RoundType,
      state: z.string(),
      questions: z.number().int(),
      answered: z.number().int(),
      durationSec: z.number().int(),
    }),
  ),
  coverage: z.array(
    z.object({
      skill: z.string(),
      sources: z.array(z.string()),
      inResume: z.boolean(),
      assessed: z.boolean(),
    }),
  ),
  plan: RecommendationsAi.shape.plan,
  previous: z
    .object({
      sessionId: z.string(),
      overall: z.number().int().nullable(),
      endedAt: z.iso.datetime().nullable(),
      deltas: z.array(z.object({ key: z.string(), name: z.string(), delta: z.number().int() })),
    })
    .nullable(),
  transcript: z
    .array(
      z.object({
        seq: z.number().int(),
        roundType: RoundType,
        question: z.string(),
        answer: z.string().nullable(),
      }),
    )
    .nullable(),
  disclaimer: z.string(),
});
export type ReportContent = z.infer<typeof ReportContent>;

export const ReportSummary = z.object({
  sessionId: z.string(),
  revision: z.number().int(),
  generatedAt: z.iso.datetime(),
  content: ReportContent,
  pdfReady: z.boolean(),
  credit: InterviewCreditStatus,
});
export type ReportSummary = z.infer<typeof ReportSummary>;

/** Where evaluation has got to, for the completion screen. */
export const ProcessingProgress = z.object({
  stage: ProcessingStage.nullable(),
  status: ProcessingStatus.nullable(),
  completedStages: z.array(ProcessingStage),
  reportReady: z.boolean(),
});
export type ProcessingProgress = z.infer<typeof ProcessingProgress>;

export const ReportHistoryItem = z.object({
  sessionId: z.string(),
  title: z.string(),
  companyName: z.string().nullable(),
  roleKey: z.string().nullable(),
  mode: InterviewMode,
  language: InterviewLanguagePreference,
  overall: z.number().int().nullable(),
  band: ReadinessBand,
  confidence: ConfidenceLevel,
  durationSec: z.number().int(),
  endedAt: z.iso.datetime().nullable(),
});
export type ReportHistoryItem = z.infer<typeof ReportHistoryItem>;

export const CompareQuery = z.object({
  sessions: z
    .string()
    .transform((s) =>
      s
        .split(',')
        .map((x) => x.trim())
        .filter(Boolean),
    )
    .pipe(z.array(z.string().min(1).max(64)).min(2).max(4)),
});
export type CompareQuery = z.infer<typeof CompareQuery>;

export const CompareResult = z.object({
  attempts: z.array(
    z.object({
      sessionId: z.string(),
      endedAt: z.iso.datetime().nullable(),
      overall: z.number().int().nullable(),
      confidence: ConfidenceLevel,
    }),
  ),
  dimensions: z.array(
    z.object({
      key: z.string(),
      name: z.string(),
      scores: z.array(z.number().int().nullable()),
      /** Last attempt minus first, when both were scored. */
      delta: z.number().int().nullable(),
    }),
  ),
});
export type CompareResult = z.infer<typeof CompareResult>;

// ---- Feedback ---------------------------------------------------------------------------

const rating = z.number().int().min(1).max(5);

export const FeedbackBody = z.object({
  sessionId: z.string().min(1).max(64),
  ratings: z.object({ usefulness: rating, accuracy: rating, interviewQuality: rating }),
  freeText: text(2000).nullable().default(null),
  intendsRetake: z.boolean().nullable().default(null),
});
export type FeedbackBody = z.infer<typeof FeedbackBody>;

export const FeedbackSummary = FeedbackBody.extend({ createdAt: z.iso.datetime() });
export type FeedbackSummary = z.infer<typeof FeedbackSummary>;

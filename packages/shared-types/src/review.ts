import { z } from 'zod';
import { ReadinessBand } from './evaluation.js';
import { InterviewState } from './interviews.js';
import { InterviewMode } from './library.js';

/**
 * Admin interview review (Phase 10). Reviewers read the transcript, evidence
 * and every score/report revision, flag interviews, and revise scores:
 * a revision is a new score and report (revision n+1); revision 0 — the AI
 * original — is never modified.
 */

export const AdminInterviewQuery = z.object({
  state: InterviewState.optional(),
  campaignId: z
    .string()
    .regex(/^[0-9a-f]{24}$/i)
    .optional(),
  flagged: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .optional(),
  /** Interview id, user id or exact email. */
  q: z.string().trim().max(120).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type AdminInterviewQuery = z.infer<typeof AdminInterviewQuery>;

export const ReviewFlag = z.object({
  flagged: z.boolean(),
  reason: z.string().nullable(),
  by: z.string().nullable(),
  at: z.iso.datetime().nullable(),
});
export type ReviewFlag = z.infer<typeof ReviewFlag>;

export const AdminInterviewRow = z.object({
  id: z.string(),
  state: InterviewState,
  mode: InterviewMode,
  title: z.string(),
  candidate: z.object({ userId: z.string(), email: z.string().nullable() }),
  campaign: z.object({ id: z.string(), name: z.string() }).nullable(),
  overall: z.number().int().nullable(),
  band: ReadinessBand.nullable(),
  scoreRevision: z.number().int().nullable(),
  flag: ReviewFlag,
  startedAt: z.iso.datetime().nullable(),
  endedAt: z.iso.datetime().nullable(),
});
export type AdminInterviewRow = z.infer<typeof AdminInterviewRow>;

export const ScoreRevisionSummary = z.object({
  revision: z.number().int(),
  overall: z.number().int().nullable(),
  band: ReadinessBand,
  dimensions: z.array(
    z.object({
      key: z.string(),
      name: z.string(),
      weight: z.number(),
      score: z.number().int().nullable(),
      note: z.string().nullable(),
    }),
  ),
  createdBy: z.string(),
  reason: z.string().nullable(),
  createdAt: z.iso.datetime(),
});
export type ScoreRevisionSummary = z.infer<typeof ScoreRevisionSummary>;

export const AdminInterviewDetail = AdminInterviewRow.extend({
  turns: z.array(
    z.object({
      seq: z.number().int(),
      roundType: z.string(),
      question: z.string(),
      answer: z.string().nullable(),
      answerSource: z.enum(['TEXT', 'VOICE']).nullable(),
      coding: z.boolean(),
    }),
  ),
  evidence: z.array(
    z.object({
      id: z.string(),
      questionId: z.string(),
      competencyKey: z.string(),
      claim: z.string(),
      strength: z.number(),
      confidence: z.number(),
      practical: z.boolean(),
      uncertainty: z.string().nullable(),
    }),
  ),
  scoreRevisions: z.array(ScoreRevisionSummary),
  reportRevisions: z.array(
    z.object({
      revision: z.number().int(),
      scoreRevision: z.number().int(),
      candidateVisible: z.boolean(),
      pdfStatus: z.enum(['PENDING', 'READY', 'FAILED']),
      generatedAt: z.iso.datetime(),
    }),
  ),
  aiCostMicros: z.number().int(),
});
export type AdminInterviewDetail = z.infer<typeof AdminInterviewDetail>;

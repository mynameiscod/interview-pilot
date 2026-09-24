import { z } from 'zod';
import { EvidenceSource, InterviewMode, RoleFamily, RoundType, Seniority } from './library.js';
import { InterviewLanguagePreference } from './users.js';

/**
 * Interview sessions. Phase 3 covers the pre-interview states (draft, role
 * analysis, setup); the full state machine arrives with the engine in Phase 4.
 */
export const InterviewState = z.enum([
  'DRAFT',
  'ROLE_ANALYSIS',
  'READY',
  'DEVICE_CHECK',
  'CONSENT_REQUIRED',
  'READY_TO_START',
  'ACTIVE',
  'ROUND_TRANSITION',
  'RECONNECTING',
  'PAUSED',
  'COMPLETING',
  'PROCESSING',
  'REPORT_READY',
  'EXPIRED',
  'CANCELLED',
  'FAILED',
]);
export type InterviewState = z.infer<typeof InterviewState>;

export const AnalysisFailureCode = z.enum([
  /** A resume or JD could not be read (details on the input). */
  'INPUT_FAILED',
  /** Inputs were still processing after the wait limit. */
  'INPUT_TIMEOUT',
  'AI_UNAVAILABLE',
  'INTERNAL',
]);
export type AnalysisFailureCode = z.infer<typeof AnalysisFailureCode>;

/** Structured output of the `role.analyze` AI feature. */
export const RoleAnalysisAi = z.object({
  roleTitle: z.string().trim().min(2).max(120),
  family: RoleFamily,
  seniority: Seniority,
  confidence: z.number().min(0).max(1),
  /** Slug of the best-matching library role, or null when none fits. */
  matchedRoleSlug: z.string().max(60).nullable(),
  skills: z
    .array(
      z.object({
        name: z.string().trim().min(1).max(80),
        weight: z.number().int().min(1).max(100),
        sources: z.array(EvidenceSource).min(1),
        inResume: z.boolean(),
      }),
    )
    .min(1)
    .max(15),
  resumeHighlights: z.array(z.string().trim().max(200)).max(6),
  gaps: z.array(z.string().trim().max(200)).max(6),
});
export type RoleAnalysisAi = z.infer<typeof RoleAnalysisAi>;

export const RoleAnalysis = z.object({
  detectedRole: z.object({
    title: z.string(),
    family: RoleFamily,
    seniority: Seniority,
    confidence: z.number(),
  }),
  matchedRole: z.object({ id: z.string(), title: z.string() }).nullable(),
  blueprint: z.object({
    id: z.string(),
    origin: z.enum(['CANONICAL', 'AI_GENERATED']),
    version: z.number().int(),
  }),
  skills: RoleAnalysisAi.shape.skills,
  resumeHighlights: z.array(z.string()),
  gaps: z.array(z.string()),
  inputs: z.object({ resume: z.boolean(), jd: z.boolean(), companyPatterns: z.boolean() }),
  plannedRounds: z.array(
    z.object({ type: RoundType, durationSec: z.number().int(), focus: z.array(z.string()) }),
  ),
  totalDurationSec: z.number().int(),
  analyzedAt: z.iso.datetime(),
});
export type RoleAnalysis = z.infer<typeof RoleAnalysis>;

export const InterviewSummary = z.object({
  id: z.string(),
  state: InterviewState,
  mode: InterviewMode,
  language: InterviewLanguagePreference,
  jobTargetId: z.string(),
  resumeId: z.string().nullable(),
  title: z.string(),
  companyName: z.string().nullable(),
  template: z.object({
    id: z.string(),
    name: z.string(),
    creditCost: z.number().int(),
    modes: z.array(InterviewMode),
    totalDurationSec: z.number().int(),
  }),
  analysis: RoleAnalysis.nullable(),
  failure: z.object({ code: AnalysisFailureCode, at: z.iso.datetime() }).nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type InterviewSummary = z.infer<typeof InterviewSummary>;

export const CreateInterviewBody = z.object({
  jobTargetId: z.string().min(1).max(64),
  resumeId: z.string().min(1).max(64).nullable().default(null),
  /** Defaults to the active `standard-practice` template. */
  templateKey: z.string().max(60).optional(),
});
export type CreateInterviewBody = z.infer<typeof CreateInterviewBody>;

export const UpdateInterviewSetupBody = z.object({
  mode: InterviewMode,
  language: InterviewLanguagePreference,
});
export type UpdateInterviewSetupBody = z.infer<typeof UpdateInterviewSetupBody>;

export const InterviewListQuery = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(20),
});
export type InterviewListQuery = z.infer<typeof InterviewListQuery>;

import { z } from 'zod';
import { InterviewMode } from './library.js';
import { InterviewLanguagePreference } from './users.js';

/**
 * Campaigns (Phase 10): a company invites candidates to a fixed interview —
 * one role blueprint, one template version, the same modes and rules for
 * everyone — through an invite link. Results come back to the company's
 * admins; candidates see their own report only if the campaign allows it.
 */

export const CampaignStatus = z.enum(['DRAFT', 'ACTIVE', 'PAUSED', 'CLOSED']);
export type CampaignStatus = z.infer<typeof CampaignStatus>;

export const CampaignProctoring = z.object({
  recording: z.enum(['OFF', 'OPTIONAL', 'REQUIRED']),
  tabSwitchTracking: z.boolean(),
});
export type CampaignProctoring = z.infer<typeof CampaignProctoring>;

export const CampaignWindow = z
  .object({
    startAt: z.iso.datetime(),
    endAt: z.iso.datetime().nullable(),
  })
  .refine((w) => !w.endAt || w.startAt < w.endAt, {
    message: 'The end must be after the start',
    path: ['endAt'],
  });
export type CampaignWindow = z.infer<typeof CampaignWindow>;

const campaignFields = {
  name: z.string().trim().min(3).max(120),
  /** Library company (optional) and the name candidates see. */
  companyId: z.string().min(1).max(64).nullable(),
  companyName: z.string().trim().min(2).max(120),
  /** Library role; its active blueprint is pinned when the campaign is created. */
  roleId: z.string().min(1).max(64),
  /** Template key; its active version is pinned when the campaign is created. */
  templateKey: z.string().trim().min(2).max(60),
  /** Optional job description shown to candidates and used in their analysis. */
  jobDescription: z.string().trim().max(60_000).nullable(),
  modes: z.array(InterviewMode).min(1),
  languages: z.array(InterviewLanguagePreference).min(1),
  window: CampaignWindow,
  /** Null = unlimited. */
  maxCandidates: z.number().int().min(1).max(100_000).nullable(),
  proctoring: CampaignProctoring,
  /** Whether candidates can see their own report. */
  candidateSeesReport: z.boolean(),
  /** Interviews the company pays for; null = candidates use their own credits. */
  sponsoredCredits: z.number().int().min(1).max(100_000).nullable(),
};

export const CreateCampaignBody = z.object(campaignFields);
export type CreateCampaignBody = z.infer<typeof CreateCampaignBody>;

/** Fields that can change after creation (the role, template and modes stay pinned). */
export const UpdateCampaignBody = z.object({
  name: campaignFields.name,
  companyName: campaignFields.companyName,
  jobDescription: campaignFields.jobDescription,
  window: CampaignWindow,
  maxCandidates: campaignFields.maxCandidates,
  candidateSeesReport: z.boolean(),
  sponsoredCredits: campaignFields.sponsoredCredits,
  reason: z.string().trim().min(3).max(300),
});
export type UpdateCampaignBody = z.infer<typeof UpdateCampaignBody>;

export const CampaignStatusBody = z.object({
  status: z.enum(['ACTIVE', 'PAUSED', 'CLOSED']),
  reason: z.string().trim().min(3).max(300),
});
export type CampaignStatusBody = z.infer<typeof CampaignStatusBody>;

export const CampaignSummary = z.object({
  id: z.string(),
  name: z.string(),
  status: CampaignStatus,
  companyId: z.string().nullable(),
  companyName: z.string(),
  role: z.object({ id: z.string(), title: z.string() }),
  blueprint: z.object({ id: z.string(), version: z.number().int() }),
  template: z.object({
    id: z.string(),
    key: z.string(),
    version: z.number().int(),
    name: z.string(),
  }),
  jobDescription: z.string().nullable(),
  modes: z.array(InterviewMode),
  languages: z.array(InterviewLanguagePreference),
  window: z.object({ startAt: z.iso.datetime(), endAt: z.iso.datetime().nullable() }),
  maxCandidates: z.number().int().nullable(),
  joined: z.number().int(),
  proctoring: CampaignProctoring,
  candidateSeesReport: z.boolean(),
  sponsoredCredits: z.object({ total: z.number().int(), used: z.number().int() }).nullable(),
  /** First characters of the invite token, to recognise a link (the token itself is not stored). */
  tokenHint: z.string(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type CampaignSummary = z.infer<typeof CampaignSummary>;

/** Returned once, when a campaign is created or its link rotated. */
export const CampaignWithInvite = z.object({
  campaign: CampaignSummary,
  /** Path on the candidate site: `/campaign/<token>`. Shown once; only its hash is stored. */
  invitePath: z.string(),
});
export type CampaignWithInvite = z.infer<typeof CampaignWithInvite>;

export const RotateInviteBody = z.object({ reason: z.string().trim().min(3).max(300) });
export type RotateInviteBody = z.infer<typeof RotateInviteBody>;

// ---- Candidate side -------------------------------------------------------------------------------

/** Why a campaign cannot be joined now. */
export const CampaignClosedReason = z.enum(['NOT_STARTED', 'ENDED', 'PAUSED', 'CLOSED', 'FULL']);
export type CampaignClosedReason = z.infer<typeof CampaignClosedReason>;

/** The public landing page (`GET /campaigns/:token`). */
export const PublicCampaign = z.object({
  name: z.string(),
  companyName: z.string(),
  roleTitle: z.string(),
  /** What is assessed (competency names from the pinned blueprint). */
  assesses: z.array(z.string()),
  totalDurationSec: z.number().int(),
  modes: z.array(InterviewMode),
  languages: z.array(InterviewLanguagePreference),
  recording: z.enum(['OFF', 'OPTIONAL', 'REQUIRED']),
  observations: z.boolean(),
  candidateSeesReport: z.boolean(),
  sponsored: z.boolean(),
  window: z.object({ startAt: z.iso.datetime(), endAt: z.iso.datetime().nullable() }),
  /** Null when the campaign is open. */
  closedReason: CampaignClosedReason.nullable(),
  /** The signed-in candidate already joined (their interview id). */
  joinedInterviewId: z.string().nullable(),
});
export type PublicCampaign = z.infer<typeof PublicCampaign>;

export const JoinCampaignBody = z.object({
  resumeId: z.string().min(1).max(64).nullable().default(null),
});
export type JoinCampaignBody = z.infer<typeof JoinCampaignBody>;

export const JoinCampaignResult = z.object({
  interviewId: z.string(),
  /** False when the candidate had already joined (same interview returned). */
  created: z.boolean(),
});
export type JoinCampaignResult = z.infer<typeof JoinCampaignResult>;

// ---- Results ----------------------------------------------------------------------------------------

export const ApplicationStatus = z.enum(['JOINED', 'IN_PROGRESS', 'COMPLETED', 'DID_NOT_FINISH']);
export type ApplicationStatus = z.infer<typeof ApplicationStatus>;

export const CampaignResultRow = z.object({
  applicationId: z.string(),
  interviewId: z.string().nullable(),
  candidate: z.object({
    userId: z.string(),
    name: z.string().nullable(),
    email: z.string().nullable(),
  }),
  status: ApplicationStatus,
  joinedAt: z.iso.datetime(),
  completedAt: z.iso.datetime().nullable(),
  overall: z.number().int().nullable(),
  band: z.string().nullable(),
  confidence: z.string().nullable(),
  /** Latest score revision (manual reviews included). */
  scoreRevision: z.number().int().nullable(),
  dimensions: z.record(z.string(), z.number().int().nullable()),
  flagged: z.boolean(),
});
export type CampaignResultRow = z.infer<typeof CampaignResultRow>;

export const CampaignResults = z.object({
  campaignId: z.string(),
  /** Dimension keys and names (columns of the grid). */
  dimensions: z.array(z.object({ key: z.string(), name: z.string() })),
  rows: z.array(CampaignResultRow),
});
export type CampaignResults = z.infer<typeof CampaignResults>;

export const CampaignResultsQuery = z.object({
  status: ApplicationStatus.optional(),
  minOverall: z.coerce.number().int().min(0).max(100).optional(),
  /** `key:min` — e.g. `api-design:70`. */
  dimension: z
    .string()
    .regex(/^[a-z0-9-]+:\d{1,3}$/)
    .optional(),
});
export type CampaignResultsQuery = z.infer<typeof CampaignResultsQuery>;

// ---- Manual review ----------------------------------------------------------------------------------

export const ReviewFlagBody = z.object({
  flagged: z.boolean(),
  reason: z.string().trim().min(3).max(300),
});
export type ReviewFlagBody = z.infer<typeof ReviewFlagBody>;

/** A reviewer's revision of dimension scores; unlisted dimensions keep their score. */
export const ReviseScoreBody = z.object({
  dimensions: z
    .array(
      z.object({
        key: z.string().min(1).max(60),
        score: z.number().int().min(0).max(100).nullable(),
        note: z.string().trim().min(3).max(500),
      }),
    )
    .min(1)
    .max(20),
  reason: z.string().trim().min(3).max(500),
});
export type ReviseScoreBody = z.infer<typeof ReviseScoreBody>;

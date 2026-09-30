import { z } from 'zod';
import {
  ApplicationStatus,
  CampaignResultRow,
  CampaignResultsExportQuery,
  CandidateStage,
  EmployerView,
} from './campaign.js';
import type { InterviewLanguagePreference } from './users.js';
import { MeResponse } from './users.js';
import { OrgPermission, OrgRole } from './permissions.js';

/**
 * Employer and college organisations (self-serve portal). CodeBegun super
 * admins create an organisation and invite its owner; owners invite members.
 * Members sign in to the org portal (the admin web app under `/org`) with an
 * `org` session and only ever see their own organisation's campaigns.
 */

export const OrgType = z.enum(['EMPLOYER', 'COLLEGE']);
export type OrgType = z.infer<typeof OrgType>;

export const OrgStatus = z.enum(['ACTIVE', 'SUSPENDED']);
export type OrgStatus = z.infer<typeof OrgStatus>;

const orgName = z.string().trim().min(2).max(120);

/** Null = unlimited. */
const limit = z.number().int().min(1).max(1_000_000).nullable();

export const CreateOrgBody = z.object({
  name: orgName,
  type: OrgType,
  /** Members allowed (owners included). */
  seats: z.number().int().min(1).max(10_000),
  /** Candidates who may join the organisation's campaigns in total; null = unlimited. */
  interviewQuota: limit,
  /** Sponsored interviews bought up front (the wallet campaigns draw their budgets from). */
  walletCredits: z.number().int().min(0).max(1_000_000),
  /** Members must use an authenticator app to sign in. */
  mfaRequired: z.boolean(),
  /** The first owner; invited by email. */
  ownerEmail: z.email().max(254),
});
export type CreateOrgBody = z.infer<typeof CreateOrgBody>;

export const UpdateOrgBody = z.object({
  name: orgName,
  seats: z.number().int().min(1).max(10_000),
  interviewQuota: limit,
  mfaRequired: z.boolean(),
  reason: z.string().trim().min(3).max(300),
});
export type UpdateOrgBody = z.infer<typeof UpdateOrgBody>;

export const OrgStatusBody = z.object({
  status: OrgStatus,
  reason: z.string().trim().min(3).max(300),
});
export type OrgStatusBody = z.infer<typeof OrgStatusBody>;

/** Adds to (or takes from) the sponsored-interview wallet; never below zero. */
export const OrgWalletAdjustBody = z.object({
  delta: z
    .number()
    .int()
    .min(-1_000_000)
    .max(1_000_000)
    .refine((n) => n !== 0, 'Enter a non-zero amount'),
  reason: z.string().trim().min(3).max(300),
});
export type OrgWalletAdjustBody = z.infer<typeof OrgWalletAdjustBody>;

export const OrgSummary = z.object({
  id: z.string(),
  name: z.string(),
  type: OrgType,
  status: OrgStatus,
  seats: z.object({ total: z.number().int(), used: z.number().int() }),
  interviewQuota: z.object({ total: z.number().int().nullable(), used: z.number().int() }),
  /** Sponsored interviews not yet given to a campaign. */
  wallet: z.object({ balance: z.number().int(), allocated: z.number().int() }),
  mfaRequired: z.boolean(),
  /** Scorecard criteria reviewers rate 1–5. */
  scorecardCriteria: z.array(z.object({ key: z.string(), label: z.string() })),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type OrgSummary = z.infer<typeof OrgSummary>;

export const OrgListQuery = z.object({
  q: z.string().trim().max(120).default(''),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});
export type OrgListQuery = z.infer<typeof OrgListQuery>;

export const OrgListPage = z.object({
  items: z.array(OrgSummary),
  total: z.number().int(),
  page: z.number().int(),
  pageSize: z.number().int(),
});
export type OrgListPage = z.infer<typeof OrgListPage>;

// ---- Members ----------------------------------------------------------------------------------

/** INVITED until the first sign-in. REMOVED members keep their history but cannot sign in. */
export const OrgMemberStatus = z.enum(['INVITED', 'ACTIVE', 'REMOVED']);
export type OrgMemberStatus = z.infer<typeof OrgMemberStatus>;

export const OrgMemberSummary = z.object({
  id: z.string(),
  userId: z.string(),
  email: z.string().nullable(),
  name: z.string().nullable(),
  role: OrgRole,
  status: OrgMemberStatus,
  invitedAt: z.iso.datetime(),
  lastLoginAt: z.iso.datetime().nullable(),
});
export type OrgMemberSummary = z.infer<typeof OrgMemberSummary>;

export const InviteOrgMemberBody = z.object({
  email: z.email().max(254),
  role: OrgRole,
});
export type InviteOrgMemberBody = z.infer<typeof InviteOrgMemberBody>;

export const UpdateOrgMemberBody = z.object({ role: OrgRole });
export type UpdateOrgMemberBody = z.infer<typeof UpdateOrgMemberBody>;

export const InviteOrgMemberResponse = z.object({
  member: OrgMemberSummary,
  inviteEmailSent: z.boolean(),
});
export type InviteOrgMemberResponse = z.infer<typeof InviteOrgMemberResponse>;

/** `GET /org/me`: the member, their organisation and effective permissions. */
export const OrgMeResponse = MeResponse.extend({
  org: z.object({
    id: z.string(),
    name: z.string(),
    type: OrgType,
    mfaRequired: z.boolean(),
  }),
  orgRole: OrgRole,
  orgPermissions: z.array(OrgPermission),
  mfaEnabled: z.boolean(),
});
export type OrgMeResponse = z.infer<typeof OrgMeResponse>;

export const ScorecardCriterion = z.object({
  key: z
    .string()
    .trim()
    .regex(/^[a-z0-9-]{2,40}$/, 'Use lower-case letters, digits and dashes'),
  label: z.string().trim().min(2).max(80),
});
export type ScorecardCriterion = z.infer<typeof ScorecardCriterion>;

export const UpdateScorecardCriteriaBody = z.object({
  criteria: z
    .array(ScorecardCriterion)
    .min(1)
    .max(10)
    .refine((list) => new Set(list.map((c) => c.key)).size === list.length, 'Keys must be unique'),
});
export type UpdateScorecardCriteriaBody = z.infer<typeof UpdateScorecardCriteriaBody>;

export const DEFAULT_SCORECARD_CRITERIA: ScorecardCriterion[] = [
  { key: 'communication', label: 'Communication' },
  { key: 'problem-solving', label: 'Problem solving' },
  { key: 'role-fit', label: 'Role fit' },
];

// ---- Invites ----------------------------------------------------------------------------------

/**
 * PENDING (queued for the worker) → SENT → OPENED (the invite link was
 * visited) → JOINED → COMPLETED (report ready). FAILED: the email could not
 * be sent. REVOKED: withdrawn by the organisation.
 */
export const InviteStatus = z.enum([
  'PENDING',
  'SENT',
  'OPENED',
  'JOINED',
  'COMPLETED',
  'FAILED',
  'REVOKED',
]);
export type InviteStatus = z.infer<typeof InviteStatus>;

/** Language of the invite and reminder emails. */
export const InviteLanguage = z.enum(['en', 'hi', 'te']);
export type InviteLanguage = z.infer<typeof InviteLanguage>;

const tag = z.string().trim().max(60);

/** College cohort tags (batch, branch, year of passing); optional for employers. */
export const InviteTags = z.object({
  batch: tag.nullable().default(null),
  branch: tag.nullable().default(null),
  year: z.number().int().min(1990).max(2100).nullable().default(null),
});
export type InviteTags = z.infer<typeof InviteTags>;

export const InviteInput = z.object({
  email: z.email().max(254),
  name: z.string().trim().max(120).nullable().default(null),
  language: InviteLanguage.default('en'),
  tags: InviteTags.default({ batch: null, branch: null, year: null }),
});
export type InviteInput = z.infer<typeof InviteInput>;

/** At most this many invites per request (bulk CSV upload). */
export const MAX_INVITES_PER_REQUEST = 1000;

export const CreateInvitesBody = z.object({
  invites: z.array(InviteInput).min(1).max(MAX_INVITES_PER_REQUEST),
});
export type CreateInvitesBody = z.infer<typeof CreateInvitesBody>;

export const CreateInvitesResult = z.object({
  created: z.number().int(),
  /** Emails already invited to this campaign (left unchanged). */
  skipped: z.array(z.string()),
});
export type CreateInvitesResult = z.infer<typeof CreateInvitesResult>;

/** CSV text to validate before creating invites (nothing is saved). */
export const InvitePreviewBody = z.object({ csv: z.string().min(1).max(1_000_000) });
export type InvitePreviewBody = z.infer<typeof InvitePreviewBody>;

export const InvitePreviewError = z.object({
  /** 1-based line in the file (the header is line 1). */
  line: z.number().int(),
  message: z.string(),
});
export type InvitePreviewError = z.infer<typeof InvitePreviewError>;

export const InvitePreview = z.object({
  valid: z.array(InviteInput),
  errors: z.array(InvitePreviewError),
  /** Emails repeated in the file (kept once) or already invited to the campaign. */
  duplicates: z.array(z.string()),
});
export type InvitePreview = z.infer<typeof InvitePreview>;

export const CampaignInviteSummary = z.object({
  id: z.string(),
  email: z.string(),
  name: z.string().nullable(),
  language: InviteLanguage,
  tags: InviteTags,
  status: InviteStatus,
  remindersSent: z.number().int(),
  sentAt: z.iso.datetime().nullable(),
  openedAt: z.iso.datetime().nullable(),
  joinedAt: z.iso.datetime().nullable(),
  completedAt: z.iso.datetime().nullable(),
  lastError: z.string().nullable(),
  createdAt: z.iso.datetime(),
});
export type CampaignInviteSummary = z.infer<typeof CampaignInviteSummary>;

export const InviteListQuery = z.object({
  status: InviteStatus.optional(),
  q: z.string().trim().max(254).default(''),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});
export type InviteListQuery = z.infer<typeof InviteListQuery>;

export const InviteListPage = z.object({
  items: z.array(CampaignInviteSummary),
  total: z.number().int(),
  page: z.number().int(),
  pageSize: z.number().int(),
  /** Invites per status across the campaign (the funnel). */
  counts: z.record(InviteStatus, z.number().int()),
});
export type InviteListPage = z.infer<typeof InviteListPage>;

// ---- Pipeline, notes and scorecards -----------------------------------------------------------

export const Recommendation = z.enum(['STRONG_YES', 'YES', 'NO', 'STRONG_NO']);
export type Recommendation = z.infer<typeof Recommendation>;

/** An org result row: the campaign row plus pipeline data. */
export const OrgResultRow = CampaignResultRow.extend({
  /** Mean of every reviewer's criteria ratings (1–5), or null without scorecards. */
  scorecardAverage: z.number().nullable(),
  scorecards: z.number().int(),
  notes: z.number().int(),
  tags: InviteTags.nullable(),
  identity: z.enum(['NONE', 'CAPTURED', 'VERIFIED', 'MISMATCH']),
});
export type OrgResultRow = z.infer<typeof OrgResultRow>;

export const OrgResultsExportQuery = CampaignResultsExportQuery.extend({
  /** Minimum scorecard average (1–5). */
  minScorecard: z.coerce.number().min(1).max(5).optional(),
});
export type OrgResultsExportQuery = z.infer<typeof OrgResultsExportQuery>;

export const OrgResultsQuery = OrgResultsExportQuery.extend({
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});
export type OrgResultsQuery = z.infer<typeof OrgResultsQuery>;

export const OrgResults = z.object({
  campaignId: z.string(),
  dimensions: z.array(z.object({ key: z.string(), name: z.string() })),
  rows: z.array(OrgResultRow),
  total: z.number().int(),
  page: z.number().int(),
  pageSize: z.number().int(),
  /** Consented candidates per stage (the pipeline board). */
  stages: z.record(CandidateStage, z.number().int()),
});
export type OrgResults = z.infer<typeof OrgResults>;

export const StageChangeBody = z.object({
  stage: CandidateStage,
  note: z.string().trim().max(500).nullable().default(null),
});
export type StageChangeBody = z.infer<typeof StageChangeBody>;

export const BulkStageChangeBody = StageChangeBody.extend({
  applicationIds: z.array(z.string().min(1).max(64)).min(1).max(500),
});
export type BulkStageChangeBody = z.infer<typeof BulkStageChangeBody>;

export const BulkStageChangeResult = z.object({ changed: z.number().int() });
export type BulkStageChangeResult = z.infer<typeof BulkStageChangeResult>;

export const NoteBody = z.object({ body: z.string().trim().min(1).max(4000) });
export type NoteBody = z.infer<typeof NoteBody>;

export const OrgNote = z.object({
  id: z.string(),
  author: z.object({
    userId: z.string(),
    name: z.string().nullable(),
    email: z.string().nullable(),
  }),
  body: z.string(),
  /** `@mentions` found in the text (as written; stored as plain text, not links). */
  mentions: z.array(z.string()),
  createdAt: z.iso.datetime(),
});
export type OrgNote = z.infer<typeof OrgNote>;

export const ScorecardBody = z.object({
  ratings: z.record(z.string(), z.number().int().min(1).max(5)),
  recommendation: Recommendation,
  comment: z.string().trim().max(2000).nullable().default(null),
});
export type ScorecardBody = z.infer<typeof ScorecardBody>;

export const OrgScorecard = z.object({
  id: z.string(),
  reviewer: z.object({
    userId: z.string(),
    name: z.string().nullable(),
    email: z.string().nullable(),
  }),
  ratings: z.record(z.string(), z.number().int()),
  average: z.number(),
  recommendation: Recommendation,
  comment: z.string().nullable(),
  updatedAt: z.iso.datetime(),
});
export type OrgScorecard = z.infer<typeof OrgScorecard>;

export const StageEvent = z.object({
  from: CandidateStage,
  to: CandidateStage,
  by: z.string(),
  note: z.string().nullable(),
  at: z.iso.datetime(),
});
export type StageEvent = z.infer<typeof StageEvent>;

// ---- Identity capture (lightweight, manual) -----------------------------------------------------

export const IdentityImageKind = z.enum(['SELFIE', 'ID_DOCUMENT', 'INTERVIEW_FRAME']);
export type IdentityImageKind = z.infer<typeof IdentityImageKind>;

export const IdentityDecision = z.enum(['VERIFIED', 'MISMATCH']);
export type IdentityDecision = z.infer<typeof IdentityDecision>;

/** Largest accepted image (JPEG or PNG). */
export const IDENTITY_IMAGE_MAX_BYTES = 2 * 1024 * 1024;

/** The candidate's side: what has been captured before starting. */
export const IdentityCaptureStatus = z.object({
  required: z.boolean(),
  selfie: z.boolean(),
  idDocument: z.boolean(),
  complete: z.boolean(),
});
export type IdentityCaptureStatus = z.infer<typeof IdentityCaptureStatus>;

export const IdentityReviewBody = z.object({
  decision: IdentityDecision,
  note: z.string().trim().max(500).nullable().default(null),
});
export type IdentityReviewBody = z.infer<typeof IdentityReviewBody>;

/** A reviewer's view: images are fetched from `imagePaths` with the bearer token (each view is audited). */
export const IdentityReview = z.object({
  status: z.enum(['NONE', 'CAPTURED', 'VERIFIED', 'MISMATCH']),
  imagePaths: z.object({
    selfie: z.string().nullable(),
    idDocument: z.string().nullable(),
    interviewFrame: z.string().nullable(),
  }),
  capturedAt: z.iso.datetime().nullable(),
  retentionExpiresAt: z.iso.datetime().nullable(),
  decision: z
    .object({
      decision: IdentityDecision,
      note: z.string().nullable(),
      by: z.string(),
      at: z.iso.datetime(),
    })
    .nullable(),
});
export type IdentityReview = z.infer<typeof IdentityReview>;

/** One candidate in the org portal: results, the report as the campaign allows, pipeline data. */
export const OrgCandidateDetail = z.object({
  row: OrgResultRow,
  employerView: EmployerView,
  /** Only with FULL_REPORT. */
  report: z
    .object({
      summary: z.string().nullable(),
      strengths: z.array(z.string()),
      gaps: z.array(z.string()),
      transcript: z.array(z.object({ question: z.string(), answer: z.string().nullable() })),
    })
    .nullable(),
  stageHistory: z.array(StageEvent),
  notes: z.array(OrgNote),
  scorecards: z.array(OrgScorecard),
  criteria: z.array(ScorecardCriterion),
  identity: IdentityReview.nullable(),
});
export type OrgCandidateDetail = z.infer<typeof OrgCandidateDetail>;

// ---- College (TPO) cohort analytics -------------------------------------------------------------

export const CohortQuery = z.object({
  /** Limit to one campaign; default: every campaign of the college. */
  campaignId: z.string().max(64).optional(),
  batch: z.string().trim().max(60).optional(),
  branch: z.string().trim().max(60).optional(),
  year: z.coerce.number().int().min(1990).max(2100).optional(),
});
export type CohortQuery = z.infer<typeof CohortQuery>;

export const CohortStudent = z.object({
  userId: z.string(),
  name: z.string().nullable(),
  email: z.string().nullable(),
  tags: InviteTags.nullable(),
  attempts: z.number().int(),
  firstOverall: z.number().int().nullable(),
  latestOverall: z.number().int().nullable(),
  /** Latest minus first (null with fewer than two scored attempts). */
  improvement: z.number().int().nullable(),
  latestBand: z.string().nullable(),
});
export type CohortStudent = z.infer<typeof CohortStudent>;

export const CohortAnalytics = z.object({
  participation: z.object({
    invited: z.number().int(),
    joined: z.number().int(),
    completed: z.number().int(),
    /** Completed ÷ invited (0–1), or null with no invites. */
    rate: z.number().nullable(),
  }),
  /** Latest attempt per student, by readiness band. */
  bands: z.array(z.object({ band: z.string(), count: z.number().int() })),
  dimensions: z.array(
    z.object({
      key: z.string(),
      name: z.string(),
      average: z.number().nullable(),
      count: z.number().int(),
    }),
  ),
  improvement: z.object({
    /** Students with at least two scored attempts. */
    students: z.number().int(),
    averageDelta: z.number().nullable(),
    improved: z.number().int(),
    declined: z.number().int(),
  }),
  students: z.array(CohortStudent),
  /** Values present in the tags, for the filter dropdowns. */
  tagValues: z.object({
    batch: z.array(z.string()),
    branch: z.array(z.string()),
    year: z.array(z.number().int()),
  }),
});
export type CohortAnalytics = z.infer<typeof CohortAnalytics>;

// ---- Webhooks and API keys ----------------------------------------------------------------------

export const WebhookEvent = z.enum(['campaign.candidate_completed', 'candidate.stage_changed']);
export type WebhookEvent = z.infer<typeof WebhookEvent>;

/** Signature header: `t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<raw body>">`. */
export const WEBHOOK_SIGNATURE_HEADER = 'x-cb-signature' as const;
export const WEBHOOK_EVENT_HEADER = 'x-cb-event' as const;
export const WEBHOOK_DELIVERY_HEADER = 'x-cb-delivery' as const;

export const CreateWebhookBody = z.object({
  url: z.url().max(500),
  events: z.array(WebhookEvent).min(1),
  description: z.string().trim().max(120).nullable().default(null),
});
export type CreateWebhookBody = z.infer<typeof CreateWebhookBody>;

export const UpdateWebhookBody = z.object({
  events: z.array(WebhookEvent).min(1),
  active: z.boolean(),
  description: z.string().trim().max(120).nullable(),
});
export type UpdateWebhookBody = z.infer<typeof UpdateWebhookBody>;

export const WebhookSummary = z.object({
  id: z.string(),
  url: z.string(),
  events: z.array(WebhookEvent),
  active: z.boolean(),
  description: z.string().nullable(),
  /** First characters of the signing secret (the secret itself is shown once). */
  secretHint: z.string(),
  createdAt: z.iso.datetime(),
});
export type WebhookSummary = z.infer<typeof WebhookSummary>;

export const WebhookWithSecret = z.object({
  webhook: WebhookSummary,
  /** Shown once; used to verify signatures. */
  secret: z.string(),
});
export type WebhookWithSecret = z.infer<typeof WebhookWithSecret>;

export const WebhookDeliveryStatus = z.enum(['PENDING', 'DELIVERED', 'FAILED']);
export type WebhookDeliveryStatus = z.infer<typeof WebhookDeliveryStatus>;

export const WebhookDelivery = z.object({
  id: z.string(),
  webhookId: z.string(),
  event: z.string(),
  status: WebhookDeliveryStatus,
  attempts: z.number().int(),
  lastStatusCode: z.number().int().nullable(),
  lastError: z.string().nullable(),
  nextAttemptAt: z.iso.datetime().nullable(),
  deliveredAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
});
export type WebhookDelivery = z.infer<typeof WebhookDelivery>;

/** Scopes an API key can have (read-only for the MVP). */
export const ApiKeyScope = z.enum(['results:read']);
export type ApiKeyScope = z.infer<typeof ApiKeyScope>;

export const CreateApiKeyBody = z.object({ name: z.string().trim().min(2).max(80) });
export type CreateApiKeyBody = z.infer<typeof CreateApiKeyBody>;

export const ApiKeySummary = z.object({
  id: z.string(),
  name: z.string(),
  /** The public part of the key (`cbk_<prefix>_…`). */
  prefix: z.string(),
  scopes: z.array(ApiKeyScope),
  createdAt: z.iso.datetime(),
  lastUsedAt: z.iso.datetime().nullable(),
  revokedAt: z.iso.datetime().nullable(),
});
export type ApiKeySummary = z.infer<typeof ApiKeySummary>;

export const ApiKeyWithSecret = z.object({
  apiKey: ApiKeySummary,
  /** The full key, shown once; only its hash is stored. */
  key: z.string(),
});
export type ApiKeyWithSecret = z.infer<typeof ApiKeyWithSecret>;

/** `GET /org-api/campaigns` (API key). */
export const ApiCampaign = z.object({
  id: z.string(),
  name: z.string(),
  status: z.string(),
  roleTitle: z.string(),
  joined: z.number().int(),
  createdAt: z.iso.datetime(),
});
export type ApiCampaign = z.infer<typeof ApiCampaign>;

/** Webhook payloads (the `data` of each event). */
export const CandidateCompletedPayload = z.object({
  campaignId: z.string(),
  applicationId: z.string(),
  candidate: z.object({ userId: z.string(), name: z.string().nullable(), email: z.string() }),
  status: ApplicationStatus,
  overall: z.number().int().nullable(),
  band: z.string().nullable(),
  completedAt: z.iso.datetime().nullable(),
});
export type CandidateCompletedPayload = z.infer<typeof CandidateCompletedPayload>;

export const StageChangedPayload = z.object({
  campaignId: z.string(),
  applicationId: z.string(),
  candidate: z.object({ userId: z.string() }),
  from: CandidateStage,
  to: CandidateStage,
  at: z.iso.datetime(),
});
export type StageChangedPayload = z.infer<typeof StageChangedPayload>;

// ---- Invite landing (candidate side) -----------------------------------------------------------

/** Languages a candidate may be invited in (the invite email's language). */
export const inviteLanguageFor = (pref: InterviewLanguagePreference | undefined): InviteLanguage =>
  pref === 'hi' || pref === 'te' ? pref : 'en';

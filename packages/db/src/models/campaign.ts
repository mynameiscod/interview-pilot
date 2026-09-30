import {
  CampaignExportStatus,
  CampaignStatus,
  CandidateStage,
  DEFAULT_INVITE_REMINDERS,
  EmployerView,
  InterviewLanguagePreference,
  InterviewMode,
} from '@cbi/shared-types';
import type {
  CampaignExportStatus as CampaignExportStatusT,
  CandidateStage as CandidateStageT,
  EmployerView as EmployerViewT,
  InviteReminders,
  CampaignProctoring,
  CampaignStatus as CampaignStatusT,
  InterviewLanguagePreference as InterviewLanguagePreferenceT,
  InterviewMode as InterviewModeT,
} from '@cbi/shared-types';
import mongoose, { Schema, type Model, type Types } from 'mongoose';

function model<T>(name: string, schema: Schema<T>): Model<T> {
  return (mongoose.models[name] as Model<T> | undefined) ?? mongoose.model<T>(name, schema);
}

// ---- campaigns ---------------------------------------------------------------------------------

export interface CampaignRecord {
  _id: Types.ObjectId;
  name: string;
  status: CampaignStatusT;
  companyId: Types.ObjectId | null;
  companyName: string;
  roleId: Types.ObjectId;
  roleTitle: string;
  /** Pinned at creation: every candidate is assessed on this exact blueprint and template. */
  blueprintId: Types.ObjectId;
  blueprintVersion: number;
  templateId: Types.ObjectId;
  templateKey: string;
  templateVersion: number;
  templateName: string;
  jobDescription: string | null;
  modes: InterviewModeT[];
  languages: InterviewLanguagePreferenceT[];
  window: { startAt: Date; endAt: Date | null };
  maxCandidates: number | null;
  joinedCount: number;
  proctoring: CampaignProctoring;
  candidateSeesReport: boolean;
  sponsoredCredits: { total: number; used: number } | null;
  /** SHA-256 of the invite token (the token itself is never stored). */
  tokenHash: string;
  tokenHint: string;
  /** The organisation that runs it (org portal); null for CodeBegun-run campaigns. */
  orgId: Types.ObjectId | null;
  /** Only invited emails may join. */
  requireInvite: boolean;
  /** What the organisation's reviewers see (scores only, or the full report). */
  employerView: EmployerViewT;
  /** A selfie and an ID photo are captured before the interview starts. */
  idCapture: boolean;
  reminders: InviteReminders;
  createdBy: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const campaignSchema = new Schema<CampaignRecord>(
  {
    name: { type: String, required: true },
    status: { type: String, enum: CampaignStatus.options, required: true, default: 'DRAFT' },
    companyId: { type: Schema.Types.ObjectId, ref: 'Company', default: null },
    companyName: { type: String, required: true },
    roleId: { type: Schema.Types.ObjectId, ref: 'Role', required: true },
    roleTitle: { type: String, required: true },
    blueprintId: { type: Schema.Types.ObjectId, ref: 'RoleBlueprint', required: true },
    blueprintVersion: { type: Number, required: true },
    templateId: { type: Schema.Types.ObjectId, ref: 'InterviewTemplate', required: true },
    templateKey: { type: String, required: true },
    templateVersion: { type: Number, required: true },
    templateName: { type: String, required: true },
    jobDescription: { type: String, default: null },
    modes: { type: [String], enum: InterviewMode.options, required: true },
    languages: { type: [String], enum: InterviewLanguagePreference.options, required: true },
    window: {
      type: new Schema(
        { startAt: { type: Date, required: true }, endAt: { type: Date, default: null } },
        { _id: false },
      ),
      required: true,
    },
    maxCandidates: { type: Number, default: null },
    joinedCount: { type: Number, required: true, default: 0 },
    proctoring: {
      type: new Schema(
        {
          recording: { type: String, enum: ['OFF', 'OPTIONAL', 'REQUIRED'], required: true },
          tabSwitchTracking: { type: Boolean, required: true },
        },
        { _id: false },
      ),
      required: true,
    },
    candidateSeesReport: { type: Boolean, required: true },
    sponsoredCredits: {
      type: new Schema(
        { total: { type: Number, required: true }, used: { type: Number, required: true } },
        { _id: false },
      ),
      default: null,
    },
    tokenHash: { type: String, required: true },
    tokenHint: { type: String, required: true },
    orgId: { type: Schema.Types.ObjectId, ref: 'Org', default: null },
    requireInvite: { type: Boolean, default: false },
    employerView: { type: String, enum: EmployerView.options, default: 'FULL_REPORT' },
    idCapture: { type: Boolean, default: false },
    reminders: {
      type: new Schema(
        {
          enabled: { type: Boolean, required: true },
          max: { type: Number, required: true },
          intervalHours: { type: Number, required: true },
        },
        { _id: false },
      ),
      default: () => ({ ...DEFAULT_INVITE_REMINDERS }),
    },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { timestamps: true, collection: 'campaigns' },
);
campaignSchema.index({ tokenHash: 1 }, { unique: true });
// The org portal lists an organisation's own campaigns, newest first.
campaignSchema.index({ orgId: 1, createdAt: -1 });
campaignSchema.index({ status: 1, 'window.endAt': 1 });

export const CampaignModel = model<CampaignRecord>('Campaign', campaignSchema);

// ---- campaignApplications ----------------------------------------------------------------------

export interface CampaignApplicationRecord {
  _id: Types.ObjectId;
  campaignId: Types.ObjectId;
  userId: Types.ObjectId;
  sessionId: Types.ObjectId;
  joinedAt: Date;
  adminNotes: string | null;
  /** Org portal pipeline stage (every application starts NEW). */
  stage: CandidateStageT;
  stageHistory: {
    from: CandidateStageT;
    to: CandidateStageT;
    by: Types.ObjectId;
    note: string | null;
    at: Date;
  }[];
  /** The invite the candidate joined through (or whose email matched), if any. */
  inviteId: Types.ObjectId | null;
  /** Set once when the report is ready (the invite is completed and the webhook queued). */
  completedNotifiedAt: Date | null;
}

const applicationSchema = new Schema<CampaignApplicationRecord>(
  {
    campaignId: { type: Schema.Types.ObjectId, ref: 'Campaign', required: true },
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    sessionId: { type: Schema.Types.ObjectId, ref: 'InterviewSession', required: true },
    joinedAt: { type: Date, required: true },
    adminNotes: { type: String, default: null },
    stage: { type: String, enum: CandidateStage.options, default: 'NEW' },
    stageHistory: {
      type: [
        new Schema(
          {
            from: { type: String, enum: CandidateStage.options, required: true },
            to: { type: String, enum: CandidateStage.options, required: true },
            by: { type: Schema.Types.ObjectId, ref: 'User', required: true },
            note: { type: String, default: null },
            at: { type: Date, required: true },
          },
          { _id: false },
        ),
      ],
      default: [],
    },
    inviteId: { type: Schema.Types.ObjectId, ref: 'CampaignInvite', default: null },
    completedNotifiedAt: { type: Date, default: null },
  },
  { collection: 'campaignApplications', versionKey: false },
);
// One application (and interview) per candidate per campaign.
applicationSchema.index({ campaignId: 1, userId: 1 }, { unique: true });
applicationSchema.index({ campaignId: 1, joinedAt: -1 });
applicationSchema.index({ sessionId: 1 });
applicationSchema.index({ campaignId: 1, stage: 1 });

export const CampaignApplicationModel = model<CampaignApplicationRecord>(
  'CampaignApplication',
  applicationSchema,
);

// ---- campaignExports (package ZIPs built by the worker) -----------------------------------------

export interface CampaignExportRecord {
  _id: Types.ObjectId;
  campaignId: Types.ObjectId;
  requestedBy: Types.ObjectId;
  status: CampaignExportStatusT;
  progress: { done: number; total: number };
  /** Object storage key of the ZIP (READY only; cleared when the file is deleted). */
  storageKey: string | null;
  fileName: string;
  sizeBytes: number | null;
  error: string | null;
  startedAt: Date | null;
  completedAt: Date | null;
  /**
   * While QUEUED or RUNNING: when the export is given up as stuck. When READY:
   * when the file is deleted. The record itself is removed by a TTL index a
   * week later, so recent history stays visible.
   */
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

/** Statuses of an export still being built; a campaign has at most one such export. */
export const ACTIVE_CAMPAIGN_EXPORT_STATUSES: CampaignExportStatusT[] = ['QUEUED', 'RUNNING'];

/** A queued or running export not finished by then is marked FAILED by the worker's sweep. */
export const CAMPAIGN_EXPORT_STUCK_AFTER_MS = 6 * 3600_000;

/** Export records outlive their file by this long before MongoDB removes them. */
export const CAMPAIGN_EXPORT_RECORD_GRACE_SEC = 7 * 24 * 3600;

const campaignExportSchema = new Schema<CampaignExportRecord>(
  {
    campaignId: { type: Schema.Types.ObjectId, ref: 'Campaign', required: true },
    requestedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    status: { type: String, enum: CampaignExportStatus.options, required: true },
    progress: {
      type: new Schema(
        { done: { type: Number, required: true }, total: { type: Number, required: true } },
        { _id: false },
      ),
      required: true,
    },
    storageKey: { type: String, default: null },
    fileName: { type: String, required: true },
    sizeBytes: { type: Number, default: null },
    error: { type: String, default: null },
    startedAt: { type: Date, default: null },
    completedAt: { type: Date, default: null },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true, collection: 'campaignExports' },
);
campaignExportSchema.index({ campaignId: 1, createdAt: -1 });
// At most one queued or running export per campaign: two simultaneous requests
// cannot both create one (the loser returns the winner's export).
campaignExportSchema.index(
  { campaignId: 1 },
  {
    name: 'campaignId_active_unique',
    unique: true,
    partialFilterExpression: { status: { $in: ACTIVE_CAMPAIGN_EXPORT_STATUSES } },
  },
);
// The sweep: files past retention, and exports stuck in the queue.
campaignExportSchema.index({ status: 1, expiresAt: 1 });
campaignExportSchema.index(
  { expiresAt: 1 },
  { expireAfterSeconds: CAMPAIGN_EXPORT_RECORD_GRACE_SEC },
);

export const CampaignExportModel = model<CampaignExportRecord>(
  'CampaignExport',
  campaignExportSchema,
);

// ---- reviewRevisions (append-only log of manual reviews) -----------------------------------------

export interface ReviewRevisionRecord {
  _id: Types.ObjectId;
  sessionId: Types.ObjectId;
  target: 'SCORE';
  fromRevision: number;
  toRevision: number;
  reportRevision: number;
  reviewerId: Types.ObjectId;
  reason: string;
  changes: { key: string; from: number | null; to: number | null; note: string }[];
  at: Date;
}

const reviewRevisionSchema = new Schema<ReviewRevisionRecord>(
  {
    sessionId: { type: Schema.Types.ObjectId, ref: 'InterviewSession', required: true },
    target: { type: String, enum: ['SCORE'], required: true },
    fromRevision: { type: Number, required: true },
    toRevision: { type: Number, required: true },
    reportRevision: { type: Number, required: true },
    reviewerId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    reason: { type: String, required: true },
    changes: { type: Schema.Types.Mixed, default: [] },
    at: { type: Date, required: true },
  },
  { collection: 'reviewRevisions', versionKey: false },
);
reviewRevisionSchema.index({ sessionId: 1, toRevision: 1 }, { unique: true });

export const ReviewRevisionModel = model<ReviewRevisionRecord>(
  'ReviewRevision',
  reviewRevisionSchema,
);

import { CampaignStatus, InterviewLanguagePreference, InterviewMode } from '@cbi/shared-types';
import type {
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
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { timestamps: true, collection: 'campaigns' },
);
campaignSchema.index({ tokenHash: 1 }, { unique: true });
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
}

const applicationSchema = new Schema<CampaignApplicationRecord>(
  {
    campaignId: { type: Schema.Types.ObjectId, ref: 'Campaign', required: true },
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    sessionId: { type: Schema.Types.ObjectId, ref: 'InterviewSession', required: true },
    joinedAt: { type: Date, required: true },
    adminNotes: { type: String, default: null },
  },
  { collection: 'campaignApplications', versionKey: false },
);
// One application (and interview) per candidate per campaign.
applicationSchema.index({ campaignId: 1, userId: 1 }, { unique: true });
applicationSchema.index({ campaignId: 1, joinedAt: -1 });

export const CampaignApplicationModel = model<CampaignApplicationRecord>(
  'CampaignApplication',
  applicationSchema,
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

import type { EncryptedSecret } from '@cbi/ai-core';
import {
  ApiKeyScope,
  IdentityDecision,
  InviteLanguage,
  InviteStatus,
  OrgMemberStatus,
  OrgRole,
  OrgStatus,
  OrgType,
  Recommendation,
  WebhookDeliveryStatus,
  WebhookEvent,
} from '@cbi/shared-types';
import type {
  ApiKeyScope as ApiKeyScopeT,
  IdentityDecision as IdentityDecisionT,
  IdentityImageKind,
  InviteLanguage as InviteLanguageT,
  InviteStatus as InviteStatusT,
  OrgMemberStatus as OrgMemberStatusT,
  OrgRole as OrgRoleT,
  OrgStatus as OrgStatusT,
  OrgType as OrgTypeT,
  Recommendation as RecommendationT,
  ScorecardCriterion,
  WebhookDeliveryStatus as WebhookDeliveryStatusT,
  WebhookEvent as WebhookEventT,
} from '@cbi/shared-types';
import mongoose, { Schema, type Model, type Types } from 'mongoose';

function model<T>(name: string, schema: Schema<T>): Model<T> {
  return (mongoose.models[name] as Model<T> | undefined) ?? mongoose.model<T>(name, schema);
}

// ---- orgs ----------------------------------------------------------------------------------------

export interface OrgRecord {
  _id: Types.ObjectId;
  name: string;
  type: OrgTypeT;
  status: OrgStatusT;
  /** Members allowed (INVITED and ACTIVE count). */
  seats: number;
  /** Candidates who may join the organisation's campaigns; total null = unlimited. */
  interviewQuota: { total: number | null; used: number };
  /**
   * Sponsored interviews. `balance` is not yet given to any campaign; a
   * campaign's `sponsoredCredits.total` is taken from it (and unused units
   * return when the campaign closes). `allocated` counts what campaigns hold.
   */
  wallet: { balance: number; allocated: number };
  mfaRequired: boolean;
  scorecardCriteria: ScorecardCriterion[];
  createdBy: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const orgSchema = new Schema<OrgRecord>(
  {
    name: { type: String, required: true },
    type: { type: String, enum: OrgType.options, required: true },
    status: { type: String, enum: OrgStatus.options, required: true, default: 'ACTIVE' },
    seats: { type: Number, required: true },
    interviewQuota: {
      type: new Schema(
        { total: { type: Number, default: null }, used: { type: Number, required: true } },
        { _id: false },
      ),
      required: true,
    },
    wallet: {
      type: new Schema(
        {
          balance: { type: Number, required: true, min: 0 },
          allocated: { type: Number, required: true, min: 0 },
        },
        { _id: false },
      ),
      required: true,
    },
    mfaRequired: { type: Boolean, required: true, default: false },
    scorecardCriteria: {
      type: [new Schema({ key: String, label: String }, { _id: false })],
      default: [],
    },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { timestamps: true, collection: 'orgs' },
);
orgSchema.index({ name: 1 });
orgSchema.index({ createdAt: -1 });

export const OrgModel = model<OrgRecord>('Org', orgSchema);

// ---- orgMembers --------------------------------------------------------------------------------

export interface OrgMemberRecord {
  _id: Types.ObjectId;
  orgId: Types.ObjectId;
  userId: Types.ObjectId;
  role: OrgRoleT;
  status: OrgMemberStatusT;
  invitedBy: Types.ObjectId;
  invitedAt: Date;
  activatedAt: Date | null;
  removedAt: Date | null;
}

const orgMemberSchema = new Schema<OrgMemberRecord>(
  {
    orgId: { type: Schema.Types.ObjectId, ref: 'Org', required: true },
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    role: { type: String, enum: OrgRole.options, required: true },
    status: { type: String, enum: OrgMemberStatus.options, required: true },
    invitedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    invitedAt: { type: Date, required: true },
    activatedAt: { type: Date, default: null },
    removedAt: { type: Date, default: null },
  },
  { collection: 'orgMembers', versionKey: false },
);
// A person belongs to at most one organisation at a time (their org session is scoped to it).
orgMemberSchema.index(
  { userId: 1 },
  {
    unique: true,
    partialFilterExpression: { status: { $in: ['INVITED', 'ACTIVE'] } },
    name: 'one_live_membership_per_user',
  },
);
orgMemberSchema.index({ orgId: 1, status: 1, invitedAt: 1 });

export const OrgMemberModel = model<OrgMemberRecord>('OrgMember', orgMemberSchema);

// ---- campaignInvites -----------------------------------------------------------------------------

export interface CampaignInviteRecord {
  _id: Types.ObjectId;
  orgId: Types.ObjectId;
  campaignId: Types.ObjectId;
  /** Lower-case. */
  email: string;
  name: string | null;
  language: InviteLanguageT;
  tags: { batch: string | null; branch: string | null; year: number | null };
  status: InviteStatusT;
  /** SHA-256 of the invite token (for lookups). */
  tokenHash: string;
  /**
   * The token itself, encrypted with the platform secret box: the worker
   * puts the same link in the invite and in each reminder.
   */
  tokenEnc: EncryptedSecret;
  remindersSent: number;
  /** When the worker should next email (the invite, then each reminder); null = nothing due. */
  nextSendAt: Date | null;
  sendAttempts: number;
  sentAt: Date | null;
  lastReminderAt: Date | null;
  openedAt: Date | null;
  joinedAt: Date | null;
  completedAt: Date | null;
  userId: Types.ObjectId | null;
  applicationId: Types.ObjectId | null;
  lastError: string | null;
  createdBy: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const inviteSchema = new Schema<CampaignInviteRecord>(
  {
    orgId: { type: Schema.Types.ObjectId, ref: 'Org', required: true },
    campaignId: { type: Schema.Types.ObjectId, ref: 'Campaign', required: true },
    email: { type: String, required: true },
    name: { type: String, default: null },
    language: { type: String, enum: InviteLanguage.options, required: true },
    tags: {
      type: new Schema(
        {
          batch: { type: String, default: null },
          branch: { type: String, default: null },
          year: { type: Number, default: null },
        },
        { _id: false },
      ),
      required: true,
    },
    status: { type: String, enum: InviteStatus.options, required: true },
    tokenHash: { type: String, required: true },
    tokenEnc: { type: Schema.Types.Mixed, required: true },
    remindersSent: { type: Number, required: true, default: 0 },
    nextSendAt: { type: Date, default: null },
    sendAttempts: { type: Number, required: true, default: 0 },
    sentAt: { type: Date, default: null },
    lastReminderAt: { type: Date, default: null },
    openedAt: { type: Date, default: null },
    joinedAt: { type: Date, default: null },
    completedAt: { type: Date, default: null },
    userId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    applicationId: { type: Schema.Types.ObjectId, ref: 'CampaignApplication', default: null },
    lastError: { type: String, default: null },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { timestamps: true, collection: 'campaignInvites' },
);
inviteSchema.index({ tokenHash: 1 }, { unique: true });
// One invite per email per campaign.
inviteSchema.index({ campaignId: 1, email: 1 }, { unique: true });
inviteSchema.index({ campaignId: 1, status: 1, createdAt: -1 });
// The worker's mailer: invites and reminders that are due.
inviteSchema.index(
  { nextSendAt: 1 },
  { partialFilterExpression: { nextSendAt: { $type: 'date' } } },
);
inviteSchema.index({ userId: 1 });
inviteSchema.index({ orgId: 1, 'tags.batch': 1 });

export const CampaignInviteModel = model<CampaignInviteRecord>('CampaignInvite', inviteSchema);

// ---- orgNotes and orgScorecards ----------------------------------------------------------------

export interface OrgNoteRecord {
  _id: Types.ObjectId;
  orgId: Types.ObjectId;
  campaignId: Types.ObjectId;
  applicationId: Types.ObjectId;
  /** The candidate the note is about (erased with their account). */
  candidateId: Types.ObjectId;
  authorId: Types.ObjectId;
  body: string;
  mentions: string[];
  createdAt: Date;
}

const noteSchema = new Schema<OrgNoteRecord>(
  {
    orgId: { type: Schema.Types.ObjectId, ref: 'Org', required: true },
    campaignId: { type: Schema.Types.ObjectId, ref: 'Campaign', required: true },
    applicationId: { type: Schema.Types.ObjectId, ref: 'CampaignApplication', required: true },
    candidateId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    authorId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    body: { type: String, required: true },
    mentions: { type: [String], default: [] },
  },
  { timestamps: { createdAt: true, updatedAt: false }, collection: 'orgNotes' },
);
noteSchema.index({ orgId: 1, applicationId: 1, createdAt: 1 });
noteSchema.index({ candidateId: 1 });

export const OrgNoteModel = model<OrgNoteRecord>('OrgNote', noteSchema);

export interface OrgScorecardRecord {
  _id: Types.ObjectId;
  orgId: Types.ObjectId;
  campaignId: Types.ObjectId;
  applicationId: Types.ObjectId;
  candidateId: Types.ObjectId;
  reviewerId: Types.ObjectId;
  ratings: Record<string, number>;
  average: number;
  recommendation: RecommendationT;
  comment: string | null;
  createdAt: Date;
  updatedAt: Date;
}

const scorecardSchema = new Schema<OrgScorecardRecord>(
  {
    orgId: { type: Schema.Types.ObjectId, ref: 'Org', required: true },
    campaignId: { type: Schema.Types.ObjectId, ref: 'Campaign', required: true },
    applicationId: { type: Schema.Types.ObjectId, ref: 'CampaignApplication', required: true },
    candidateId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    reviewerId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    ratings: { type: Schema.Types.Mixed, required: true },
    average: { type: Number, required: true },
    recommendation: { type: String, enum: Recommendation.options, required: true },
    comment: { type: String, default: null },
  },
  { timestamps: true, collection: 'orgScorecards' },
);
// One scorecard per reviewer per candidate (editing replaces it).
scorecardSchema.index({ applicationId: 1, reviewerId: 1 }, { unique: true });
scorecardSchema.index({ orgId: 1, campaignId: 1 });
scorecardSchema.index({ candidateId: 1 });

export const OrgScorecardModel = model<OrgScorecardRecord>('OrgScorecard', scorecardSchema);

// ---- orgWebhooks and their deliveries ---------------------------------------------------------

export interface OrgWebhookRecord {
  _id: Types.ObjectId;
  orgId: Types.ObjectId;
  url: string;
  events: WebhookEventT[];
  active: boolean;
  description: string | null;
  /** The signing secret, encrypted with the platform secret box (bound to the webhook id). */
  secret: EncryptedSecret;
  secretHint: string;
  createdBy: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const webhookSchema = new Schema<OrgWebhookRecord>(
  {
    orgId: { type: Schema.Types.ObjectId, ref: 'Org', required: true },
    url: { type: String, required: true },
    events: { type: [String], enum: WebhookEvent.options, required: true },
    active: { type: Boolean, required: true, default: true },
    description: { type: String, default: null },
    secret: { type: Schema.Types.Mixed, required: true },
    secretHint: { type: String, required: true },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { timestamps: true, collection: 'orgWebhooks' },
);
webhookSchema.index({ orgId: 1, active: 1 });

export const OrgWebhookModel = model<OrgWebhookRecord>('OrgWebhook', webhookSchema);

export interface WebhookDeliveryRecord {
  _id: Types.ObjectId;
  orgId: Types.ObjectId;
  webhookId: Types.ObjectId;
  event: WebhookEventT | 'ping';
  /** The JSON body sent (the same bytes on every attempt, so signatures are reproducible). */
  body: string;
  status: WebhookDeliveryStatusT;
  attempts: number;
  nextAttemptAt: Date | null;
  /** A worker's claim on the delivery (a crashed worker's claim runs out). */
  lockedUntil: Date | null;
  lastStatusCode: number | null;
  lastError: string | null;
  deliveredAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/** Delivery log entries are kept this long. */
export const WEBHOOK_DELIVERY_RETENTION_SEC = 30 * 24 * 3600;

const deliverySchema = new Schema<WebhookDeliveryRecord>(
  {
    orgId: { type: Schema.Types.ObjectId, ref: 'Org', required: true },
    webhookId: { type: Schema.Types.ObjectId, ref: 'OrgWebhook', required: true },
    event: { type: String, required: true },
    body: { type: String, required: true },
    status: { type: String, enum: WebhookDeliveryStatus.options, required: true },
    attempts: { type: Number, required: true, default: 0 },
    nextAttemptAt: { type: Date, default: null },
    lockedUntil: { type: Date, default: null },
    lastStatusCode: { type: Number, default: null },
    lastError: { type: String, default: null },
    deliveredAt: { type: Date, default: null },
  },
  { timestamps: true, collection: 'webhookDeliveries' },
);
deliverySchema.index({ status: 1, nextAttemptAt: 1 });
deliverySchema.index({ orgId: 1, webhookId: 1, createdAt: -1 });
deliverySchema.index({ createdAt: 1 }, { expireAfterSeconds: WEBHOOK_DELIVERY_RETENTION_SEC });

export const WebhookDeliveryModel = model<WebhookDeliveryRecord>('WebhookDelivery', deliverySchema);

// ---- orgApiKeys --------------------------------------------------------------------------------

export interface OrgApiKeyRecord {
  _id: Types.ObjectId;
  orgId: Types.ObjectId;
  name: string;
  /** Public part of the key, unique (shown in lists). */
  prefix: string;
  /** SHA-256 of the whole key (the key has 256 random bits, so a fast hash is enough). */
  keyHash: string;
  scopes: ApiKeyScopeT[];
  createdBy: Types.ObjectId;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
}

const apiKeySchema = new Schema<OrgApiKeyRecord>(
  {
    orgId: { type: Schema.Types.ObjectId, ref: 'Org', required: true },
    name: { type: String, required: true },
    prefix: { type: String, required: true },
    keyHash: { type: String, required: true },
    scopes: { type: [String], enum: ApiKeyScope.options, required: true },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    lastUsedAt: { type: Date, default: null },
    revokedAt: { type: Date, default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false }, collection: 'orgApiKeys' },
);
apiKeySchema.index({ keyHash: 1 }, { unique: true });
apiKeySchema.index({ prefix: 1 }, { unique: true });
apiKeySchema.index({ orgId: 1, createdAt: -1 });

export const OrgApiKeyModel = model<OrgApiKeyRecord>('OrgApiKey', apiKeySchema);

// ---- identityCaptures (selfie and ID photo; manual verification only) -------------------------

export interface IdentityImageRecord {
  storageKey: string;
  mimeType: 'image/jpeg' | 'image/png';
  bytes: number;
  at: Date;
}

export interface IdentityCaptureRecord {
  _id: Types.ObjectId;
  sessionId: Types.ObjectId;
  userId: Types.ObjectId;
  campaignId: Types.ObjectId;
  orgId: Types.ObjectId | null;
  images: Partial<Record<IdentityImageKind, IdentityImageRecord>>;
  /** The IDENTITY_CAPTURE consent text the candidate accepted. */
  consentTextId: Types.ObjectId | null;
  /** Images are deleted by the worker's media sweep after this. */
  retentionExpiresAt: Date;
  decision: {
    decision: IdentityDecisionT;
    note: string | null;
    by: Types.ObjectId;
    at: Date;
  } | null;
  deletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const identityImageSchema = new Schema<IdentityImageRecord>(
  {
    storageKey: { type: String, required: true },
    mimeType: { type: String, enum: ['image/jpeg', 'image/png'], required: true },
    bytes: { type: Number, required: true },
    at: { type: Date, required: true },
  },
  { _id: false },
);

const identityCaptureSchema = new Schema<IdentityCaptureRecord>(
  {
    sessionId: { type: Schema.Types.ObjectId, ref: 'InterviewSession', required: true },
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    campaignId: { type: Schema.Types.ObjectId, ref: 'Campaign', required: true },
    orgId: { type: Schema.Types.ObjectId, ref: 'Org', default: null },
    images: {
      type: new Schema(
        {
          SELFIE: { type: identityImageSchema, default: undefined },
          ID_DOCUMENT: { type: identityImageSchema, default: undefined },
          INTERVIEW_FRAME: { type: identityImageSchema, default: undefined },
        },
        { _id: false },
      ),
      default: () => ({}),
    },
    consentTextId: { type: Schema.Types.ObjectId, ref: 'ConsentText', default: null },
    retentionExpiresAt: { type: Date, required: true },
    decision: {
      type: new Schema(
        {
          decision: { type: String, enum: IdentityDecision.options, required: true },
          note: { type: String, default: null },
          by: { type: Schema.Types.ObjectId, ref: 'User', required: true },
          at: { type: Date, required: true },
        },
        { _id: false },
      ),
      default: null,
    },
    deletedAt: { type: Date, default: null },
  },
  { timestamps: true, collection: 'identityCaptures' },
);
identityCaptureSchema.index({ sessionId: 1 }, { unique: true });
identityCaptureSchema.index({ userId: 1 });
identityCaptureSchema.index({ retentionExpiresAt: 1, deletedAt: 1 });

export const IdentityCaptureModel = model<IdentityCaptureRecord>(
  'IdentityCapture',
  identityCaptureSchema,
);

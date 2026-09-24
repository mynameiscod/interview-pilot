import { ClientEventName, SettingKey } from '@cbi/shared-types';
import type {
  ClientEventName as ClientEventNameT,
  SettingKey as SettingKeyT,
} from '@cbi/shared-types';
import mongoose, { Schema, type Model, type Types } from 'mongoose';

function model<T>(name: string, schema: Schema<T>): Model<T> {
  return (mongoose.models[name] as Model<T> | undefined) ?? mongoose.model<T>(name, schema);
}

/** Analytics events are kept this long (design §4.5 default), then expire. */
export const ANALYTICS_RETENTION_DAYS = 400;

// ---- analyticsEvents (client events; separate from the audit log) ------------------------------

export interface AnalyticsEventRecord {
  _id: Types.ObjectId;
  name: ClientEventNameT;
  userId: Types.ObjectId | null;
  anonId: string;
  path: string | null;
  props: Record<string, string | number | boolean | null>;
  at: Date;
  receivedAt: Date;
}

const analyticsEventSchema = new Schema<AnalyticsEventRecord>(
  {
    name: { type: String, enum: ClientEventName.options, required: true },
    userId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    anonId: { type: String, required: true },
    path: { type: String, default: null },
    props: { type: Schema.Types.Mixed, default: {} },
    at: { type: Date, required: true },
    receivedAt: { type: Date, required: true },
  },
  { collection: 'analyticsEvents', versionKey: false, minimize: false },
);
analyticsEventSchema.index({ name: 1, at: 1 });
analyticsEventSchema.index({ userId: 1, at: 1 });
analyticsEventSchema.index({ at: 1 }, { expireAfterSeconds: ANALYTICS_RETENTION_DAYS * 24 * 3600 });

export const AnalyticsEventModel = model<AnalyticsEventRecord>(
  'AnalyticsEvent',
  analyticsEventSchema,
);

// ---- analyticsDaily (rollups, recomputed idempotently per day) -----------------------------------

export interface AnalyticsDailyRecord {
  _id: Types.ObjectId;
  /** Calendar day in India time, `YYYY-MM-DD`. */
  day: string;
  metric: string;
  dims: Record<string, string>;
  /** Stable key of `dims` ('' for the total). */
  dimsHash: string;
  value: number;
  computedAt: Date;
}

const analyticsDailySchema = new Schema<AnalyticsDailyRecord>(
  {
    day: { type: String, required: true },
    metric: { type: String, required: true },
    dims: { type: Schema.Types.Mixed, default: {} },
    dimsHash: { type: String, default: '' },
    value: { type: Number, required: true },
    computedAt: { type: Date, required: true },
  },
  { collection: 'analyticsDaily', versionKey: false, minimize: false },
);
analyticsDailySchema.index({ day: 1, metric: 1, dimsHash: 1 }, { unique: true });
analyticsDailySchema.index({ metric: 1, day: 1 });

export const AnalyticsDailyModel = model<AnalyticsDailyRecord>(
  'AnalyticsDaily',
  analyticsDailySchema,
);

// ---- featureFlags ------------------------------------------------------------------------------

export interface FeatureFlagRecord {
  _id: Types.ObjectId;
  key: string;
  description: string;
  enabled: boolean;
  rolloutPercent: number;
  clientVisible: boolean;
  updatedBy: Types.ObjectId | null;
  createdAt: Date;
  updatedAt: Date;
}

const featureFlagSchema = new Schema<FeatureFlagRecord>(
  {
    key: { type: String, required: true },
    description: { type: String, required: true },
    enabled: { type: Boolean, required: true, default: false },
    rolloutPercent: { type: Number, required: true, default: 100, min: 0, max: 100 },
    clientVisible: { type: Boolean, required: true, default: true },
    updatedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true, collection: 'featureFlags' },
);
featureFlagSchema.index({ key: 1 }, { unique: true });

export const FeatureFlagModel = model<FeatureFlagRecord>('FeatureFlag', featureFlagSchema);

// ---- systemSettings ----------------------------------------------------------------------------

export interface SystemSettingRecord {
  _id: Types.ObjectId;
  key: SettingKeyT;
  value: unknown;
  updatedBy: Types.ObjectId | null;
  createdAt: Date;
  updatedAt: Date;
}

const systemSettingSchema = new Schema<SystemSettingRecord>(
  {
    key: { type: String, enum: SettingKey.options, required: true },
    value: { type: Schema.Types.Mixed, required: true },
    updatedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true, collection: 'systemSettings', minimize: false },
);
systemSettingSchema.index({ key: 1 }, { unique: true });

export const SystemSettingModel = model<SystemSettingRecord>('SystemSetting', systemSettingSchema);

// ---- shareLinks (Candidate Proof, feature-flagged) ------------------------------------------------

export interface ShareLinkRecord {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  sessionId: Types.ObjectId;
  /** The report revision current when the link was made (later reviews are shown too). */
  reportRevision: number;
  /** SHA-256 of the token; the token itself is never stored. */
  tokenHash: string;
  tokenHint: string;
  expiresAt: Date;
  revokedAt: Date | null;
  views: number;
  lastViewedAt: Date | null;
  createdAt: Date;
}

const shareLinkSchema = new Schema<ShareLinkRecord>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    sessionId: { type: Schema.Types.ObjectId, ref: 'InterviewSession', required: true },
    reportRevision: { type: Number, required: true },
    tokenHash: { type: String, required: true },
    tokenHint: { type: String, required: true },
    expiresAt: { type: Date, required: true },
    revokedAt: { type: Date, default: null },
    views: { type: Number, default: 0 },
    lastViewedAt: { type: Date, default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false }, collection: 'shareLinks' },
);
shareLinkSchema.index({ tokenHash: 1 }, { unique: true });
shareLinkSchema.index({ userId: 1, sessionId: 1, createdAt: -1 });
// Expired links are removed a month after they stop working.
shareLinkSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 30 * 24 * 3600 });

export const ShareLinkModel = model<ShareLinkRecord>('ShareLink', shareLinkSchema);

import {
  IntegrityEventType,
  MediaDeletionStatus,
  MediaFileStatus,
  MediaKind,
  MediaMime,
  MediaStatus,
} from '@cbi/shared-types';
import type {
  IntegrityEventType as IntegrityEventTypeT,
  MediaDeletionStatus as MediaDeletionStatusT,
  MediaFileStatus as MediaFileStatusT,
  MediaKind as MediaKindT,
  MediaMime as MediaMimeT,
  MediaStatus as MediaStatusT,
} from '@cbi/shared-types';
import mongoose, { Schema, type Model, type Types } from 'mongoose';

function model<T>(name: string, schema: Schema<T>): Model<T> {
  return (mongoose.models[name] as Model<T> | undefined) ?? mongoose.model<T>(name, schema);
}

// ---- mediaAssets ----------------------------------------------------------------------------

export interface MediaSegmentRecord {
  idx: number;
  /** The MediaRecorder instance that produced it (each starts a new container); absent = 0. */
  part?: number;
  /** Starts with a container header; absent on older records, where only index 0 had one. */
  header?: boolean;
  storageKey: string;
  bytes: number;
  sha256: string;
  uploadedAt: Date;
}

export interface MediaAssetRecord {
  _id: Types.ObjectId;
  sessionId: Types.ObjectId;
  userId: Types.ObjectId;
  kind: MediaKindT;
  mimeType: MediaMimeT;
  status: MediaStatusT;
  /** Stored segments; the browser uploads them in any order and may retry. */
  segments: MediaSegmentRecord[];
  bytes: number;
  /** Set by finalize (the browser's count) or by the sweep (highest index seen + 1). */
  expectedSegments: number | null;
  durationMs: number | null;
  consentId: Types.ObjectId | null;
  manifestKey: string | null;
  finalizedAt: Date | null;
  /** The joined, seekable recording the worker builds after finalize. */
  playbackFile: {
    status: MediaFileStatusT;
    key: string | null;
    bytes: number | null;
    /** When the current status was set (a PROCESSING claim's lease starts here). */
    at: Date | null;
    attempts: number;
    error: string | null;
  };
  retentionExpiresAt: Date;
  deletion: {
    /** DELETING: objects are being removed; no new segment is accepted. */
    status: MediaDeletionStatusT | 'DELETING';
    at: Date | null;
    reason: string | null;
    by: string | null;
    /** Every object key removed, deleted again by the sweep after `sweepAfter` (late writers). */
    keys: string[];
    sweepAfter: Date | null;
  };
  createdAt: Date;
  updatedAt: Date;
}

const segmentSchema = new Schema<MediaSegmentRecord>(
  {
    idx: { type: Number, required: true },
    part: { type: Number },
    header: { type: Boolean },
    storageKey: { type: String, required: true },
    bytes: { type: Number, required: true },
    sha256: { type: String, required: true },
    uploadedAt: { type: Date, required: true },
  },
  { _id: false },
);

const mediaAssetSchema = new Schema<MediaAssetRecord>(
  {
    sessionId: { type: Schema.Types.ObjectId, ref: 'InterviewSession', required: true },
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    kind: { type: String, enum: MediaKind.options, required: true },
    mimeType: { type: String, enum: MediaMime.options, required: true },
    status: { type: String, enum: MediaStatus.options, required: true, default: 'RECORDING' },
    segments: { type: [segmentSchema], default: [] },
    bytes: { type: Number, required: true, default: 0 },
    expectedSegments: { type: Number, default: null },
    durationMs: { type: Number, default: null },
    // The RECORDING consent text the candidate accepted.
    consentId: { type: Schema.Types.ObjectId, ref: 'ConsentText', default: null },
    manifestKey: { type: String, default: null },
    finalizedAt: { type: Date, default: null },
    playbackFile: {
      type: new Schema(
        {
          status: { type: String, enum: MediaFileStatus.options, required: true },
          key: { type: String, default: null },
          bytes: { type: Number, default: null },
          at: { type: Date, default: null },
          attempts: { type: Number, default: 0 },
          error: { type: String, default: null },
        },
        { _id: false },
      ),
      default: () => ({
        status: 'NONE',
        key: null,
        bytes: null,
        at: null,
        attempts: 0,
        error: null,
      }),
    },
    retentionExpiresAt: { type: Date, required: true },
    deletion: {
      type: new Schema(
        {
          status: {
            type: String,
            enum: [...MediaDeletionStatus.options, 'DELETING'],
            required: true,
          },
          at: { type: Date, default: null },
          reason: { type: String, default: null },
          by: { type: String, default: null },
          keys: { type: [String], default: [] },
          sweepAfter: { type: Date, default: null },
        },
        { _id: false },
      ),
      default: () => ({
        status: 'NONE',
        at: null,
        reason: null,
        by: null,
        keys: [],
        sweepAfter: null,
      }),
    },
  },
  { timestamps: true, collection: 'mediaAssets' },
);
mediaAssetSchema.index({ sessionId: 1, kind: 1 }, { unique: true });
mediaAssetSchema.index({ retentionExpiresAt: 1, 'deletion.status': 1 });
mediaAssetSchema.index({ status: 1, updatedAt: 1 });
mediaAssetSchema.index({ userId: 1, createdAt: -1 });
mediaAssetSchema.index({ 'playbackFile.status': 1, 'playbackFile.at': 1 });
mediaAssetSchema.index({ 'deletion.status': 1, 'deletion.sweepAfter': 1 });

export const MediaAssetModel = model<MediaAssetRecord>('MediaAsset', mediaAssetSchema);

// ---- integrityEvents -----------------------------------------------------------------------

export interface IntegrityEventRecord {
  _id: Types.ObjectId;
  sessionId: Types.ObjectId;
  userId: Types.ObjectId;
  type: IntegrityEventTypeT;
  /** Server receive time (authoritative). */
  at: Date;
  /** The browser's clock, for reference. */
  clientAt: Date;
  value: number | null;
}

const integrityEventSchema = new Schema<IntegrityEventRecord>(
  {
    sessionId: { type: Schema.Types.ObjectId, ref: 'InterviewSession', required: true },
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    type: { type: String, enum: IntegrityEventType.options, required: true },
    at: { type: Date, required: true },
    clientAt: { type: Date, required: true },
    value: { type: Number, default: null },
  },
  { collection: 'integrityEvents', versionKey: false },
);
integrityEventSchema.index({ sessionId: 1, at: 1 });

export const IntegrityEventModel = model<IntegrityEventRecord>(
  'IntegrityEvent',
  integrityEventSchema,
);

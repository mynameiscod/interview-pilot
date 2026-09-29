import { AuditActorType } from '@cbi/shared-types';
import mongoose, { Schema, type InferSchemaType, type Model } from 'mongoose';

/** Default audit log retention: two years (AUDIT_LOG_RETENTION_DAYS). */
export const AUDIT_LOG_RETENTION_DAYS_DEFAULT = 730;
/** Key of the audit log's time index, which carries the retention TTL. */
export const AUDIT_LOG_TTL_KEY = { at: -1 } as const;

/**
 * Security and admin audit trail. Append-only: update and delete operations
 * are rejected at the model layer. The only deletion is MongoDB's TTL
 * monitor removing entries older than the retention period. Never store
 * secrets, OTPs or tokens in `details`; callers pass already-redacted data.
 */
const auditLogSchema = new Schema(
  {
    at: { type: Date, required: true, default: () => new Date() },
    actorType: { type: String, enum: AuditActorType.options, required: true },
    actorId: { type: Schema.Types.ObjectId, ref: 'User' },
    action: { type: String, required: true },
    resourceType: { type: String },
    resourceId: { type: String },
    outcome: { type: String, enum: ['SUCCESS', 'FAILURE'], required: true },
    requestId: { type: String },
    ipHash: { type: String },
    details: { type: Schema.Types.Mixed },
  },
  { collection: 'auditLogs', versionKey: false },
);

// The `{ at: -1 }` index is also the retention TTL. It is not declared here:
// ensureIndexes creates it with the configured expiry (see ensureAuditLogRetention).
auditLogSchema.index({ actorId: 1, at: -1 });
auditLogSchema.index({ resourceType: 1, resourceId: 1, at: -1 });
auditLogSchema.index({ action: 1, at: -1 });

const IMMUTABLE_OPS = [
  'updateOne',
  'updateMany',
  'findOneAndUpdate',
  'replaceOne',
  'findOneAndReplace',
  'deleteOne',
  'deleteMany',
  'findOneAndDelete',
] as const;
for (const op of IMMUTABLE_OPS) {
  auditLogSchema.pre(op, function () {
    throw new Error('auditLogs is append-only');
  });
}

export type AuditLogRecord = InferSchemaType<typeof auditLogSchema>;
export const AuditLogModel: Model<AuditLogRecord> =
  (mongoose.models.AuditLog as Model<AuditLogRecord> | undefined) ??
  mongoose.model<AuditLogRecord>('AuditLog', auditLogSchema);

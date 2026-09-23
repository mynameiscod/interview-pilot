import { SessionAudience } from '@cbi/shared-types';
import mongoose, { Schema, type InferSchemaType, type Model } from 'mongoose';

/**
 * One row per issued refresh token. Rotation marks the presented token
 * `usedAt` and issues a child in the same family. Presenting a used token
 * again is treated as theft and revokes the whole family.
 */
const refreshTokenSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    familyId: { type: String, required: true },
    tokenHash: { type: String, required: true },
    audience: { type: String, enum: SessionAudience.options, required: true },
    parentId: { type: Schema.Types.ObjectId },
    usedAt: { type: Date },
    revokedAt: { type: Date },
    revokedReason: {
      type: String,
      enum: ['LOGOUT', 'LOGOUT_ALL', 'REUSE_DETECTED', 'SUSPENDED', 'ROLE_CHANGE'],
    },
    expiresAt: { type: Date, required: true },
    userAgent: { type: String, maxlength: 200 },
    ipHash: { type: String },
  },
  { timestamps: true, collection: 'refreshTokens' },
);

refreshTokenSchema.index({ tokenHash: 1 }, { unique: true });
refreshTokenSchema.index({ familyId: 1 });
refreshTokenSchema.index({ userId: 1, revokedAt: 1 });
// Expired tokens are removed by MongoDB's TTL monitor.
refreshTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export type RefreshTokenRecord = InferSchemaType<typeof refreshTokenSchema>;
export const RefreshTokenModel: Model<RefreshTokenRecord> =
  (mongoose.models.RefreshToken as Model<RefreshTokenRecord> | undefined) ??
  mongoose.model<RefreshTokenRecord>('RefreshToken', refreshTokenSchema);

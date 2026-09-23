import { OtpChannel, SessionAudience } from '@cbi/shared-types';
import mongoose, { Schema, type InferSchemaType, type Model } from 'mongoose';

const otpChallengeSchema = new Schema(
  {
    purpose: { type: String, enum: ['LOGIN', 'LINK'], required: true },
    audience: { type: String, enum: SessionAudience.options, required: true },
    channel: { type: String, enum: OtpChannel.options, required: true },
    /** Normalized email or E.164 number being proven. */
    destination: { type: String, required: true },
    /** For LINK: the signed-in user the identity will be attached to. */
    userId: { type: Schema.Types.ObjectId, ref: 'User' },
    /** HMAC of challengeId:code. The code itself is never stored. */
    codeHash: { type: String },
    /**
     * False when no code was sent (e.g. admin login for a non-admin address);
     * verification then always fails, without revealing why.
     */
    deliverable: { type: Boolean, required: true },
    attempts: { type: Number, default: 0, required: true },
    maxAttempts: { type: Number, required: true },
    expiresAt: { type: Date, required: true },
    consumedAt: { type: Date },
    /** Kept for a day after expiry for abuse investigation, then removed by TTL. */
    purgeAt: { type: Date, required: true },
  },
  { timestamps: true, collection: 'otpChallenges' },
);

otpChallengeSchema.index({ purgeAt: 1 }, { expireAfterSeconds: 0 });

export type OtpChallenge = InferSchemaType<typeof otpChallengeSchema>;
export const OtpChallengeModel: Model<OtpChallenge> =
  (mongoose.models.OtpChallenge as Model<OtpChallenge> | undefined) ??
  mongoose.model<OtpChallenge>('OtpChallenge', otpChallengeSchema);

import { IdentityProvider } from '@cbi/shared-types';
import mongoose, { Schema, type InferSchemaType, type Model } from 'mongoose';

/**
 * A verified way to sign in. `subject` is the normalized email, the E.164
 * number, or the Google account `sub`. One identity belongs to exactly one user.
 */
const authIdentitySchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    provider: { type: String, enum: IdentityProvider.options, required: true },
    subject: { type: String, required: true },
    /** For GOOGLE: the verified email reported at link time (display only). */
    email: { type: String },
    verifiedAt: { type: Date, required: true },
  },
  { timestamps: true, collection: 'authIdentities' },
);

authIdentitySchema.index({ provider: 1, subject: 1 }, { unique: true });
authIdentitySchema.index({ userId: 1 });

export type AuthIdentity = InferSchemaType<typeof authIdentitySchema>;
export const AuthIdentityModel: Model<AuthIdentity> =
  (mongoose.models.AuthIdentity as Model<AuthIdentity> | undefined) ??
  mongoose.model<AuthIdentity>('AuthIdentity', authIdentitySchema);

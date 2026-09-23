import { AdminRole, UserStatus } from '@cbi/shared-types';
import mongoose, { Schema, type InferSchemaType, type Model } from 'mongoose';

const userSchema = new Schema(
  {
    /** Normalized (lower-case). Unique across users when present. */
    primaryEmail: { type: String },
    emailVerifiedAt: { type: Date },
    /** E.164. Unique across users when present. */
    primaryMobile: { type: String },
    mobileVerifiedAt: { type: Date },
    /** Non-empty only for CodeBegun staff. Candidates have none. */
    adminRoles: { type: [String], enum: AdminRole.options, default: [] },
    status: { type: String, enum: UserStatus.options, default: 'ACTIVE', required: true },
    /** Bumped on logout-all/suspension; access tokens carrying an older value are rejected. */
    tokenVersion: { type: Number, default: 0, required: true },
    lastLoginAt: { type: Date },
    onboardingCompletedAt: { type: Date },
    invitedBy: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true, collection: 'users' },
);

userSchema.index(
  { primaryEmail: 1 },
  { unique: true, partialFilterExpression: { primaryEmail: { $type: 'string' } } },
);
userSchema.index(
  { primaryMobile: 1 },
  { unique: true, partialFilterExpression: { primaryMobile: { $type: 'string' } } },
);
userSchema.index({ adminRoles: 1 });
userSchema.index({ createdAt: -1 });

export type User = InferSchemaType<typeof userSchema>;
export const UserModel: Model<User> =
  (mongoose.models.User as Model<User> | undefined) ?? mongoose.model<User>('User', userSchema);
/** The hydrated document type exactly as UserModel returns it. */
export type UserDocument = ReturnType<(typeof UserModel)['hydrate']>;

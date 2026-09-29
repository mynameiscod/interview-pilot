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
    /**
     * Admins only: scrypt hash for password sign-in (never selected by default).
     * Candidates sign in with OTP or Google and never have one.
     */
    passwordHash: { type: String, select: false },
    passwordSetAt: { type: Date },
    /**
     * Admins only: TOTP second factor. Secrets are AES-256-GCM encrypted with
     * the platform secret box and never selected by default; recovery codes
     * are stored only as keyed hashes (each removed when used).
     */
    mfa: {
      type: new Schema(
        {
          secret: { type: Schema.Types.Mixed, default: null },
          enabledAt: { type: Date, default: null },
          /** Last accepted time step: a code is never accepted twice. */
          lastStep: { type: Number, default: null },
          recoveryCodeHashes: { type: [String], default: [] },
        },
        { _id: false },
      ),
      select: false,
      default: undefined,
    },
    /** Account suspension by an admin (status SUSPENDED). */
    suspension: {
      type: new Schema(
        {
          at: { type: Date, required: true },
          by: { type: Schema.Types.ObjectId, ref: 'User', default: null },
          reason: { type: String, maxlength: 300, required: true },
        },
        { _id: false },
      ),
      default: undefined,
    },
    /** DPDP erasure: requested (status DELETION_PENDING), then completed (status DELETED). */
    deletion: {
      type: new Schema(
        {
          requestedAt: { type: Date, required: true },
          scheduledFor: { type: Date, required: true },
          method: { type: String, enum: ['OTP', 'TYPED'], required: true },
          completedAt: { type: Date, default: null },
        },
        { _id: false },
      ),
      default: undefined,
    },
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
// The erasure sweep finds accounts whose grace period has ended.
userSchema.index(
  { 'deletion.scheduledFor': 1 },
  { partialFilterExpression: { status: 'DELETION_PENDING' } },
);

export type User = InferSchemaType<typeof userSchema>;
export const UserModel: Model<User> =
  (mongoose.models.User as Model<User> | undefined) ?? mongoose.model<User>('User', userSchema);
/** The hydrated document type exactly as UserModel returns it. */
export type UserDocument = ReturnType<(typeof UserModel)['hydrate']>;

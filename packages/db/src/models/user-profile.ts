import { ExperienceLevel, InterviewLanguagePreference } from '@cbi/shared-types';
import mongoose, { Schema, type InferSchemaType, type Model } from 'mongoose';

const userProfileSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    displayName: { type: String, maxlength: 80 },
    preferredInterviewLanguage: {
      type: String,
      enum: InterviewLanguagePreference.options,
      default: 'auto',
      required: true,
    },
    experienceLevel: { type: String, enum: ExperienceLevel.options },
    currentRole: { type: String, maxlength: 80 },
    productUpdatesOptIn: { type: Boolean, default: false, required: true },
  },
  { timestamps: true, collection: 'userProfiles' },
);

userProfileSchema.index({ userId: 1 }, { unique: true });

export type UserProfileRecord = InferSchemaType<typeof userProfileSchema>;
export const UserProfileModel: Model<UserProfileRecord> =
  (mongoose.models.UserProfile as Model<UserProfileRecord> | undefined) ??
  mongoose.model<UserProfileRecord>('UserProfile', userProfileSchema);

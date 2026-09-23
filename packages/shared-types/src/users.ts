import { z } from 'zod';
import { AdminRole } from './permissions.js';

export const UserStatus = z.enum(['ACTIVE', 'SUSPENDED']);
export type UserStatus = z.infer<typeof UserStatus>;

export const ExperienceLevel = z.enum([
  'STUDENT',
  'FRESHER',
  'EARLY_CAREER', // 1–3 years
  'MID_LEVEL', // 3–7 years
  'SENIOR', // 7+ years
]);
export type ExperienceLevel = z.infer<typeof ExperienceLevel>;

/**
 * Interview language preference. `auto` means detect from speech. The list of
 * enabled interview languages becomes admin-managed (Languages module); this
 * seed covers the launch languages.
 */
export const InterviewLanguagePreference = z.enum(['auto', 'en', 'hi', 'te']);
export type InterviewLanguagePreference = z.infer<typeof InterviewLanguagePreference>;

export const IdentityProvider = z.enum(['EMAIL', 'MOBILE', 'GOOGLE']);
export type IdentityProvider = z.infer<typeof IdentityProvider>;

export const LinkedIdentity = z.object({
  provider: IdentityProvider,
  /** Masked for display, e.g. "s***@gmail.com" or "+91 ******3210". */
  display: z.string(),
  verifiedAt: z.iso.datetime(),
});
export type LinkedIdentity = z.infer<typeof LinkedIdentity>;

export const UserProfile = z.object({
  displayName: z.string().nullable(),
  preferredInterviewLanguage: InterviewLanguagePreference,
  experienceLevel: ExperienceLevel.nullable(),
  currentRole: z.string().nullable(),
  productUpdatesOptIn: z.boolean(),
});
export type UserProfile = z.infer<typeof UserProfile>;

export const MeResponse = z.object({
  id: z.string(),
  email: z.email().nullable(),
  mobile: z.string().nullable(),
  status: UserStatus,
  adminRoles: z.array(AdminRole),
  onboardingCompleted: z.boolean(),
  profile: UserProfile,
  identities: z.array(LinkedIdentity),
  createdAt: z.iso.datetime(),
});
export type MeResponse = z.infer<typeof MeResponse>;

const trimmedText = (max: number) => z.string().trim().min(1).max(max);

/** Onboarding and profile edits. Only a name is required. */
export const UpdateProfileBody = z.object({
  displayName: trimmedText(80),
  preferredInterviewLanguage: InterviewLanguagePreference,
  experienceLevel: ExperienceLevel.nullable().optional(),
  currentRole: trimmedText(80).nullable().optional(),
  productUpdatesOptIn: z.boolean().default(false),
});
export type UpdateProfileBody = z.infer<typeof UpdateProfileBody>;

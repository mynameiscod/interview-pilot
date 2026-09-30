import { z } from 'zod';
import { OtpChannel } from './auth.js';

/**
 * Data rights under the DPDP Act 2023: a copy of the candidate's data and
 * account erasure. Deletion locks the account at once and erases it after a
 * grace period; signing in again within that period cancels it.
 */

/** Days between a deletion request and erasure unless configured otherwise. */
export const DEFAULT_DELETION_GRACE_DAYS = 7;

/** The literal a candidate types to confirm deletion (the same in every language). */
export const DELETE_CONFIRMATION_TEXT = 'DELETE' as const;

/** Sends a re-verification code to one of the signed-in candidate's own verified contacts. */
export const ReauthOtpRequestBody = z.object({ channel: OtpChannel });
export type ReauthOtpRequestBody = z.infer<typeof ReauthOtpRequestBody>;

/**
 * Deleting the account needs fresh proof of the person: a code sent to their
 * own email/mobile, or (when no code can be delivered) typing DELETE.
 */
export const DeleteAccountBody = z.discriminatedUnion('method', [
  z.object({
    method: z.literal('OTP'),
    challengeId: z.string().min(1).max(64),
    code: z.string().regex(/^\d{6}$/, 'Enter the 6-digit code'),
  }),
  z.object({
    method: z.literal('TYPED'),
    confirmText: z.literal(DELETE_CONFIRMATION_TEXT),
  }),
]);
export type DeleteAccountBody = z.infer<typeof DeleteAccountBody>;

export const DeleteAccountResponse = z.object({
  /** Erasure runs after this moment unless the person signs in again first. */
  scheduledFor: z.iso.datetime(),
  graceDays: z.number().int().min(0),
});
export type DeleteAccountResponse = z.infer<typeof DeleteAccountResponse>;

const loose = z.record(z.string(), z.unknown());

/**
 * `GET /users/me/export`. Sections are plain records so the bundle stays
 * readable when fields are added; secrets (password hashes, token hashes,
 * OTP hashes, MFA secrets, provider keys) are never included. Recordings are
 * listed with short-lived signed playback links instead of the media itself.
 */
export const DataExportBundle = z.object({
  format: z.literal('careerpilot-interview-export/v1'),
  generatedAt: z.iso.datetime(),
  account: loose,
  profile: loose.nullable(),
  identities: z.array(loose),
  consents: z.array(loose),
  resumes: z.array(loose),
  jobDescriptions: z.array(loose),
  /** Resume tailoring suggestions (kept for 30 days). */
  resumeTailorings: z.array(loose),
  interviews: z.array(loose),
  transcripts: z.array(loose),
  reports: z.array(loose),
  codingAttempts: z.array(loose),
  /** System design notes and diagrams. */
  designAttempts: z.array(loose),
  feedback: z.array(loose),
  recordings: z.array(loose),
  shareLinks: z.array(loose),
  /** Progress hub: goals, plan checklist ticks, badges and readiness certificates. */
  progress: z.object({
    goals: loose.nullable(),
    planItems: z.array(loose),
    badges: z.array(loose),
    certificates: z.array(loose),
  }),
  campaignApplications: z.array(loose),
  purchases: z.array(loose),
  creditLedger: z.array(loose),
  creditBalance: loose.nullable(),
  /** When the recording links above stop working. */
  linksExpireAt: z.iso.datetime(),
});
export type DataExportBundle = z.infer<typeof DataExportBundle>;

// ---- Legal pages (public) ---------------------------------------------------

/**
 * `GET /legal`: operator details and figures the legal pages quote. They
 * come from server configuration so the pages never hard-code a person and
 * always state the retention periods actually in force.
 */
export const LegalInfo = z.object({
  grievanceOfficer: z.object({
    name: z.string().nullable(),
    email: z.string().nullable(),
    address: z.string().nullable(),
  }),
  /** Show the "Draft — pending legal review" banner. */
  draft: z.boolean(),
  lastUpdated: z.string().nullable(),
  recordingRetentionDays: z.number().int(),
  deletionGraceDays: z.number().int(),
});
export type LegalInfo = z.infer<typeof LegalInfo>;

// ---- Signed-in devices (refresh-token families) ----------------------------

export const ActiveSession = z.object({
  /** The refresh-token family id. */
  id: z.string(),
  /** Browser user agent recorded at the last sign-in or refresh (truncated). */
  userAgent: z.string().nullable(),
  signedInAt: z.iso.datetime(),
  lastActiveAt: z.iso.datetime(),
  /** The session can no longer be refreshed after this moment. */
  expiresAt: z.iso.datetime(),
  /** The device making this request. */
  current: z.boolean(),
});
export type ActiveSession = z.infer<typeof ActiveSession>;

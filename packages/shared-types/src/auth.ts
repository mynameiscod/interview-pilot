import { z } from 'zod';
import { UiLocale } from './i18n.js';
import { MeResponse } from './users.js';

/** Which app a session belongs to. Tokens for one audience are rejected by the other. */
export const SessionAudience = z.enum(['candidate', 'admin']);
export type SessionAudience = z.infer<typeof SessionAudience>;

export const OtpChannel = z.enum(['EMAIL', 'MOBILE']);
export type OtpChannel = z.infer<typeof OtpChannel>;

export const OTP_LENGTH = 6;

/** Custom header required on cookie-authenticated endpoints (refresh/logout). */
export const CSRF_HEADER = 'x-cb-csrf' as const;

export const OtpRequestBody = z.object({
  channel: OtpChannel,
  /** Email address or phone number; the server normalizes it. */
  destination: z.string().trim().min(3).max(254),
  /**
   * Language for the code email/SMS (the sender's UI locale). Optional: the
   * server falls back to Accept-Language, then English.
   */
  lang: UiLocale.optional(),
});
export type OtpRequestBody = z.infer<typeof OtpRequestBody>;

export const OtpRequestResponse = z.object({
  challengeId: z.string(),
  /** Masked destination for display. */
  sentTo: z.string(),
  expiresAt: z.iso.datetime(),
  resendAvailableAt: z.iso.datetime(),
});
export type OtpRequestResponse = z.infer<typeof OtpRequestResponse>;

export const OtpVerifyBody = z.object({
  challengeId: z.string().min(1).max(64),
  code: z.string().regex(new RegExp(`^\\d{${OTP_LENGTH}}$`), 'Enter the 6-digit code'),
});
export type OtpVerifyBody = z.infer<typeof OtpVerifyBody>;

/** Admin console: email + password sign-in (candidates use OTP or Google). */
export const PasswordLoginBody = z.object({
  email: z.string().trim().max(254),
  password: z.string().min(1).max(200),
});
export type PasswordLoginBody = z.infer<typeof PasswordLoginBody>;

export const ChangePasswordBody = z.object({
  /** Required when a password is already set. */
  currentPassword: z.string().max(200).optional(),
  newPassword: z.string().min(12, 'Use at least 12 characters.').max(200),
});
export type ChangePasswordBody = z.infer<typeof ChangePasswordBody>;

export const GoogleLoginBody = z.object({
  /** Google Identity Services ID token (JWT credential). */
  idToken: z.string().min(20).max(4096),
});
export type GoogleLoginBody = z.infer<typeof GoogleLoginBody>;

export const SessionResponse = z.object({
  accessToken: z.string(),
  accessTokenExpiresAt: z.iso.datetime(),
  user: MeResponse,
});
export type SessionResponse = z.infer<typeof SessionResponse>;

// ---- Admin two-factor authentication (TOTP, RFC 6238) ----------------------

export const TOTP_DIGITS = 6;
export const RECOVERY_CODE_COUNT = 10;

/** A 6-digit authenticator code. */
export const TotpCode = z
  .string()
  .trim()
  .regex(new RegExp(`^\\d{${TOTP_DIGITS}}$`), 'Enter the 6-digit code');

/**
 * Admin sign-in answered after the first factor (password, email code or
 * Google) when a second factor is needed. `ENROLL`: the admin must set up an
 * authenticator now (2FA is required for their role and not yet enabled).
 */
export const MfaChallenge = z.object({
  mfaRequired: z.literal(true),
  /** Opaque, single-use, short-lived; exchanged at `/admin/auth/mfa/verify`. */
  mfaToken: z.string(),
  mode: z.enum(['VERIFY', 'ENROLL']),
  /** Only for ENROLL: the new secret (base32) and its otpauth:// URI. */
  enrollment: z.object({ secret: z.string(), otpauthUri: z.string() }).nullable(),
  expiresAt: z.iso.datetime(),
});
export type MfaChallenge = z.infer<typeof MfaChallenge>;

/** First-factor admin sign-in: a session, or a second-factor challenge. */
export const AdminSignInResponse = z.union([SessionResponse, MfaChallenge]);
export type AdminSignInResponse = z.infer<typeof AdminSignInResponse>;

export const isMfaChallenge = (r: AdminSignInResponse): r is MfaChallenge =>
  'mfaRequired' in r && r.mfaRequired === true;

/** Second step: an authenticator code, or one of the recovery codes (VERIFY mode only). */
export const MfaVerifyBody = z
  .object({
    mfaToken: z.string().min(20).max(200),
    code: TotpCode.optional(),
    recoveryCode: z.string().trim().min(8).max(40).optional(),
  })
  .refine((b) => Boolean(b.code) !== Boolean(b.recoveryCode), {
    message: 'Enter an authenticator code or a recovery code',
  });
export type MfaVerifyBody = z.infer<typeof MfaVerifyBody>;

/** Session after the second factor; recovery codes are shown once, after enrolment. */
export const MfaSessionResponse = SessionResponse.extend({
  recoveryCodes: z.array(z.string()).nullable(),
});
export type MfaSessionResponse = z.infer<typeof MfaSessionResponse>;

export const MfaStatus = z.object({
  enabled: z.boolean(),
  /** 2FA is mandatory for this admin (by role or platform setting); it cannot be turned off. */
  required: z.boolean(),
  enabledAt: z.iso.datetime().nullable(),
  recoveryCodesRemaining: z.number().int().min(0),
});
export type MfaStatus = z.infer<typeof MfaStatus>;

export const MfaEnrollment = z.object({ secret: z.string(), otpauthUri: z.string() });
export type MfaEnrollment = z.infer<typeof MfaEnrollment>;

export const MfaCodeBody = z.object({ code: TotpCode });
export type MfaCodeBody = z.infer<typeof MfaCodeBody>;

export const MfaRecoveryCodes = z.object({ recoveryCodes: z.array(z.string()) });
export type MfaRecoveryCodes = z.infer<typeof MfaRecoveryCodes>;

export const AuthProvidersResponse = z.object({
  google: z.object({ enabled: z.boolean() }),
  email: z.object({ enabled: z.boolean() }),
  mobile: z.object({ enabled: z.boolean() }),
});
export type AuthProvidersResponse = z.infer<typeof AuthProvidersResponse>;

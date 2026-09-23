import { z } from 'zod';
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

export const AuthProvidersResponse = z.object({
  google: z.object({ enabled: z.boolean() }),
  email: z.object({ enabled: z.boolean() }),
  mobile: z.object({ enabled: z.boolean() }),
});
export type AuthProvidersResponse = z.infer<typeof AuthProvidersResponse>;

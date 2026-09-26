import { z } from 'zod';

/**
 * Stable machine-readable error codes. Clients branch on `code`, never on `message`.
 * Add new codes here; never repurpose an existing one.
 */
export const ErrorCode = z.enum([
  'BAD_REQUEST',
  'VALIDATION_FAILED',
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'NOT_FOUND',
  'CONFLICT',
  'PAYLOAD_TOO_LARGE',
  'RATE_LIMITED',
  'ORIGIN_NOT_ALLOWED',
  'SERVICE_UNAVAILABLE',
  'INTERNAL_ERROR',
  // Authentication (Phase 1)
  'CSRF_REJECTED',
  'OTP_INVALID',
  'OTP_EXPIRED',
  'OTP_TOO_MANY_ATTEMPTS',
  'OTP_COOLDOWN',
  'IDENTITY_IN_USE',
  'ACCOUNT_SUSPENDED',
  'FEATURE_DISABLED',
  'PROVIDER_UNAVAILABLE',
  // AI provider layer (Phase 2)
  /** Every model in the feature's route failed, was unhealthy or is unconfigured. */
  'AI_UNAVAILABLE',
  // Inputs and interviews (Phase 3)
  /** The uploaded file is not a PDF, DOCX or plain-text document. */
  'UNSUPPORTED_MEDIA_TYPE',
  /** The action is not allowed in the resource's current state. */
  'INVALID_STATE',
  // Live interviews and credits (Phase 4)
  /** Starting an interview needs an available credit. */
  'INSUFFICIENT_CREDITS',
  // Payments (Phase 6)
  /** The payment could not be verified (bad signature, amount or order mismatch). */
  'PAYMENT_VERIFICATION_FAILED',
  // Voice (Phase 7)
  /** Every speech model for the feature failed; the room offers text instead. */
  'SPEECH_UNAVAILABLE',
  // Coding (Phase 9)
  /** The code judge could not run the code right now (submitting still works). */
  'JUDGE_UNAVAILABLE',
  // Campaigns (Phase 10)
  /** The campaign is not open (not started, ended, paused, closed or full). */
  'CAMPAIGN_CLOSED',
  // Operations (Phase 11)
  /** Maintenance mode: new interviews cannot start right now. */
  'MAINTENANCE',
  // Admin-managed integrations
  /** A provider (email, payments, storage, SMS, judge) is not configured yet. */
  'NOT_CONFIGURED',
  // Admin password sign-in
  /** Email or password is incorrect (the same answer for unknown accounts). */
  'INVALID_CREDENTIALS',
  /** Too many wrong passwords: password sign-in is paused for a while. */
  'ACCOUNT_LOCKED',
]);
export type ErrorCode = z.infer<typeof ErrorCode>;

export const ApiErrorBody = z.object({
  error: z.object({
    code: ErrorCode,
    message: z.string(),
    details: z.unknown().optional(),
    requestId: z.string().optional(),
  }),
});
export type ApiErrorBody = z.infer<typeof ApiErrorBody>;

/** Success envelope: `{ data, meta? }`. */
export const apiSuccess = <T extends z.ZodType>(data: T) =>
  z.object({
    data,
    meta: z.record(z.string(), z.unknown()).optional(),
  });

export type ApiSuccess<T> = { data: T; meta?: Record<string, unknown> };

export const API_V1_PREFIX = '/api/v1' as const;

/** Header carrying the request correlation id, echoed on every response. */
export const REQUEST_ID_HEADER = 'x-request-id' as const;

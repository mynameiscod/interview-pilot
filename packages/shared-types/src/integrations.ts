import { z } from 'zod';

/**
 * Admin-managed integrations: credentials for email, payments, storage, SMS
 * and the code judge are set in the admin site (System → Integrations)
 * instead of the server's environment file. Secrets are encrypted at rest
 * with the AI secrets master key and never returned (only their last 4
 * characters). When an integration has no admin configuration, the
 * environment file's settings apply.
 */

export const IntegrationKind = z.enum(['email', 'payments', 'storage', 'sms', 'judge']);
export type IntegrationKind = z.infer<typeof IntegrationKind>;

const hostname = z
  .string()
  .trim()
  .regex(/^[a-z0-9.-]+\.[a-z]{2,}$/i, 'Enter a host name such as storage.bunnycdn.com');
const httpUrl = z
  .string()
  .trim()
  .regex(/^https?:\/\/[^\s]+$/i, 'Enter an http(s) URL');

/** Per kind: the providers an admin can choose, their plain settings and their secret fields. */
export const IntegrationSpecs = {
  email: {
    providers: ['ses', 'smtp', 'disabled'],
    settings: z.object({
      /** From address, e.g. `CareerPilot Interview <no-reply@codebegun.com>` (required for SES/SMTP). */
      from: z.string().trim().max(200).optional(),
      sesRegion: z.string().trim().max(40).optional(),
      smtpHost: z.string().trim().max(200).optional(),
      smtpPort: z.number().int().min(1).max(65535).optional(),
      smtpSecure: z.boolean().optional(),
      smtpUser: z.string().trim().max(200).optional(),
    }),
    secrets: ['sesAccessKeyId', 'sesSecretAccessKey', 'smtpPass'],
  },
  payments: {
    providers: ['razorpay', 'disabled'],
    settings: z.object({
      /** Public key id (the browser opens Checkout with it). */
      keyId: z.string().trim().max(100).optional(),
    }),
    secrets: ['keySecret', 'webhookSecret'],
  },
  storage: {
    providers: ['bunny', 'disabled'],
    settings: z.object({
      zone: z.string().trim().max(100).optional(),
      regionHost: hostname.optional(),
    }),
    secrets: ['accessKey'],
  },
  sms: {
    providers: ['msg91', 'disabled'],
    settings: z.object({
      templateId: z.string().trim().max(100).optional(),
      otpVariable: z.string().trim().max(40).optional(),
    }),
    secrets: ['authKey'],
  },
  judge: {
    providers: ['codebegun', 'judge0', 'disabled'],
    settings: z.object({ baseUrl: httpUrl.optional() }),
    secrets: ['hmacSecret', 'judge0AuthToken'],
  },
} as const;

export type IntegrationProvider<K extends IntegrationKind> =
  (typeof IntegrationSpecs)[K]['providers'][number];

/** Where the running configuration comes from. */
export const IntegrationSource = z.enum(['admin', 'env', 'none']);
export type IntegrationSource = z.infer<typeof IntegrationSource>;

export const IntegrationSecretState = z.object({ set: z.boolean(), last4: z.string().nullable() });

export const IntegrationSummary = z.object({
  kind: IntegrationKind,
  /** `admin` when configured here; `env` when the server's environment file applies; `none` otherwise. */
  source: IntegrationSource,
  /** The provider in effect (e.g. `ses`, `razorpay`, `disabled`). */
  provider: z.string(),
  /** Whether the integration can be used now (provider chosen and every required value present). */
  ready: z.boolean(),
  /** What is missing when not ready. */
  missing: z.array(z.string()),
  settings: z.record(z.string(), z.unknown()),
  secrets: z.record(z.string(), IntegrationSecretState),
  providers: z.array(z.string()),
  updatedAt: z.iso.datetime().nullable(),
  updatedBy: z.string().nullable(),
  lastTest: z.object({ ok: z.boolean(), message: z.string(), at: z.iso.datetime() }).nullable(),
});
export type IntegrationSummary = z.infer<typeof IntegrationSummary>;

export const UpdateIntegrationBody = z.object({
  provider: z.string().min(1).max(40),
  settings: z.record(z.string(), z.unknown()).default({}),
  /**
   * New secret values. A field left out (or empty) keeps its current value;
   * `null` clears it.
   */
  secrets: z.record(z.string(), z.string().max(4000).nullable()).default({}),
  reason: z.string().trim().min(3).max(300),
});
export type UpdateIntegrationBody = z.infer<typeof UpdateIntegrationBody>;

export const TestIntegrationBody = z.object({
  /** Email only: where to send the test message. */
  to: z.email().optional(),
});
export type TestIntegrationBody = z.infer<typeof TestIntegrationBody>;

export const IntegrationTestResult = z.object({ ok: z.boolean(), message: z.string() });
export type IntegrationTestResult = z.infer<typeof IntegrationTestResult>;

/** Required plain settings and secrets per provider (`ready` is false until all are set). */
export const INTEGRATION_REQUIREMENTS: Record<
  IntegrationKind,
  Record<string, { settings: string[]; secrets: string[] }>
> = {
  email: {
    ses: { settings: ['from', 'sesRegion'], secrets: ['sesAccessKeyId', 'sesSecretAccessKey'] },
    smtp: { settings: ['from', 'smtpHost'], secrets: [] },
    disabled: { settings: [], secrets: [] },
  },
  payments: {
    razorpay: { settings: ['keyId'], secrets: ['keySecret', 'webhookSecret'] },
    disabled: { settings: [], secrets: [] },
  },
  storage: {
    bunny: { settings: ['zone'], secrets: ['accessKey'] },
    disabled: { settings: [], secrets: [] },
  },
  sms: {
    msg91: { settings: ['templateId'], secrets: ['authKey'] },
    disabled: { settings: [], secrets: [] },
  },
  judge: {
    codebegun: { settings: ['baseUrl'], secrets: ['hmacSecret'] },
    judge0: { settings: ['baseUrl'], secrets: ['hmacSecret'] },
    disabled: { settings: [], secrets: [] },
  },
};

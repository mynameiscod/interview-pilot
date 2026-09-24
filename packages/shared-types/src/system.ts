import { z } from 'zod';
import { KpiTargets } from './analytics.js';

/**
 * Operations (Phase 11): feature flags, system settings, health and the
 * queue view.
 */

// ---- Feature flags ------------------------------------------------------------------------------

export const FlagKey = z.string().regex(/^[a-z][a-zA-Z0-9]*(\.[a-z][a-zA-Z0-9]*)+$/);

/** Flags the code knows about; seeded (off) at start. */
export const KNOWN_FLAGS = {
  /** Candidates can share a public proof of a report (Candidate Proof). */
  'reports.publicProof': 'Candidates can share a read-only proof of their report by link',
} as const;
export type KnownFlag = keyof typeof KNOWN_FLAGS;

export const FeatureFlag = z.object({
  key: FlagKey,
  description: z.string(),
  enabled: z.boolean(),
  /** 0–100: share of signed-in users it is on for (stable per user). 100 = everyone. */
  rolloutPercent: z.number().int().min(0).max(100),
  /** Sent to the web apps (`GET /flags`). */
  clientVisible: z.boolean(),
  updatedAt: z.iso.datetime(),
  updatedBy: z.string().nullable(),
});
export type FeatureFlag = z.infer<typeof FeatureFlag>;

export const UpdateFlagBody = z.object({
  enabled: z.boolean(),
  rolloutPercent: z.number().int().min(0).max(100),
  reason: z.string().trim().min(3).max(300),
});
export type UpdateFlagBody = z.infer<typeof UpdateFlagBody>;

/** Client-visible flags, evaluated for the caller. */
export const ClientFlags = z.record(z.string(), z.boolean());
export type ClientFlags = z.infer<typeof ClientFlags>;

// ---- System settings ----------------------------------------------------------------------------

export const MaintenanceSetting = z.object({
  /** New interviews cannot be started or joined; running ones continue. */
  enabled: z.boolean(),
  message: z.string().trim().max(300),
});
export type MaintenanceSetting = z.infer<typeof MaintenanceSetting>;

export const FinanceSetting = z.object({
  /** INR per USD, for AI costs priced in USD. */
  usdToInr: z.number().positive().max(1000),
  /** Payment gateway fee as a share of revenue (0–0.2). */
  gatewayFeeRate: z.number().min(0).max(0.2),
});
export type FinanceSetting = z.infer<typeof FinanceSetting>;

/** Every setting, its schema and default. */
export const SystemSettings = z.object({
  maintenance: MaintenanceSetting,
  finance: FinanceSetting,
  targets: KpiTargets,
});
export type SystemSettings = z.infer<typeof SystemSettings>;
export type SettingKey = keyof SystemSettings;
export const SettingKey = z.enum(['maintenance', 'finance', 'targets']);

export const DEFAULT_SETTINGS: SystemSettings = {
  maintenance: { enabled: false, message: '' },
  finance: { usdToInr: 84, gatewayFeeRate: 0.02 },
  // Placeholders until the business sets them (the brief's targets were not received).
  targets: { completionRate: 0.7, freeToPaidRate: 0.05, grossMargin: 0.6, maxFailureRate: 0.03 },
};

export const UpdateSettingBody = z.object({
  value: z.unknown(),
  reason: z.string().trim().min(3).max(300),
});
export type UpdateSettingBody = z.infer<typeof UpdateSettingBody>;

export const SettingEntry = z.object({
  key: SettingKey,
  value: z.unknown(),
  updatedAt: z.iso.datetime().nullable(),
  updatedBy: z.string().nullable(),
});
export type SettingEntry = z.infer<typeof SettingEntry>;

/** Public, unauthenticated: the maintenance banner. */
export const PublicSystemStatus = z.object({ maintenance: MaintenanceSetting });
export type PublicSystemStatus = z.infer<typeof PublicSystemStatus>;

// ---- Health and queues --------------------------------------------------------------------------

export const QueueCounts = z.object({
  name: z.string(),
  waiting: z.number().int(),
  active: z.number().int(),
  delayed: z.number().int(),
  failed: z.number().int(),
  completed: z.number().int(),
  paused: z.boolean(),
});
export type QueueCounts = z.infer<typeof QueueCounts>;

export const SystemHealth = z.object({
  version: z.string(),
  env: z.string(),
  dependencies: z.array(
    z.object({ name: z.string(), ok: z.boolean(), latencyMs: z.number().nullable() }),
  ),
  workers: z.array(
    z.object({
      workerId: z.string(),
      at: z.iso.datetime(),
      version: z.string().nullable(),
      queues: z.array(z.string()),
      /** Seconds since the last heartbeat. */
      ageSec: z.number().int(),
    }),
  ),
  queues: z.array(QueueCounts),
  sessions: z.object({
    live: z.number().int(),
    processing: z.number().int(),
    /** PROCESSING for more than 30 minutes. */
    stuck: z.number().int(),
  }),
  maintenance: MaintenanceSetting,
});
export type SystemHealth = z.infer<typeof SystemHealth>;

export const FailedJob = z.object({
  id: z.string(),
  name: z.string(),
  /** First 500 characters of the error. */
  failedReason: z.string(),
  attemptsMade: z.number().int(),
  failedAt: z.iso.datetime().nullable(),
  /** The job's ids (payloads carry ids only). */
  data: z.record(z.string(), z.unknown()),
});
export type FailedJob = z.infer<typeof FailedJob>;

export const FailedJobsQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

export const RetryJobBody = z.object({ reason: z.string().trim().min(3).max(300) });
export type RetryJobBody = z.infer<typeof RetryJobBody>;

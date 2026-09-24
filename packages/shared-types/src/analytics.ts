import { z } from 'zod';

/**
 * Product analytics (Phase 11). Clients send a small allow-list of events —
 * never personal data — tied to a random `anonId` (and the user when signed
 * in). Everything else on the dashboard is computed from the source
 * collections (users, interviews, purchases, AI usage) into daily rollups.
 * Analytics are separate from the audit log, with their own retention.
 */

/** Events a client may send. Names outside this list are rejected. */
export const ClientEventName = z.enum([
  'page_view',
  'landing_cta_clicked',
  'signup_started',
  'wizard_started',
  'resume_uploaded',
  'jd_added',
  'analysis_viewed',
  'setup_completed',
  'device_check_completed',
  'interview_room_joined',
  'report_viewed',
  'report_pdf_downloaded',
  'compare_viewed',
  'pricing_viewed',
  'checkout_started',
  'campaign_landing_viewed',
  'proof_shared',
]);
export type ClientEventName = z.infer<typeof ClientEventName>;

/** Random per-browser id (not linked to the person until they sign in). */
export const AnonId = z.string().regex(/^[A-Za-z0-9_-]{8,64}$/);

const propKey = z.string().regex(/^[a-z][a-zA-Z0-9_]{0,39}$/);
const propValue = z.union([z.string().max(120), z.number().finite(), z.boolean(), z.null()]);

export const ClientEvent = z.object({
  name: ClientEventName,
  /** When it happened on the client; the server clamps it to the last 24 hours. */
  at: z.iso.datetime().optional(),
  /** Route pattern, not the full URL (no ids or tokens): e.g. `/app/interviews/:id/setup`. */
  path: z
    .string()
    .max(200)
    .regex(/^\/[A-Za-z0-9/:_-]*$/)
    .optional(),
  props: z
    .record(propKey, propValue)
    .refine((p) => Object.keys(p).length <= 10, 'At most 10 properties')
    .optional(),
});
export type ClientEvent = z.infer<typeof ClientEvent>;

export const TrackEventsBody = z.object({
  anonId: AnonId,
  events: z.array(ClientEvent).min(1).max(25),
});
export type TrackEventsBody = z.infer<typeof TrackEventsBody>;

export const TrackEventsResult = z.object({ accepted: z.number().int() });
export type TrackEventsResult = z.infer<typeof TrackEventsResult>;

// ---- Rollups and the dashboard ----------------------------------------------------------------

/** Daily metrics (days are calendar days in India time, `YYYY-MM-DD`). */
export const DailyMetric = z.enum([
  'registrations',
  'onboarded',
  'active_users',
  'interviews_created',
  'interviews_started',
  'interviews_completed',
  'interviews_failed',
  'reports_ready',
  'purchases_paid',
  'revenue_minor',
  'refunds_minor',
  'first_purchases',
  'ai_calls',
  /** In USD micros; the dashboard converts with the configured rate. `feature` dimension too. */
  'ai_cost_usd_micros',
  'ai_cost_inr_micros',
]);
export type DailyMetric = z.infer<typeof DailyMetric>;

export const IsoDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const DateRangeQuery = z
  .object({ from: IsoDay.optional(), to: IsoDay.optional() })
  .refine((q) => !q.from || !q.to || q.from <= q.to, { message: '`from` must not be after `to`' });
export type DateRangeQuery = z.infer<typeof DateRangeQuery>;

export const KpiTargets = z.object({
  /** Completed ÷ started (0–1). */
  completionRate: z.number().min(0).max(1),
  /** New users in the range who paid ÷ new users (0–1). */
  freeToPaidRate: z.number().min(0).max(1),
  /** (Net revenue − AI cost − gateway fees) ÷ net revenue (0–1). */
  grossMargin: z.number().min(0).max(1),
  /** Share of started interviews that fail technically (0–1; lower is better). */
  maxFailureRate: z.number().min(0).max(1),
});
export type KpiTargets = z.infer<typeof KpiTargets>;

export const Dashboard = z.object({
  range: z.object({ from: IsoDay, to: IsoDay, days: z.number().int() }),
  kpis: z.object({
    registrations: z.number().int(),
    activeUsers: z.number().int(),
    interviewsStarted: z.number().int(),
    interviewsCompleted: z.number().int(),
    interviewsFailed: z.number().int(),
    completionRate: z.number().nullable(),
    failureRate: z.number().nullable(),
    freeToPaidRate: z.number().nullable(),
    revenueMinor: z.number().int(),
    refundsMinor: z.number().int(),
    /** AI cost converted to INR paise (USD at the configured rate). */
    aiCostMinor: z.number().int(),
    gatewayFeesMinor: z.number().int(),
    grossMargin: z.number().nullable(),
    /** Right now, not for the range. */
    activeSessions: z.number().int(),
  }),
  targets: KpiTargets,
  series: z.array(
    z.object({
      day: IsoDay,
      registrations: z.number().int(),
      interviewsStarted: z.number().int(),
      interviewsCompleted: z.number().int(),
      revenueMinor: z.number().int(),
      aiCostMinor: z.number().int(),
    }),
  ),
  funnel: z.array(z.object({ step: z.string(), users: z.number().int() })),
  providerHealth: z.array(
    z.object({
      provider: z.string(),
      model: z.string(),
      status: z.string(),
      errorRate: z.number().nullable(),
      p95LatencyMs: z.number().nullable(),
      windowStart: z.iso.datetime(),
    }),
  ),
  usdToInr: z.number(),
  /** When the newest rollup in the range was computed (null if none yet). */
  computedAt: z.iso.datetime().nullable(),
});
export type Dashboard = z.infer<typeof Dashboard>;

export const CostGroupBy = z.enum(['feature', 'provider', 'model', 'day']);
export type CostGroupBy = z.infer<typeof CostGroupBy>;

export const CostQuery = z
  .object({
    from: IsoDay.optional(),
    to: IsoDay.optional(),
    groupBy: CostGroupBy.default('feature'),
  })
  .refine((q) => !q.from || !q.to || q.from <= q.to, { message: '`from` must not be after `to`' });
export type CostQuery = z.infer<typeof CostQuery>;

export const CostReport = z.object({
  range: z.object({ from: IsoDay, to: IsoDay }),
  groupBy: CostGroupBy,
  rows: z.array(
    z.object({
      key: z.string(),
      calls: z.number().int(),
      failures: z.number().int(),
      costMinor: z.number().int(),
    }),
  ),
  totals: z.object({
    calls: z.number().int(),
    aiCostMinor: z.number().int(),
    revenueMinor: z.number().int(),
    refundsMinor: z.number().int(),
    gatewayFeesMinor: z.number().int(),
    marginMinor: z.number().int(),
    grossMargin: z.number().nullable(),
    completedInterviews: z.number().int(),
    /** AI cost per completed interview (null with none completed). */
    aiCostPerInterviewMinor: z.number().int().nullable(),
  }),
  margin: z.array(
    z.object({
      day: IsoDay,
      revenueMinor: z.number().int(),
      aiCostMinor: z.number().int(),
      marginMinor: z.number().int(),
    }),
  ),
  usdToInr: z.number(),
});
export type CostReport = z.infer<typeof CostReport>;

export const RollupBody = z
  .object({ from: IsoDay, to: IsoDay, reason: z.string().trim().min(3).max(300) })
  .refine((b) => b.from <= b.to, { message: '`from` must not be after `to`' });
export type RollupBody = z.infer<typeof RollupBody>;

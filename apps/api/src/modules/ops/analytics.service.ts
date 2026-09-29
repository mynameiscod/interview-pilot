import {
  AiUsageModel,
  AnalyticsDailyModel,
  AnalyticsEventModel,
  daysBetween,
  InterviewSessionModel,
  istDay,
  istDayBounds,
  mongoose,
  ProviderHealthModel,
  PurchaseModel,
  rollupDays,
  UserModel,
} from '@cbi/db';
import type { Logger } from '@cbi/config';
import type {
  CostQuery,
  CostReport,
  Dashboard,
  DateRangeQuery,
  RollupBody,
  TrackEventsBody,
} from '@cbi/shared-types';
import type { AuditService } from '../../lib/audit.js';
import { AppError } from '../../lib/errors.js';
import type { ClientContext } from '../../lib/request-context.js';
import type { SettingsService } from './ops.service.js';

const DAY_MS = 24 * 3600 * 1000;
/** Longest range the dashboard, costs and backfill accept. */
export const MAX_RANGE_DAYS = 366;
/** Client timestamps are trusted only within this window before receipt. */
const CLOCK_WINDOW_MS = DAY_MS;

/** Micros of a currency unit → INR paise. */
export const toPaise = (usdMicros: number, inrMicros: number, usdToInr: number) =>
  Math.round((usdMicros * usdToInr + inrMicros) / 10_000);

function range(q: { from?: string; to?: string }, now: Date, defaultDays = 30) {
  const to = q.to ?? istDay(now);
  const from =
    q.from ??
    new Date(Date.parse(`${to}T00:00:00Z`) - (defaultDays - 1) * DAY_MS).toISOString().slice(0, 10);
  const days = daysBetween(from, to);
  if (days.length > MAX_RANGE_DAYS) {
    throw AppError.validation(`Choose at most ${MAX_RANGE_DAYS} days.`);
  }
  return { from, to, days, start: istDayBounds(from).start, end: istDayBounds(to).end };
}

type Totals = Record<string, number>;

async function dailyTotals(from: string, to: string) {
  const rows = await AnalyticsDailyModel.find({
    day: { $gte: from, $lte: to },
    dimsHash: '',
  }).lean();
  const byDay = new Map<string, Totals>();
  const sum: Totals = {};
  let computedAt: Date | null = null;
  for (const r of rows) {
    const d = byDay.get(r.day) ?? {};
    d[r.metric] = (d[r.metric] ?? 0) + r.value;
    byDay.set(r.day, d);
    sum[r.metric] = (sum[r.metric] ?? 0) + r.value;
    if (!computedAt || r.computedAt > computedAt) computedAt = r.computedAt;
  }
  return { byDay, sum, computedAt };
}

/** Funnel steps after `registered` and `onboarded`, each a lookup into the cohort's records. */
const FUNNEL_LOOKUPS = [
  // Practice drills are not interviews.
  {
    step: 'created_interview',
    from: () => InterviewSessionModel,
    match: { kind: { $ne: 'DRILL' } },
  },
  {
    step: 'started_interview',
    from: () => InterviewSessionModel,
    match: { kind: { $ne: 'DRILL' }, startedAt: { $ne: null } },
  },
  {
    step: 'completed_interview',
    from: () => InterviewSessionModel,
    match: { kind: { $ne: 'DRILL' }, state: { $in: ['PROCESSING', 'REPORT_READY'] } },
  },
  { step: 'viewed_report', from: () => AnalyticsEventModel, match: { name: 'report_viewed' } },
  { step: 'paid', from: () => PurchaseModel, match: { 'statusHistory.status': 'PAID' } },
] as const;

export type FunnelStep = 'registered' | 'onboarded' | (typeof FUNNEL_LOOKUPS)[number]['step'];
export const FUNNEL_STEPS: readonly FunnelStep[] = [
  'registered',
  'onboarded',
  ...FUNNEL_LOOKUPS.map((l) => l.step),
];

/**
 * The funnel over the cohort of candidates who registered in [start, end), as
 * one aggregation on `users`: each later step is a `$lookup` that stops at the
 * first matching record (`$limit: 1`), so no id lists leave the database and
 * each user is counted at most once per step. The `$match` filters are the
 * same query-language filters the steps have always used.
 */
export function funnelPipeline(start: Date, end: Date, collections: Record<string, string>) {
  const flag = (step: string) => `has_${step}`;
  return [
    { $match: { adminRoles: { $size: 0 }, createdAt: { $gte: start, $lt: end } } },
    { $project: { _id: 1, onboardingCompletedAt: 1 } },
    ...FUNNEL_LOOKUPS.map((l) => ({
      $lookup: {
        from: collections[l.step]!,
        localField: '_id',
        foreignField: 'userId',
        pipeline: [{ $match: l.match }, { $limit: 1 }, { $project: { _id: 1 } }],
        as: flag(l.step),
      },
    })),
    {
      $group: {
        _id: null,
        registered: { $sum: 1 },
        // Truthy like the old filter: a date counts, null or missing does not.
        onboarded: { $sum: { $cond: [{ $ifNull: ['$onboardingCompletedAt', false] }, 1, 0] } },
        ...Object.fromEntries(
          FUNNEL_LOOKUPS.map((l) => [l.step, { $sum: { $size: `$${flag(l.step)}` } }]),
        ),
      },
    },
  ];
}

/** Runs the funnel aggregation; an empty cohort gives zeros. */
async function funnelCounts(start: Date, end: Date) {
  const collections = Object.fromEntries(
    FUNNEL_LOOKUPS.map((l) => [l.step, l.from().collection.collectionName]),
  );
  const [row] = await UserModel.aggregate<Record<FunnelStep, number>>(
    funnelPipeline(start, end, collections),
  );
  return FUNNEL_STEPS.map((step) => ({ step, users: row?.[step] ?? 0 }));
}

/**
 * Distinct users with an analytics event or an interview created or started in
 * [start, end), counted inside MongoDB (`$unionWith` + `$group`).
 */
export function activeUsersPipeline(start: Date, end: Date, sessionsCollection: string) {
  const within = { $gte: start, $lt: end };
  return [
    { $match: { at: within, userId: { $ne: null } } },
    { $project: { _id: 0, userId: 1 } },
    {
      $unionWith: {
        coll: sessionsCollection,
        pipeline: [
          { $match: { $or: [{ createdAt: within }, { startedAt: within }] } },
          { $project: { _id: 0, userId: 1 } },
        ],
      },
    },
    { $group: { _id: '$userId' } },
    { $count: 'users' },
  ];
}

async function activeUserCount(start: Date, end: Date) {
  const [row] = await AnalyticsEventModel.aggregate<{ users: number }>(
    activeUsersPipeline(start, end, InterviewSessionModel.collection.collectionName),
  );
  return row?.users ?? 0;
}

const ratio = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 10_000) / 10_000 : null);

export function createAnalyticsService(deps: {
  audit: AuditService;
  settings: SettingsService;
  logger?: Logger;
  now?: () => Date;
}) {
  const now = deps.now ?? (() => new Date());

  async function money(sum: Totals) {
    const finance = await deps.settings.get('finance');
    const revenueMinor = sum.revenue_minor ?? 0;
    const refundsMinor = sum.refunds_minor ?? 0;
    const aiCostMinor = toPaise(
      sum.ai_cost_usd_micros ?? 0,
      sum.ai_cost_inr_micros ?? 0,
      finance.usdToInr,
    );
    const gatewayFeesMinor = Math.round(revenueMinor * finance.gatewayFeeRate);
    const net = revenueMinor - refundsMinor;
    const marginMinor = net - aiCostMinor - gatewayFeesMinor;
    return {
      finance,
      revenueMinor,
      refundsMinor,
      aiCostMinor,
      gatewayFeesMinor,
      marginMinor,
      grossMargin: net > 0 ? Math.round((marginMinor / net) * 10_000) / 10_000 : null,
    };
  }

  return {
    /**
     * Stores allow-listed client events. Personal data is never accepted:
     * names and property shapes are validated by the contract, paths are
     * route patterns, and the IP address is not stored.
     */
    async track(body: TrackEventsBody, userId: string | null) {
      const received = now();
      const docs = body.events.map((e) => {
        const at = e.at ? new Date(e.at) : received;
        const trusted =
          at.getTime() <= received.getTime() + 5 * 60_000 &&
          at.getTime() >= received.getTime() - CLOCK_WINDOW_MS;
        return {
          name: e.name,
          userId: userId ? new mongoose.Types.ObjectId(userId) : null,
          anonId: body.anonId,
          path: e.path ?? null,
          props: e.props ?? {},
          at: trusted ? at : received,
          receivedAt: received,
        };
      });
      await AnalyticsEventModel.insertMany(docs, { ordered: false });
      return { accepted: docs.length };
    },

    /**
     * Server-side `report_viewed`: called when the owner fetches their report.
     * Kept to one event per user and India-time day (the funnel needs only
     * "has viewed"). A failure is logged, never shown to the candidate.
     */
    async recordReportView(userId: string) {
      const at = now();
      const userOid = new mongoose.Types.ObjectId(userId);
      try {
        await AnalyticsEventModel.updateOne(
          { name: 'report_viewed', userId: userOid, at: { $gte: istDayBounds(istDay(at)).start } },
          {
            // name and userId come from the filter's equality fields.
            $setOnInsert: {
              anonId: 'server',
              path: '/app/reports/:id',
              props: {},
              at,
              receivedAt: at,
            },
          },
          { upsert: true },
        );
      } catch (err) {
        deps.logger?.warn({ err }, 'report_viewed event not recorded');
      }
    },

    async dashboard(q: DateRangeQuery): Promise<Dashboard> {
      const r = range(q, now());
      const [{ byDay, sum, computedAt }, targets, activeSessions] = await Promise.all([
        dailyTotals(r.from, r.to),
        deps.settings.get('targets'),
        InterviewSessionModel.countDocuments({ live: true }),
      ]);
      const m = await money(sum);

      // Distinct users over the whole range (daily counts cannot be added up),
      // and the funnel over the cohort of candidates who registered in it.
      const [activeUsers, funnel] = await Promise.all([
        activeUserCount(r.start, r.end),
        funnelCounts(r.start, r.end),
      ]);
      const cohortSize = funnel[0]!.users;
      const paidUsers = funnel.find((f) => f.step === 'paid')!.users;

      const health = await ProviderHealthModel.aggregate<{
        _id: { provider: string; model: string };
        status: string;
        errorRate: number | null;
        p95LatencyMs: number | null;
        windowStart: Date;
      }>([
        { $sort: { windowStart: -1 } },
        {
          $group: {
            _id: { provider: '$provider', model: '$model' },
            status: { $first: '$status' },
            errorRate: { $first: '$errorRate' },
            p95LatencyMs: { $first: '$p95LatencyMs' },
            windowStart: { $first: '$windowStart' },
          },
        },
        { $sort: { '_id.provider': 1, '_id.model': 1 } },
      ]);

      const started_ = sum.interviews_started ?? 0;
      return {
        range: { from: r.from, to: r.to, days: r.days.length },
        kpis: {
          registrations: sum.registrations ?? 0,
          activeUsers,
          interviewsStarted: started_,
          interviewsCompleted: sum.interviews_completed ?? 0,
          interviewsFailed: sum.interviews_failed ?? 0,
          completionRate: ratio(sum.interviews_completed ?? 0, started_),
          failureRate: ratio(sum.interviews_failed ?? 0, started_),
          freeToPaidRate: ratio(paidUsers, cohortSize),
          revenueMinor: m.revenueMinor,
          refundsMinor: m.refundsMinor,
          aiCostMinor: m.aiCostMinor,
          gatewayFeesMinor: m.gatewayFeesMinor,
          grossMargin: m.grossMargin,
          activeSessions,
        },
        targets,
        series: r.days.map((day) => {
          const d = byDay.get(day) ?? {};
          return {
            day,
            registrations: d.registrations ?? 0,
            interviewsStarted: d.interviews_started ?? 0,
            interviewsCompleted: d.interviews_completed ?? 0,
            revenueMinor: d.revenue_minor ?? 0,
            aiCostMinor: toPaise(
              d.ai_cost_usd_micros ?? 0,
              d.ai_cost_inr_micros ?? 0,
              m.finance.usdToInr,
            ),
          };
        }),
        funnel,
        providerHealth: health.map((h) => ({
          provider: h._id.provider,
          model: h._id.model,
          status: h.status,
          errorRate: h.errorRate,
          p95LatencyMs: h.p95LatencyMs,
          windowStart: h.windowStart.toISOString(),
        })),
        usdToInr: m.finance.usdToInr,
        computedAt: computedAt ? (computedAt as Date).toISOString() : null,
      };
    },

    /** AI cost by feature, provider, model or day (live from usage), with revenue and margin. */
    async costs(q: CostQuery): Promise<CostReport> {
      const r = range(q, now());
      const [{ byDay, sum }, finance] = await Promise.all([
        dailyTotals(r.from, r.to),
        deps.settings.get('finance'),
      ]);
      const key =
        q.groupBy === 'day'
          ? {
              $dateToString: {
                format: '%Y-%m-%d',
                date: '$at',
                timezone: 'Asia/Kolkata',
              },
            }
          : `$${q.groupBy}`;
      const groups = await AiUsageModel.aggregate<{
        _id: { key: string; currency: string };
        calls: number;
        failures: number;
        cost: number;
      }>([
        { $match: { at: { $gte: r.start, $lt: r.end } } },
        {
          $group: {
            _id: { key, currency: '$currency' },
            calls: { $sum: 1 },
            failures: { $sum: { $cond: [{ $eq: ['$outcome', 'SUCCESS'] }, 0, 1] } },
            cost: { $sum: '$costMicros' },
          },
        },
      ]);
      const rows = new Map<string, { calls: number; failures: number; usd: number; inr: number }>();
      for (const g of groups) {
        const k = String(g._id.key ?? 'unknown');
        const row = rows.get(k) ?? { calls: 0, failures: 0, usd: 0, inr: 0 };
        row.calls += g.calls;
        row.failures += g.failures;
        if (g._id.currency === 'INR') row.inr += g.cost;
        else row.usd += g.cost;
        rows.set(k, row);
      }
      const m = await money(sum);
      const completed = sum.interviews_completed ?? 0;
      const list = [...rows.entries()]
        .map(([k, v]) => ({
          key: k,
          calls: v.calls,
          failures: v.failures,
          costMinor: toPaise(v.usd, v.inr, finance.usdToInr),
        }))
        .sort((a, b) =>
          q.groupBy === 'day' ? a.key.localeCompare(b.key) : b.costMinor - a.costMinor,
        );
      return {
        range: { from: r.from, to: r.to },
        groupBy: q.groupBy,
        rows: list,
        totals: {
          calls: list.reduce((n, x) => n + x.calls, 0),
          aiCostMinor: m.aiCostMinor,
          revenueMinor: m.revenueMinor,
          refundsMinor: m.refundsMinor,
          gatewayFeesMinor: m.gatewayFeesMinor,
          marginMinor: m.marginMinor,
          grossMargin: m.grossMargin,
          completedInterviews: completed,
          aiCostPerInterviewMinor: completed > 0 ? Math.round(m.aiCostMinor / completed) : null,
        },
        margin: r.days.map((day) => {
          const d = byDay.get(day) ?? {};
          const revenue = (d.revenue_minor ?? 0) - (d.refunds_minor ?? 0);
          const ai = toPaise(
            d.ai_cost_usd_micros ?? 0,
            d.ai_cost_inr_micros ?? 0,
            finance.usdToInr,
          );
          const fees = Math.round((d.revenue_minor ?? 0) * finance.gatewayFeeRate);
          return { day, revenueMinor: revenue, aiCostMinor: ai, marginMinor: revenue - ai - fees };
        }),
        usdToInr: finance.usdToInr,
      };
    },

    /** Recomputes the rollups of a range now (backfill after a fix or an import). */
    async rollup(body: RollupBody, actorId: string, ctx: ClientContext) {
      const r = range(body, now());
      const days = await rollupDays(r.from, r.to, now());
      await deps.audit.record(
        {
          actorType: 'ADMIN',
          actorId,
          action: 'analytics.rollup',
          resourceType: 'analyticsDaily',
          resourceId: `${r.from}..${r.to}`,
          details: { days, reason: body.reason },
        },
        ctx,
      );
      return { days };
    },
  };
}

export type AnalyticsService = ReturnType<typeof createAnalyticsService>;

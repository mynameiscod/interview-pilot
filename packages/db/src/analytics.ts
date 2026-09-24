import { DEFAULT_SETTINGS, KNOWN_FLAGS, SettingKey, type DailyMetric } from '@cbi/shared-types';
import { AiUsageModel } from './models/ai.js';
import { PurchaseModel } from './models/commerce.js';
import { InterviewReportModel } from './models/evaluation.js';
import { InterviewSessionModel } from './models/interview-session.js';
import {
  AnalyticsDailyModel,
  AnalyticsEventModel,
  FeatureFlagModel,
  SystemSettingModel,
} from './models/ops.js';
import { UserModel } from './models/user.js';
import { inTransaction } from './credits.js';

/**
 * Daily rollups (Phase 11). Days are calendar days in India time. Every
 * metric is computed from the source collections, so a day can be
 * recomputed at any time with the same result (the worker refreshes today
 * and yesterday; admins can backfill a range).
 */

const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000;
const DAY_MS = 24 * 3600 * 1000;

/** The India-time calendar day of an instant. */
export function istDay(at: Date): string {
  return new Date(at.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
}

/** [start, end) of an India-time day as UTC instants. */
export function istDayBounds(day: string): { start: Date; end: Date } {
  const start = new Date(Date.parse(`${day}T00:00:00Z`) - IST_OFFSET_MS);
  return { start, end: new Date(start.getTime() + DAY_MS) };
}

/** Every day from `from` to `to`, inclusive. */
export function daysBetween(from: string, to: string): string[] {
  const out: string[] = [];
  for (let t = Date.parse(`${from}T00:00:00Z`); t <= Date.parse(`${to}T00:00:00Z`); t += DAY_MS) {
    out.push(new Date(t).toISOString().slice(0, 10));
  }
  return out;
}

export const dimsHash = (dims: Record<string, string>) =>
  Object.keys(dims)
    .sort()
    .map((k) => `${k}=${dims[k]}`)
    .join('&');

interface Row {
  metric: DailyMetric;
  dims: Record<string, string>;
  value: number;
}

const candidates = { adminRoles: { $size: 0 } };

/** Computes one day's metrics from the source collections. */
export async function computeDay(day: string): Promise<Row[]> {
  const { start, end } = istDayBounds(day);
  const inDay = { $gte: start, $lt: end };
  const total = (metric: DailyMetric, value: number): Row => ({ metric, dims: {}, value });

  const [
    registrations,
    onboarded,
    created,
    started,
    completed,
    failed,
    reports,
    paid,
    refunds,
    firstPurchases,
    ai,
    eventUsers,
    sessionUsers,
  ] = await Promise.all([
    UserModel.countDocuments({ ...candidates, createdAt: inDay }),
    UserModel.countDocuments({ ...candidates, onboardingCompletedAt: inDay }),
    InterviewSessionModel.countDocuments({ createdAt: inDay }),
    InterviewSessionModel.countDocuments({ startedAt: inDay }),
    InterviewSessionModel.countDocuments({
      endedAt: inDay,
      state: { $in: ['PROCESSING', 'REPORT_READY'] },
    }),
    // Started interviews that failed or expired that day (analysis failures are not counted).
    InterviewSessionModel.countDocuments({
      startedAt: { $ne: null },
      stateHistory: { $elemMatch: { to: { $in: ['FAILED', 'EXPIRED'] }, at: inDay } },
    }),
    InterviewReportModel.countDocuments({ revision: 0, generatedAt: inDay }),
    PurchaseModel.aggregate<{ count: number; amount: number }>([
      { $match: { statusHistory: { $elemMatch: { status: 'PAID', at: inDay } } } },
      { $group: { _id: null, count: { $sum: 1 }, amount: { $sum: '$amountMinor' } } },
    ]),
    PurchaseModel.aggregate<{ amount: number }>([
      { $match: { statusHistory: { $elemMatch: { status: 'REFUNDED', at: inDay } } } },
      { $group: { _id: null, amount: { $sum: '$amountMinor' } } },
    ]),
    // Users whose first paid purchase ever falls on this day.
    PurchaseModel.aggregate<{ count: number }>([
      { $match: { 'statusHistory.status': 'PAID' } },
      { $unwind: '$statusHistory' },
      { $match: { 'statusHistory.status': 'PAID' } },
      { $group: { _id: '$userId', first: { $min: '$statusHistory.at' } } },
      { $match: { first: inDay } },
      { $count: 'count' },
    ]),
    AiUsageModel.aggregate<{
      _id: { feature: string; currency: string };
      calls: number;
      cost: number;
    }>([
      { $match: { at: inDay } },
      {
        $group: {
          _id: { feature: '$feature', currency: '$currency' },
          calls: { $sum: 1 },
          cost: { $sum: '$costMicros' },
        },
      },
    ]),
    AnalyticsEventModel.distinct('userId', { at: inDay, userId: { $ne: null } }),
    InterviewSessionModel.distinct('userId', {
      $or: [{ createdAt: inDay }, { startedAt: inDay }],
    }),
  ]);

  const active = new Set([...eventUsers, ...sessionUsers].map(String));
  const rows: Row[] = [
    total('registrations', registrations),
    total('onboarded', onboarded),
    total('active_users', active.size),
    total('interviews_created', created),
    total('interviews_started', started),
    total('interviews_completed', completed),
    total('interviews_failed', failed),
    total('reports_ready', reports),
    total('purchases_paid', paid[0]?.count ?? 0),
    total('revenue_minor', paid[0]?.amount ?? 0),
    total('refunds_minor', refunds[0]?.amount ?? 0),
    total('first_purchases', firstPurchases[0]?.count ?? 0),
  ];
  const calls = new Map<string, number>();
  const cost = { USD: new Map<string, number>(), INR: new Map<string, number>() };
  for (const r of ai) {
    calls.set(r._id.feature, (calls.get(r._id.feature) ?? 0) + r.calls);
    const byCurrency = r._id.currency === 'INR' ? cost.INR : cost.USD;
    byCurrency.set(r._id.feature, (byCurrency.get(r._id.feature) ?? 0) + r.cost);
  }
  const sum = (m: Map<string, number>) => [...m.values()].reduce((a, b) => a + b, 0);
  rows.push(total('ai_calls', sum(calls)));
  rows.push(total('ai_cost_usd_micros', sum(cost.USD)));
  rows.push(total('ai_cost_inr_micros', sum(cost.INR)));
  for (const [feature, n] of calls) rows.push({ metric: 'ai_calls', dims: { feature }, value: n });
  for (const [feature, n] of cost.USD)
    rows.push({ metric: 'ai_cost_usd_micros', dims: { feature }, value: n });
  for (const [feature, n] of cost.INR)
    rows.push({ metric: 'ai_cost_inr_micros', dims: { feature }, value: n });
  return rows;
}

/** Recomputes and replaces the rollups of each day in the range (idempotent). */
export async function rollupDays(from: string, to: string, now = new Date()): Promise<number> {
  const days = daysBetween(from, to);
  for (const day of days) {
    const rows = await computeDay(day);
    await inTransaction(undefined, async (tx) => {
      await AnalyticsDailyModel.deleteMany({ day }, { session: tx });
      await AnalyticsDailyModel.insertMany(
        rows.map((r) => ({ day, ...r, dimsHash: dimsHash(r.dims), computedAt: now })),
        { session: tx },
      );
    });
  }
  return days.length;
}

/** Creates the known feature flags (off) and default settings, leaving existing ones alone. */
export async function ensureOpsDefaults(): Promise<{ flags: number; settings: number }> {
  let flags = 0;
  for (const [key, description] of Object.entries(KNOWN_FLAGS)) {
    const r = await FeatureFlagModel.updateOne(
      { key },
      {
        $setOnInsert: {
          key,
          description,
          enabled: false,
          rolloutPercent: 100,
          clientVisible: true,
          updatedBy: null,
        },
      },
      { upsert: true },
    );
    flags += r.upsertedCount;
  }
  let settings = 0;
  for (const key of SettingKey.options) {
    const value = DEFAULT_SETTINGS[key];
    const r = await SystemSettingModel.updateOne(
      { key },
      { $setOnInsert: { key, value, updatedBy: null } },
      { upsert: true },
    );
    settings += r.upsertedCount;
  }
  return { flags, settings };
}

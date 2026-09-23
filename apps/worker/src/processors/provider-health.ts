import { AiUsageModel, ProviderHealthModel, type mongoose } from '@cbi/db';
import type { AiCallOutcome, AiProviderKey, ProviderHealthStatus } from '@cbi/shared-types';

export const HEALTH_WINDOW = '5m' as const;
export const HEALTH_WINDOW_MS = 5 * 60 * 1000;

/** Failures that say something about the provider (not about our request or the output). */
const PROVIDER_FAILURES: AiCallOutcome[] = [
  'TIMEOUT',
  'RATE_LIMITED',
  'PROVIDER_ERROR',
  'NETWORK_ERROR',
  'AUTH_ERROR',
];

/** Nearest-rank percentile of an ascending-sorted list. */
export function percentile(sorted: readonly number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1]!;
}

export function summarizeWindow(latencies: readonly number[], calls: number, failures: number) {
  const sorted = [...latencies].sort((a, b) => a - b);
  const errorRate = calls === 0 ? 0 : failures / calls;
  const status: ProviderHealthStatus =
    calls === 0 ? 'IDLE' : errorRate >= 0.5 ? 'DOWN' : errorRate >= 0.1 ? 'DEGRADED' : 'HEALTHY';
  return {
    calls,
    failures,
    errorRate: Math.round(errorRate * 10_000) / 10_000,
    p50LatencyMs: percentile(sorted, 50),
    p95LatencyMs: percentile(sorted, 95),
    status,
  };
}

/**
 * Rolls `aiUsage` into per-model 5-minute windows in `providerHealth` (the
 * admin health view reads these). Recomputes the current and previous window
 * each run, so it is idempotent and tolerates missed runs.
 */
export async function rollupProviderHealth(now: Date = new Date()): Promise<number> {
  const currentStart = Math.floor(now.getTime() / HEALTH_WINDOW_MS) * HEALTH_WINDOW_MS;
  let written = 0;
  for (const start of [currentStart - HEALTH_WINDOW_MS, currentStart]) {
    const windowStart = new Date(start);
    const groups = await AiUsageModel.aggregate<{
      _id: mongoose.Types.ObjectId;
      provider: AiProviderKey;
      model: string;
      calls: number;
      failures: number;
      latencies: number[];
    }>([
      {
        $match: {
          at: { $gte: windowStart, $lt: new Date(start + HEALTH_WINDOW_MS) },
          feature: { $ne: 'admin.test' },
        },
      },
      {
        $group: {
          _id: '$modelRef',
          provider: { $first: '$provider' },
          model: { $first: '$model' },
          calls: { $sum: 1 },
          failures: { $sum: { $cond: [{ $in: ['$outcome', PROVIDER_FAILURES] }, 1, 0] } },
          // Latency of answered calls only; bounded so a busy window stays cheap.
          latencies: {
            $push: { $cond: [{ $in: ['$outcome', PROVIDER_FAILURES] }, '$$REMOVE', '$latencyMs'] },
          },
        },
      },
      {
        $project: {
          provider: 1,
          model: 1,
          calls: 1,
          failures: 1,
          latencies: { $slice: ['$latencies', 5000] },
        },
      },
    ]);
    for (const g of groups) {
      await ProviderHealthModel.updateOne(
        { modelRef: g._id, window: HEALTH_WINDOW, windowStart },
        {
          $set: {
            provider: g.provider,
            model: g.model,
            ...summarizeWindow(g.latencies, g.calls, g.failures),
          },
        },
        { upsert: true },
      );
      written += 1;
    }
  }
  return written;
}

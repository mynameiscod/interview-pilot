import { InterviewReportModel } from '@cbi/db';
import {
  BENCHMARK_MIN_SAMPLE,
  BENCHMARK_WINDOW_DAYS,
  type PeerBenchmark,
  type RoleFamily,
} from '@cbi/shared-types';
import type { Types } from 'mongoose';

/**
 * Peer benchmark: where an overall score sits among other candidates who
 * practised for the same role (or, with too few, the same role family) in
 * the last 180 days. Each other candidate counts once (their latest
 * original report), the candidate's own attempts are left out, and only the
 * percentile and sample size are stored, never another candidate's data.
 * Hidden below 30 candidates.
 */

/** Share (0–100) of `others` strictly below `score`. */
export function percentileOf(score: number, others: readonly number[]): number {
  if (others.length === 0) return 0;
  return Math.round((others.filter((o) => o < score).length * 100) / others.length);
}

/** One overall score per other candidate: their latest original report in the window. */
async function peerScores(
  field: 'roleKey' | 'roleFamily',
  value: string,
  userId: Types.ObjectId,
  since: Date,
): Promise<number[]> {
  const rows = await InterviewReportModel.aggregate<{ overall: number }>([
    {
      $match: {
        [field]: value,
        revision: 0,
        generatedAt: { $gte: since },
        overall: { $ne: null },
        userId: { $ne: userId },
      },
    },
    { $sort: { generatedAt: -1 } },
    { $group: { _id: '$userId', overall: { $first: '$overall' } } },
    { $project: { _id: 0, overall: 1 } },
  ]);
  return rows.map((r) => r.overall);
}

export async function peerBenchmark(input: {
  overall: number | null;
  userId: Types.ObjectId;
  roleKey: string | null;
  roleTitle: string;
  family: RoleFamily | null;
  now: Date;
}): Promise<PeerBenchmark | null> {
  if (input.overall === null) return null;
  const since = new Date(input.now.getTime() - BENCHMARK_WINDOW_DAYS * 86_400_000);
  const candidates: { basis: 'ROLE' | 'FAMILY'; field: 'roleKey' | 'roleFamily'; value: string }[] =
    [];
  if (input.roleKey) candidates.push({ basis: 'ROLE', field: 'roleKey', value: input.roleKey });
  if (input.family)
    candidates.push({ basis: 'FAMILY', field: 'roleFamily', value: roleFamilyKey(input.family) });
  for (const c of candidates) {
    const others = await peerScores(c.field, c.value, input.userId, since);
    if (others.length < BENCHMARK_MIN_SAMPLE) continue;
    return {
      percentile: percentileOf(input.overall, others),
      sampleSize: others.length,
      basis: c.basis,
      roleTitle: c.basis === 'ROLE' ? input.roleTitle : null,
      family: c.basis === 'FAMILY' ? input.family : null,
      windowDays: BENCHMARK_WINDOW_DAYS,
    };
  }
  return null;
}

export const roleFamilyKey = (family: RoleFamily) => `family:${family}`;

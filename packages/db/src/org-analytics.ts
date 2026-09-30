import {
  ReadinessBand,
  type CohortAnalytics,
  type CohortStudent,
  type InviteTags,
} from '@cbi/shared-types';
import type { Types } from 'mongoose';
import { applicationStatus } from './campaign-results.js';
import { CampaignApplicationModel } from './models/campaign.js';
import { InterviewScoreModel } from './models/evaluation.js';
import { InterviewSessionModel } from './models/interview-session.js';
import { CampaignInviteModel } from './models/org.js';
import { UserProfileModel } from './models/user-profile.js';
import { UserModel } from './models/user.js';

/**
 * College (TPO) cohort readiness: participation, readiness bands and
 * dimension averages on each student's latest scored attempt, and the change
 * between a student's first and latest scored attempts across the college's
 * campaigns. Only interviews the student agreed to share (CAMPAIGN_SHARING)
 * are counted, apart from the plain invited / joined / completed counts.
 */

export interface CohortAttempt {
  userId: string;
  joinedAt: Date;
  /** Only shared (consented) attempts carry scores; the others count for participation. */
  consented: boolean;
  completed: boolean;
  overall: number | null;
  band: string | null;
  dimensions: { key: string; name: string; score: number | null }[];
  tags: InviteTags | null;
}

export interface CohortFilter {
  batch?: string;
  branch?: string;
  year?: number;
}

const BAND_ORDER: readonly string[] = ReadinessBand.options;

const round1 = (n: number) => Math.round(n * 10) / 10;

export function matchesTags(tags: InviteTags | null, filter: CohortFilter): boolean {
  if (filter.batch && tags?.batch !== filter.batch) return false;
  if (filter.branch && tags?.branch !== filter.branch) return false;
  if (filter.year !== undefined && tags?.year !== filter.year) return false;
  return true;
}

/** Pure aggregation over one cohort's attempts (unit-tested). Names are filled in afterwards. */
export function aggregateCohort(
  attempts: readonly CohortAttempt[],
  invited: number,
): Omit<CohortAnalytics, 'tagValues'> {
  const joined = attempts.length;
  const completed = attempts.filter((a) => a.completed).length;
  const byStudent = new Map<string, CohortAttempt[]>();
  for (const a of attempts) {
    if (!a.consented) continue;
    byStudent.set(a.userId, [...(byStudent.get(a.userId) ?? []), a]);
  }

  const students: CohortStudent[] = [];
  const bandCounts = new Map<string, number>();
  const dims = new Map<string, { name: string; sum: number; count: number }>();
  const deltas: number[] = [];
  for (const [userId, list] of byStudent) {
    const ordered = [...list].sort((a, b) => a.joinedAt.getTime() - b.joinedAt.getTime());
    const scored = ordered.filter((a) => a.overall !== null);
    const first = scored[0] ?? null;
    const latest = scored.at(-1) ?? null;
    const improvement =
      scored.length >= 2 && first && latest ? latest.overall! - first.overall! : null;
    if (improvement !== null) deltas.push(improvement);
    if (latest?.band) bandCounts.set(latest.band, (bandCounts.get(latest.band) ?? 0) + 1);
    for (const d of latest?.dimensions ?? []) {
      const entry = dims.get(d.key) ?? { name: d.name, sum: 0, count: 0 };
      if (d.score !== null) {
        entry.sum += d.score;
        entry.count += 1;
      }
      dims.set(d.key, entry);
    }
    students.push({
      userId,
      name: null,
      email: null,
      tags: ordered.at(-1)?.tags ?? null,
      attempts: ordered.length,
      firstOverall: first?.overall ?? null,
      latestOverall: latest?.overall ?? null,
      improvement,
      latestBand: latest?.band ?? null,
    });
  }

  const bands = [...bandCounts.entries()]
    .map(([band, count]) => ({ band, count }))
    .sort((a, b) => {
      const ia = BAND_ORDER.indexOf(a.band);
      const ib = BAND_ORDER.indexOf(b.band);
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
    });
  students.sort(
    (a, b) => (b.latestOverall ?? -1) - (a.latestOverall ?? -1) || a.userId.localeCompare(b.userId),
  );
  return {
    participation: {
      invited,
      joined,
      completed,
      rate: invited > 0 ? round1((completed / invited) * 100) / 100 : null,
    },
    bands,
    dimensions: [...dims.entries()].map(([key, d]) => ({
      key,
      name: d.name,
      average: d.count > 0 ? round1(d.sum / d.count) : null,
      count: d.count,
    })),
    improvement: {
      students: deltas.length,
      averageDelta: deltas.length
        ? round1(deltas.reduce((a, b) => a + b, 0) / deltas.length)
        : null,
      improved: deltas.filter((d) => d > 0).length,
      declined: deltas.filter((d) => d < 0).length,
    },
    students,
  };
}

/** Loads a college's attempts from MongoDB and aggregates them. */
export async function cohortAnalytics(
  orgId: Types.ObjectId,
  campaignIds: readonly Types.ObjectId[],
  filter: CohortFilter,
): Promise<CohortAnalytics> {
  const [applications, invites] = await Promise.all([
    CampaignApplicationModel.find(
      { campaignId: { $in: campaignIds } },
      { userId: 1, sessionId: 1, joinedAt: 1, inviteId: 1 },
    ).lean(),
    CampaignInviteModel.find(
      { orgId, campaignId: { $in: campaignIds }, status: { $ne: 'REVOKED' } },
      { tags: 1, userId: 1 },
    ).lean(),
  ]);
  const sessionIds = applications.map((a) => a.sessionId);
  const [sessions, scores] = await Promise.all([
    InterviewSessionModel.find({ _id: { $in: sessionIds } }, { state: 1, consents: 1 }).lean(),
    InterviewScoreModel.aggregate<{
      _id: Types.ObjectId;
      overall: number | null;
      band: string;
      dimensions: { key: string; name: string; score: number | null }[];
    }>([
      { $match: { sessionId: { $in: sessionIds } } },
      { $sort: { revision: -1 } },
      {
        $group: {
          _id: '$sessionId',
          overall: { $first: '$overall' },
          band: { $first: '$band' },
          dimensions: { $first: '$dimensions' },
        },
      },
    ]),
  ]);
  const sessionById = new Map(sessions.map((s) => [String(s._id), s]));
  const scoreBySession = new Map(scores.map((s) => [String(s._id), s]));
  const tagsByInvite = new Map(invites.map((i) => [String(i._id), i.tags]));

  const tagValues = {
    batch: new Set<string>(),
    branch: new Set<string>(),
    year: new Set<number>(),
  };
  for (const i of invites) {
    if (i.tags.batch) tagValues.batch.add(i.tags.batch);
    if (i.tags.branch) tagValues.branch.add(i.tags.branch);
    if (i.tags.year !== null) tagValues.year.add(i.tags.year);
  }

  const attempts: CohortAttempt[] = [];
  for (const app of applications) {
    const tags = app.inviteId ? (tagsByInvite.get(String(app.inviteId)) ?? null) : null;
    if (!matchesTags(tags, filter)) continue;
    const session = sessionById.get(String(app.sessionId));
    const consented = (session?.consents ?? []).some(
      (c) => c.type === 'CAMPAIGN_SHARING' && c.accepted,
    );
    const score = consented ? scoreBySession.get(String(app.sessionId)) : undefined;
    attempts.push({
      userId: String(app.userId),
      joinedAt: app.joinedAt,
      consented,
      completed: session ? applicationStatus(session.state) === 'COMPLETED' : false,
      overall: score?.overall ?? null,
      band: score?.band ?? null,
      dimensions: (score?.dimensions ?? []).map((d) => ({
        key: d.key,
        name: d.name,
        score: d.score,
      })),
      tags,
    });
  }
  const invited = invites.filter((i) => matchesTags(i.tags, filter)).length;
  const result = aggregateCohort(attempts, invited);

  // Names and emails for the students listed (shared through their consent).
  const ids = result.students.map((s) => s.userId);
  const [users, profiles] = await Promise.all([
    UserModel.find({ _id: { $in: ids } }, { primaryEmail: 1 }).lean(),
    UserProfileModel.find({ userId: { $in: ids } }, { userId: 1, displayName: 1 }).lean(),
  ]);
  const email = new Map(users.map((u) => [String(u._id), u.primaryEmail ?? null]));
  const name = new Map(profiles.map((p) => [String(p.userId), p.displayName ?? null]));
  for (const s of result.students) {
    s.email = email.get(s.userId) ?? null;
    s.name = name.get(s.userId) ?? null;
  }
  return {
    ...result,
    tagValues: {
      batch: [...tagValues.batch].sort(),
      branch: [...tagValues.branch].sort(),
      year: [...tagValues.year].sort((a, b) => a - b),
    },
  };
}

/** The cohort report CSV (one row per student). */
export function cohortCsvLines(analytics: CohortAnalytics): string[] {
  const cell = (v: unknown) => {
    if (v === null || v === undefined) return '';
    let s = String(v);
    if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const line = (cells: unknown[]) => `${cells.map(cell).join(',')}\r\n`;
  return [
    `${String.fromCharCode(0xfeff)}${line([
      'Name',
      'Email',
      'Batch',
      'Branch',
      'Year',
      'Attempts',
      'First overall',
      'Latest overall',
      'Improvement',
      'Latest band',
    ])}`,
    ...analytics.students.map((s) =>
      line([
        s.name,
        s.email,
        s.tags?.batch,
        s.tags?.branch,
        s.tags?.year,
        s.attempts,
        s.firstOverall,
        s.latestOverall,
        s.improvement,
        s.latestBand,
      ]),
    ),
  ];
}

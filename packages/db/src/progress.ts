import type { BadgeKey } from '@cbi/shared-types';
import mongoose, { type Types } from 'mongoose';
import { istDay, istDayBounds } from './analytics.js';
import { InterviewSessionModel } from './models/interview-session.js';
import { BadgeAwardModel } from './models/progress.js';

/**
 * Progress queries shared by the API (progress hub, drill quota) and the
 * worker (practice nudges).
 */

type Id = Types.ObjectId | string;

/**
 * Finished sessions that count as practice: the interview or drill reached
 * evaluation (PROCESSING) or has its report. Ended-early sessions count too;
 * cancelled, failed and expired ones do not.
 */
export const PRACTICE_STATES = ['PROCESSING', 'REPORT_READY'] as const;

/** Streaks never look further back than this. */
export const PRACTICE_LOOKBACK_DAYS = 400;

export interface PracticeSession {
  sessionId: string;
  kind: 'INTERVIEW' | 'DRILL';
  /** India-time day the session ended. */
  day: string;
  endedAt: Date;
}

/** The candidate's finished interviews and drills, oldest first. */
export async function practiceSessions(userId: Id, now = new Date()): Promise<PracticeSession[]> {
  const since = new Date(now.getTime() - PRACTICE_LOOKBACK_DAYS * 24 * 3600 * 1000);
  const rows = await InterviewSessionModel.find(
    { userId, state: { $in: PRACTICE_STATES }, endedAt: { $gte: since } },
    { kind: 1, endedAt: 1 },
  )
    .sort({ endedAt: 1 })
    .lean();
  return rows.map((r) => ({
    sessionId: String(r._id),
    kind: r.kind ?? 'INTERVIEW',
    day: istDay(r.endedAt!),
    endedAt: r.endedAt!,
  }));
}

/** Drills started on the India-time day of `now` (the free daily quota counts these). */
export async function drillsStartedToday(userId: Id, now = new Date()): Promise<number> {
  const { start, end } = istDayBounds(istDay(now));
  return InterviewSessionModel.countDocuments({
    userId,
    kind: 'DRILL',
    startedAt: { $gte: start, $lt: end },
  });
}

/**
 * Records earned badges. Idempotent: the unique {userId, badge} index keeps
 * the first award, and a badge is never taken back.
 */
export async function awardBadges(
  userId: Id,
  earned: readonly { key: BadgeKey; at: Date }[],
): Promise<void> {
  if (earned.length === 0) return;
  const uid = typeof userId === 'string' ? new mongoose.Types.ObjectId(userId) : userId;
  await BadgeAwardModel.bulkWrite(
    earned.map((b) => ({
      updateOne: {
        filter: { userId: uid, badge: b.key },
        update: { $setOnInsert: { userId: uid, badge: b.key, awardedAt: b.at } },
        upsert: true,
      },
    })),
    { ordered: false },
  ).catch((err: { code?: number }) => {
    // Two requests awarding at once: the other one's insert won.
    if (err.code !== 11000) throw err;
  });
}

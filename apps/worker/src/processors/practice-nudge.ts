import { signEmailLink } from '@cbi/auth-core';
import type { Logger } from '@cbi/config';
import {
  practiceSessions,
  UserModel,
  UserProfileModel,
  UserProgressModel,
  type PracticeSession,
} from '@cbi/db';
import type { EmailProvider } from '@cbi/provider-adapters';
import { computeStreak, daysBetween, istDayOf, type Streak } from '@cbi/scoring-core';
import type { OutputLanguage } from '../evaluation/language.js';
import { nudgeEmail, type NudgeKind } from './nudge-messages.js';

/** At most one practice nudge per candidate in this period. */
export const NUDGE_INTERVAL_MS = 3 * 24 * 3600 * 1000;
/** Days without practice before a "come back" nudge. */
export const COMEBACK_AFTER_DAYS = 3;
/** Nudges sent per run at most (the next run continues). */
export const MAX_NUDGES_PER_RUN = 500;

/**
 * Which nudge, if any, a candidate should get today. Only candidates who
 * have practised before are nudged, and never on a day they practised: a
 * streak of two or more days that ends yesterday is at risk; three or more
 * days without practice invite them back.
 */
export function decideNudge(streak: Streak, today: string): NudgeKind | null {
  if (!streak.lastPracticeDay || streak.practicedToday) return null;
  const idle = daysBetween(streak.lastPracticeDay, today);
  if (idle === 1 && streak.current >= 2) return 'STREAK_AT_RISK';
  if (idle >= COMEBACK_AFTER_DAYS) return 'COMEBACK';
  return null;
}

const languageOf = (preference: string | null | undefined): OutputLanguage =>
  preference === 'hi' || preference === 'te' ? preference : 'en';

export interface PracticeNudgeDeps {
  email: EmailProvider | null;
  /** Live check (admin-managed integrations); default: whether `email` is set. */
  emailEnabled?: () => boolean;
  candidateUrl: string;
  /** Key for the signed unsubscribe link (the API verifies it). */
  linkKey: Buffer;
  logger: Logger;
  now?: Date;
  /** Injected in unit tests; default: the database. */
  sessions?: (userId: string, now: Date) => Promise<PracticeSession[]>;
}

/**
 * Emails practice nudges to candidates who opted into product updates
 * (`productUpdatesOptIn`) and have a verified email address. Each send first
 * claims the candidate's nudge slot with one conditional write (unique per
 * user), so replicas and retries never send two within NUDGE_INTERVAL_MS.
 * Nothing is sent while email is not configured.
 */
export async function runPracticeNudges(deps: PracticeNudgeDeps) {
  const now = deps.now ?? new Date();
  const counts = { checked: 0, sent: 0, failed: 0 };
  if (!deps.email || (deps.emailEnabled && !deps.emailEnabled())) return counts;
  const today = istDayOf(now);
  const since = new Date(now.getTime() - NUDGE_INTERVAL_MS);
  const loadSessions = deps.sessions ?? practiceSessions;
  const base = deps.candidateUrl.replace(/\/$/, '');

  const profiles = UserProfileModel.find(
    { productUpdatesOptIn: true },
    { userId: 1, preferredInterviewLanguage: 1 },
  )
    .lean()
    .cursor();
  for await (const profile of profiles) {
    if (counts.sent >= MAX_NUDGES_PER_RUN) break;
    counts.checked += 1;
    const userId = String(profile.userId);
    const recent = await UserProgressModel.exists({ userId, lastNudgeAt: { $gt: since } });
    if (recent) continue;
    const user = await UserModel.findOne(
      { _id: profile.userId, status: 'ACTIVE' },
      { primaryEmail: 1, emailVerifiedAt: 1 },
    ).lean();
    if (!user?.primaryEmail || !user.emailVerifiedAt) continue;
    const streak = computeStreak(
      (await loadSessions(userId, now)).map((s) => s.day),
      today,
    );
    const kind = decideNudge(streak, today);
    if (!kind) continue;

    // Claim the slot: matches only when no nudge went out recently; a missing
    // document is created (a concurrent claim then fails on the unique userId).
    const claimed = await UserProgressModel.updateOne(
      { userId: profile.userId, $or: [{ lastNudgeAt: null }, { lastNudgeAt: { $lte: since } }] },
      { $set: { lastNudgeAt: now }, $inc: { nudgesSent: 1 } },
      { upsert: true },
    ).catch((err: { code?: number }) => {
      if (err.code === 11000) return null;
      throw err;
    });
    if (!claimed || claimed.modifiedCount + claimed.upsertedCount !== 1) continue;

    const token = signEmailLink(deps.linkKey, { userId, purpose: 'unsubscribe', issuedAt: now });
    const message = nudgeEmail(languageOf(profile.preferredInterviewLanguage), kind, {
      streak: streak.current,
      appLink: `${base}/app`,
      unsubscribeLink: `${base}/unsubscribe?token=${encodeURIComponent(token)}`,
    });
    try {
      await deps.email.send({ to: user.primaryEmail, ...message });
      counts.sent += 1;
    } catch (err) {
      // The slot stays claimed: a failed send is not retried sooner than the interval.
      counts.failed += 1;
      deps.logger.warn({ err, userId }, 'practice nudge email failed');
    }
  }
  return counts;
}

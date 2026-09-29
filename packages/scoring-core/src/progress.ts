import type {
  BadgeKey,
  CompetencyCategory,
  DimensionTrend,
  ReadinessBand,
  ReadinessPoint,
  ScheduleItem,
} from '@cbi/shared-types';

/**
 * Progress hub rules (pure and deterministic): India-time days, practice
 * streaks, weekly goals, the suggested schedule before a target date,
 * readiness and dimension trends across attempts, and badges.
 */

// ---- Days (India time) ------------------------------------------------------------------

/** India is UTC+5:30 all year (no daylight saving). */
export const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000;
const DAY_MS = 24 * 3600 * 1000;

/** The India-time calendar day of an instant, `YYYY-MM-DD`. */
export const istDayOf = (at: Date): string =>
  new Date(at.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);

/** The instant an India-time day starts. */
export const istDayStart = (day: string): Date =>
  new Date(Date.parse(`${day}T00:00:00Z`) - IST_OFFSET_MS);

export const addDays = (day: string, n: number): string =>
  new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);

/** Whole days from `from` to `to` (negative when `to` is earlier). */
export const daysBetween = (from: string, to: string): number =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);

/** The Monday of the (India-time) week `day` is in. */
export function weekStartOf(day: string): string {
  const weekday = new Date(`${day}T00:00:00Z`).getUTCDay(); // 0 = Sunday
  return addDays(day, -((weekday + 6) % 7));
}

// ---- Streaks and goals ---------------------------------------------------------------------

export interface Streak {
  current: number;
  longest: number;
  practicedToday: boolean;
  lastPracticeDay: string | null;
}

/**
 * Practice streaks from the days with a completed interview or drill. The
 * current streak ends today, or yesterday while today is still open (it only
 * breaks once a whole day passes without practice). Days after `today` are
 * ignored.
 */
export function computeStreak(days: Iterable<string>, today: string): Streak {
  const sorted = [...new Set(days)].filter((d) => d <= today).sort();
  let longest = 0;
  let run = 0;
  let previous: string | null = null;
  for (const day of sorted) {
    run = previous !== null && daysBetween(previous, day) === 1 ? run + 1 : 1;
    longest = Math.max(longest, run);
    previous = day;
  }
  const last = sorted.at(-1) ?? null;
  const alive = last !== null && daysBetween(last, today) <= 1;
  return {
    current: alive ? run : 0,
    longest,
    practicedToday: last === today,
    lastPracticeDay: last,
  };
}

/** The first day on which a run of `length` consecutive practice days was completed. */
export function firstRunDay(days: Iterable<string>, length: number): string | null {
  const sorted = [...new Set(days)].sort();
  let run = 0;
  let previous: string | null = null;
  for (const day of sorted) {
    run = previous !== null && daysBetween(previous, day) === 1 ? run + 1 : 1;
    if (run >= length) return day;
    previous = day;
  }
  return null;
}

/** Sessions completed in the week (Monday–Sunday) that contains `today`; one entry per session. */
export function completedThisWeek(sessionDays: readonly string[], today: string): number {
  const start = weekStartOf(today);
  const end = addDays(start, 6);
  return sessionDays.filter((d) => d >= start && d <= end).length;
}

/** Longest suggested schedule shown. */
export const MAX_SCHEDULE_ITEMS = 14;

/**
 * A practice schedule up to a target interview date: sessions spaced to meet
 * the weekly target, drills on the weakest dimensions in turn with a full
 * interview every third session, and a full mock interview the day before
 * the target (or today, when the target is today or tomorrow). Empty without
 * a target date or once it has passed.
 */
export function suggestSchedule(input: {
  today: string;
  targetDate: string | null;
  weeklyTarget: number;
  /** Dimensions to practise, weakest first. */
  focus: readonly { key: string; name: string }[];
}): ScheduleItem[] {
  const { today, targetDate } = input;
  if (!targetDate || targetDate < today) return [];
  const finalDay = targetDate > today ? addDays(targetDate, -1) : today;
  const interval = Math.max(1, Math.round(7 / Math.max(1, input.weeklyTarget)));
  const items: ScheduleItem[] = [];
  let drills = 0;
  for (let day = today; day < finalDay && items.length < MAX_SCHEDULE_ITEMS - 1;) {
    const third = (items.length + 1) % 3 === 0;
    const focus = input.focus.length ? input.focus[drills % input.focus.length]! : null;
    if (third || !focus) {
      items.push({ day, kind: 'INTERVIEW', dimensionKey: null, dimensionName: null });
    } else {
      items.push({ day, kind: 'DRILL', dimensionKey: focus.key, dimensionName: focus.name });
      drills += 1;
    }
    day = addDays(day, interval);
  }
  items.push({ day: finalDay, kind: 'INTERVIEW', dimensionKey: null, dimensionName: null });
  return items;
}

// ---- Trends --------------------------------------------------------------------------------

/** Latest minus the previous scored attempt at the same role (null without one). */
export function readinessDelta(trend: readonly ReadinessPoint[]): number | null {
  const latest = trend.at(-1);
  if (!latest || latest.overall === null) return null;
  const previous = trend
    .slice(0, -1)
    .reverse()
    .find((p) => p.roleKey === latest.roleKey && p.overall !== null);
  return previous ? latest.overall - previous.overall! : null;
}

export interface TrendAttempt {
  sessionId: string;
  /** ISO time. */
  at: string;
  kind: 'INTERVIEW' | 'DRILL';
  dimensions: readonly {
    key: string;
    name: string;
    category?: CompetencyCategory | null;
    score: number | null;
  }[];
}

const normKey = (key: string) => key.trim().toLowerCase();
const normName = (name: string) => name.trim().toLowerCase().replace(/\s+/g, ' ');

/**
 * Per-dimension series across attempts at one role, oldest first. Attempts
 * may use different blueprint versions: dimensions are matched by key, and a
 * key the current blueprint does not have is matched to a current dimension
 * of the same name (AI-generated blueprints sometimes rename keys). Current
 * dimensions come first, in blueprint order, even without scores yet; others
 * are kept (current: false) while they have scores. Unscored dimensions
 * ("not assessed") add no point, never a zero.
 */
export function dimensionTrends(
  attempts: readonly TrendAttempt[],
  current: readonly { key: string; name: string; category: CompetencyCategory | null }[],
): DimensionTrend[] {
  type Series = Omit<DimensionTrend, 'latest' | 'delta'>;
  const series = new Map<string, Series>();
  const currentByName = new Map<string, string>();
  for (const d of current) {
    const key = normKey(d.key);
    if (series.has(key)) continue;
    series.set(key, { key: d.key, name: d.name, category: d.category, current: true, points: [] });
    currentByName.set(normName(d.name), key);
  }
  const ordered = [...attempts].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  for (const attempt of ordered) {
    for (const d of attempt.dimensions) {
      const own = normKey(d.key);
      const key = series.has(own) ? own : (currentByName.get(normName(d.name)) ?? own);
      let s = series.get(key);
      if (!s) {
        s = { key: d.key, name: d.name, category: d.category ?? null, current: false, points: [] };
        series.set(key, s);
      }
      if (!s.current) {
        s.name = d.name;
        s.category = d.category ?? s.category;
      }
      if (d.score !== null) {
        s.points.push({
          sessionId: attempt.sessionId,
          at: attempt.at,
          score: d.score,
          kind: attempt.kind,
        });
      }
    }
  }
  return [...series.values()]
    .filter((s) => s.current || s.points.length > 0)
    .map((s) => {
      const first = s.points[0];
      const last = s.points.at(-1);
      return {
        ...s,
        latest: last?.score ?? null,
        delta: first && last && s.points.length > 1 ? last.score - first.score : null,
      };
    });
}

/** Current dimensions to practise, weakest first (unscored ones after scored ones). */
export function weakestDimensions(trends: readonly DimensionTrend[], limit = 3) {
  return trends
    .filter((t) => t.current)
    .sort((a, b) => (a.latest ?? 101) - (b.latest ?? 101) || a.key.localeCompare(b.key))
    .slice(0, limit)
    .map((t) => ({ key: t.key, name: t.name }));
}

// ---- Badges --------------------------------------------------------------------------------

export interface BadgeFacts {
  /** Completed interviews with a report, any order. */
  interviews: readonly {
    at: Date;
    mode: 'TEXT' | 'VOICE' | 'VIDEO';
    overall: number | null;
    roleKey: string | null;
    /** A coding problem with every test passed. */
    codingPassed: boolean;
  }[];
  /** India-time days with a completed interview or drill. */
  practiceDays: readonly string[];
  /** When every item of some plan was first done (null: never). */
  planCompletedAt: Date | null;
}

/** Readiness points gained over the first attempt at a role for READINESS_PLUS_10. */
export const READINESS_GAIN_BADGE = 10;

/** Badges the facts earn, each with the time it was earned. */
export function earnedBadges(facts: BadgeFacts): { key: BadgeKey; at: Date }[] {
  const earned: { key: BadgeKey; at: Date }[] = [];
  const interviews = [...facts.interviews].sort((a, b) => a.at.getTime() - b.at.getTime());
  const first = (pred: (i: (typeof interviews)[number]) => boolean) => interviews.find(pred)?.at;

  const firstInterview = interviews[0]?.at;
  if (firstInterview) earned.push({ key: 'FIRST_INTERVIEW', at: firstInterview });
  const voice = first((i) => i.mode !== 'TEXT');
  if (voice) earned.push({ key: 'FIRST_VOICE_INTERVIEW', at: voice });

  for (const [key, length] of [
    ['STREAK_3', 3],
    ['STREAK_7', 7],
  ] as const) {
    const day = firstRunDay(facts.practiceDays, length);
    if (day) earned.push({ key, at: istDayStart(day) });
  }

  const baseline = new Map<string, number>();
  for (const i of interviews) {
    if (i.overall === null || i.roleKey === null) continue;
    const base = baseline.get(i.roleKey);
    if (base === undefined) baseline.set(i.roleKey, i.overall);
    else if (i.overall - base >= READINESS_GAIN_BADGE) {
      earned.push({ key: 'READINESS_PLUS_10', at: i.at });
      break;
    }
  }

  if (facts.planCompletedAt) earned.push({ key: 'PLAN_COMPLETE', at: facts.planCompletedAt });
  const coding = first((i) => i.codingPassed);
  if (coding) earned.push({ key: 'CODING_PASSED', at: coding });
  return earned;
}

// ---- Certificates ----------------------------------------------------------------------------

const BAND_RANK: Record<ReadinessBand, number> = {
  INSUFFICIENT_EVIDENCE: 0,
  NOT_YET: 1,
  DEVELOPING: 2,
  READY_WITH_GAPS: 3,
  READY: 4,
};

/** Whether `band` is at least `min` (INSUFFICIENT_EVIDENCE ranks lowest). */
export const bandAtLeast = (band: ReadinessBand, min: ReadinessBand) =>
  BAND_RANK[band] >= BAND_RANK[min];

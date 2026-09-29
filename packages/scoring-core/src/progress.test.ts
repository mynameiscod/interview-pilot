import type { ReadinessPoint } from '@cbi/shared-types';
import { describe, expect, it } from 'vitest';
import {
  addDays,
  bandAtLeast,
  completedThisWeek,
  computeStreak,
  daysBetween,
  dimensionTrends,
  earnedBadges,
  firstRunDay,
  istDayOf,
  istDayStart,
  MAX_SCHEDULE_ITEMS,
  readinessDelta,
  suggestSchedule,
  weakestDimensions,
  weekStartOf,
  type TrendAttempt,
} from './progress.js';

describe('India-time days', () => {
  it('switches day at midnight IST, not UTC', () => {
    expect(istDayOf(new Date('2026-09-28T18:29:59Z'))).toBe('2026-09-28');
    expect(istDayOf(new Date('2026-09-28T18:30:00Z'))).toBe('2026-09-29');
    expect(istDayStart('2026-09-29').toISOString()).toBe('2026-09-28T18:30:00.000Z');
  });

  it('adds days across months and measures gaps', () => {
    expect(addDays('2026-09-29', 3)).toBe('2026-10-02');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
    expect(daysBetween('2026-09-29', '2026-10-02')).toBe(3);
    expect(daysBetween('2026-10-02', '2026-09-29')).toBe(-3);
  });

  it('starts weeks on Monday', () => {
    expect(weekStartOf('2026-09-28')).toBe('2026-09-28'); // Monday
    expect(weekStartOf('2026-10-04')).toBe('2026-09-28'); // Sunday
    expect(weekStartOf('2026-09-29')).toBe('2026-09-28');
  });
});

describe('streaks', () => {
  const today = '2026-09-29';

  it('is zero without practice', () => {
    expect(computeStreak([], today)).toEqual({
      current: 0,
      longest: 0,
      practicedToday: false,
      lastPracticeDay: null,
    });
  });

  it('counts consecutive days ending today', () => {
    const s = computeStreak(['2026-09-27', '2026-09-28', '2026-09-29', '2026-09-29'], today);
    expect(s).toMatchObject({ current: 3, longest: 3, practicedToday: true });
  });

  it('keeps the streak alive until today ends', () => {
    const s = computeStreak(['2026-09-27', '2026-09-28'], today);
    expect(s).toMatchObject({ current: 2, practicedToday: false, lastPracticeDay: '2026-09-28' });
  });

  it('breaks after a whole day without practice but remembers the longest', () => {
    const s = computeStreak(
      ['2026-09-10', '2026-09-11', '2026-09-12', '2026-09-13', '2026-09-26', '2026-09-27'],
      today,
    );
    expect(s).toMatchObject({ current: 0, longest: 4 });
  });

  it('ignores days after today', () => {
    expect(computeStreak(['2026-09-30'], today).current).toBe(0);
  });

  it('finds the day a run of a given length was completed', () => {
    const days = ['2026-09-01', '2026-09-03', '2026-09-04', '2026-09-05', '2026-09-06'];
    expect(firstRunDay(days, 3)).toBe('2026-09-05');
    expect(firstRunDay(days, 7)).toBeNull();
  });
});

describe('weekly goal', () => {
  it('counts sessions in the current Monday–Sunday week', () => {
    const days = ['2026-09-27', '2026-09-28', '2026-09-28', '2026-10-04', '2026-10-05'];
    expect(completedThisWeek(days, '2026-09-29')).toBe(3);
  });
});

describe('suggested schedule', () => {
  const focus = [
    { key: 'sql', name: 'SQL' },
    { key: 'apis', name: 'API design' },
  ];

  it('is empty without a target or after it', () => {
    expect(
      suggestSchedule({ today: '2026-09-29', targetDate: null, weeklyTarget: 3, focus }),
    ).toEqual([]);
    expect(
      suggestSchedule({ today: '2026-09-29', targetDate: '2026-09-28', weeklyTarget: 3, focus }),
    ).toEqual([]);
  });

  it('spaces drills on weak dimensions and ends with a mock interview before the target', () => {
    const items = suggestSchedule({
      today: '2026-09-29',
      targetDate: '2026-10-09',
      weeklyTarget: 3,
      focus,
    });
    expect(items.map((i) => [i.day, i.kind, i.dimensionKey])).toEqual([
      ['2026-09-29', 'DRILL', 'sql'],
      ['2026-10-01', 'DRILL', 'apis'],
      ['2026-10-03', 'INTERVIEW', null],
      ['2026-10-05', 'DRILL', 'sql'],
      ['2026-10-07', 'DRILL', 'apis'],
      ['2026-10-08', 'INTERVIEW', null],
    ]);
  });

  it('suggests one interview today when the target is today or tomorrow', () => {
    for (const targetDate of ['2026-09-29', '2026-09-30']) {
      expect(suggestSchedule({ today: '2026-09-29', targetDate, weeklyTarget: 3, focus })).toEqual([
        { day: '2026-09-29', kind: 'INTERVIEW', dimensionKey: null, dimensionName: null },
      ]);
    }
  });

  it('suggests interviews when no dimension is known and caps the length', () => {
    const items = suggestSchedule({
      today: '2026-01-01',
      targetDate: '2026-06-01',
      weeklyTarget: 7,
      focus: [],
    });
    expect(items).toHaveLength(MAX_SCHEDULE_ITEMS);
    expect(items.every((i) => i.kind === 'INTERVIEW')).toBe(true);
    expect(items.at(-1)!.day).toBe('2026-05-31');
  });
});

describe('readiness delta', () => {
  const point = (overall: number | null, roleKey: string | null): ReadinessPoint => ({
    sessionId: `s${Math.random()}`,
    at: '2026-09-01T00:00:00.000Z',
    overall,
    band: 'DEVELOPING',
    title: 'Role',
    roleKey,
  });

  it('compares with the previous scored attempt at the same role', () => {
    expect(readinessDelta([point(50, 'a'), point(70, 'b'), point(null, 'a'), point(61, 'a')])).toBe(
      11,
    );
  });

  it('is null without a comparable attempt', () => {
    expect(readinessDelta([])).toBeNull();
    expect(readinessDelta([point(60, 'a')])).toBeNull();
    expect(readinessDelta([point(60, 'a'), point(null, 'a')])).toBeNull();
    expect(readinessDelta([point(60, 'a'), point(70, 'b')])).toBeNull();
  });
});

describe('dimension trends', () => {
  const attempt = (
    sessionId: string,
    at: string,
    dims: TrendAttempt['dimensions'],
    kind: TrendAttempt['kind'] = 'INTERVIEW',
  ): TrendAttempt => ({ sessionId, at, kind, dimensions: dims });

  it('normalises by key across attempts, oldest first, skipping unscored dimensions', () => {
    const trends = dimensionTrends(
      [
        attempt('s2', '2026-09-10T00:00:00Z', [
          { key: 'sql', name: 'SQL', score: 60 },
          { key: 'apis', name: 'APIs', score: null },
        ]),
        attempt('s1', '2026-09-01T00:00:00Z', [{ key: 'SQL', name: 'SQL', score: 40 }]),
        attempt('d1', '2026-09-12T00:00:00Z', [{ key: 'sql', name: 'SQL', score: 72 }], 'DRILL'),
      ],
      [
        { key: 'sql', name: 'SQL queries', category: 'TECHNICAL' },
        { key: 'apis', name: 'API design', category: 'TECHNICAL' },
      ],
    );
    expect(trends.map((t) => t.key)).toEqual(['sql', 'apis']);
    expect(trends[0]).toMatchObject({ name: 'SQL queries', current: true, latest: 72, delta: 32 });
    expect(trends[0]!.points.map((p) => [p.sessionId, p.kind])).toEqual([
      ['s1', 'INTERVIEW'],
      ['s2', 'INTERVIEW'],
      ['d1', 'DRILL'],
    ]);
    expect(trends[1]).toMatchObject({ latest: null, delta: null, points: [] });
  });

  it('matches renamed keys by name and keeps retired dimensions that were scored', () => {
    const trends = dimensionTrends(
      [
        attempt('s1', '2026-09-01T00:00:00Z', [
          { key: 'system-design-basics', name: 'System design', score: 50 },
          { key: 'old-topic', name: 'Old topic', score: 45 },
          { key: 'never', name: 'Never scored', score: null },
        ]),
        attempt('s2', '2026-09-08T00:00:00Z', [
          { key: 'system-design', name: 'System Design', score: 58 },
        ]),
      ],
      [{ key: 'system-design', name: 'System Design', category: 'TECHNICAL' }],
    );
    expect(trends.map((t) => [t.key, t.current, t.latest, t.delta])).toEqual([
      ['system-design', true, 58, 8],
      ['old-topic', false, 45, null],
    ]);
  });

  it('orders the weakest current dimensions first', () => {
    const trends = dimensionTrends(
      [
        attempt('s1', '2026-09-01T00:00:00Z', [
          { key: 'a', name: 'A', score: 80 },
          { key: 'b', name: 'B', score: 40 },
        ]),
      ],
      [
        { key: 'a', name: 'A', category: null },
        { key: 'b', name: 'B', category: null },
        { key: 'c', name: 'C', category: null },
      ],
    );
    expect(weakestDimensions(trends).map((d) => d.key)).toEqual(['b', 'a', 'c']);
  });
});

describe('badges', () => {
  const at = (day: string) => new Date(`${day}T10:00:00Z`);

  it('earns nothing without practice', () => {
    expect(earnedBadges({ interviews: [], practiceDays: [], planCompletedAt: null })).toEqual([]);
  });

  it('awards each badge once with the time it was earned', () => {
    const badges = earnedBadges({
      interviews: [
        { at: at('2026-09-05'), mode: 'VOICE', overall: 62, roleKey: 'r', codingPassed: true },
        { at: at('2026-09-01'), mode: 'TEXT', overall: 50, roleKey: 'r', codingPassed: false },
        { at: at('2026-09-03'), mode: 'TEXT', overall: 58, roleKey: 'other', codingPassed: false },
        { at: at('2026-09-09'), mode: 'TEXT', overall: 75, roleKey: 'r', codingPassed: true },
      ],
      practiceDays: ['2026-09-01', '2026-09-02', '2026-09-03'],
      planCompletedAt: at('2026-09-04'),
    });
    expect(Object.fromEntries(badges.map((b) => [b.key, b.at.toISOString()]))).toEqual({
      FIRST_INTERVIEW: at('2026-09-01').toISOString(),
      FIRST_VOICE_INTERVIEW: at('2026-09-05').toISOString(),
      STREAK_3: istDayStart('2026-09-03').toISOString(),
      READINESS_PLUS_10: at('2026-09-05').toISOString(),
      PLAN_COMPLETE: at('2026-09-04').toISOString(),
      CODING_PASSED: at('2026-09-05').toISOString(),
    });
  });

  it('needs ten points over the first attempt at the same role', () => {
    const badges = earnedBadges({
      interviews: [
        { at: at('2026-09-01'), mode: 'TEXT', overall: 50, roleKey: 'a', codingPassed: false },
        { at: at('2026-09-02'), mode: 'TEXT', overall: 65, roleKey: 'b', codingPassed: false },
        { at: at('2026-09-03'), mode: 'TEXT', overall: 59, roleKey: 'a', codingPassed: false },
      ],
      practiceDays: [],
      planCompletedAt: null,
    });
    expect(badges.map((b) => b.key)).toEqual(['FIRST_INTERVIEW']);
  });
});

describe('certificate threshold', () => {
  it('ranks bands', () => {
    expect(bandAtLeast('READY', 'READY_WITH_GAPS')).toBe(true);
    expect(bandAtLeast('READY_WITH_GAPS', 'READY_WITH_GAPS')).toBe(true);
    expect(bandAtLeast('DEVELOPING', 'READY_WITH_GAPS')).toBe(false);
    expect(bandAtLeast('INSUFFICIENT_EVIDENCE', 'DEVELOPING')).toBe(false);
  });
});

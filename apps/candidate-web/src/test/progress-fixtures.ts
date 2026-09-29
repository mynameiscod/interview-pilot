import type { BadgeKey, DrillResult, ProgressOverview } from '@cbi/shared-types';

const BADGES: BadgeKey[] = [
  'FIRST_INTERVIEW',
  'FIRST_VOICE_INTERVIEW',
  'STREAK_3',
  'STREAK_7',
  'READINESS_PLUS_10',
  'PLAN_COMPLETE',
  'CODING_PASSED',
];

/** A new candidate: nothing finished yet. */
export function makeEmptyProgress(overrides: Partial<ProgressOverview> = {}): ProgressOverview {
  return {
    readiness: { latest: null, delta: null, trend: [] },
    focusRole: null,
    dimensions: [],
    plan: null,
    streak: {
      current: 0,
      longest: 0,
      practicedToday: false,
      lastPracticeDay: null,
      today: '2026-09-29',
    },
    goals: {
      weeklyTarget: 3,
      weekCompleted: 0,
      weekStart: '2026-09-28',
      targetDate: null,
      daysToTarget: null,
      schedule: [],
    },
    badges: BADGES.map((key) => ({ key, earned: false, awardedAt: null })),
    drills: { freePerDay: 3, usedToday: 0, remainingToday: 3, questions: 3 },
    recentDrills: [],
    totals: { interviews: 0, drills: 0 },
    ...overrides,
  };
}

/** Two interviews at one role, a drill and an open plan. */
export function makeProgress(overrides: Partial<ProgressOverview> = {}): ProgressOverview {
  const first = {
    sessionId: 'int0',
    at: '2026-09-20T10:00:00.000Z',
    overall: 55,
    band: 'DEVELOPING' as const,
    title: 'Backend Developer',
    roleKey: 'role:be',
  };
  const latest = {
    ...first,
    sessionId: 'int1',
    at: '2026-09-27T10:00:00.000Z',
    overall: 67,
    band: 'READY_WITH_GAPS' as const,
  };
  return makeEmptyProgress({
    readiness: { latest, delta: 12, trend: [first, latest] },
    focusRole: { roleKey: 'role:be', title: 'Backend Developer' },
    dimensions: [
      {
        key: 'sql',
        name: 'SQL',
        category: 'TECHNICAL',
        current: true,
        latest: 48,
        delta: -4,
        points: [
          { sessionId: 'int0', at: first.at, score: 52, kind: 'INTERVIEW' },
          { sessionId: 'int1', at: latest.at, score: 48, kind: 'INTERVIEW' },
        ],
      },
      {
        key: 'teamwork',
        name: 'Teamwork',
        category: 'BEHAVIORAL',
        current: true,
        latest: 81,
        delta: 11,
        points: [
          { sessionId: 'int0', at: first.at, score: 70, kind: 'INTERVIEW' },
          { sessionId: 'd1', at: '2026-09-28T10:00:00.000Z', score: 81, kind: 'DRILL' },
        ],
      },
    ],
    plan: {
      sessionId: 'int1',
      revision: 0,
      title: 'Backend Developer',
      generatedAt: latest.at,
      doneCount: 1,
      items: [
        {
          id: 'next24h.0',
          bucket: 'next24h',
          action: 'Write three JOIN queries.',
          why: 'SQL was your weakest area.',
          dimensionKey: 'sql',
          dimensionName: 'SQL',
          done: false,
          doneAt: null,
        },
        {
          id: 'next3Days.0',
          bucket: 'next3Days',
          action: 'Record a two-minute project story.',
          why: 'Specific examples score higher.',
          dimensionKey: null,
          dimensionName: null,
          done: true,
          doneAt: '2026-09-28T10:00:00.000Z',
        },
      ],
    },
    streak: {
      current: 2,
      longest: 4,
      practicedToday: false,
      lastPracticeDay: '2026-09-28',
      today: '2026-09-29',
    },
    goals: {
      weeklyTarget: 3,
      weekCompleted: 2,
      weekStart: '2026-09-28',
      targetDate: '2026-10-09',
      daysToTarget: 10,
      schedule: [
        { day: '2026-09-29', kind: 'DRILL', dimensionKey: 'sql', dimensionName: 'SQL' },
        { day: '2026-10-08', kind: 'INTERVIEW', dimensionKey: null, dimensionName: null },
      ],
    },
    badges: BADGES.map((key) =>
      key === 'FIRST_INTERVIEW'
        ? { key, earned: true, awardedAt: '2026-09-20T10:00:00.000Z' }
        : { key, earned: false, awardedAt: null },
    ),
    drills: { freePerDay: 3, usedToday: 1, remainingToday: 2, questions: 3 },
    recentDrills: [
      {
        sessionId: 'd1',
        dimensionKey: 'teamwork',
        dimensionName: 'Teamwork',
        state: 'REPORT_READY',
        score: 81,
        at: '2026-09-28T10:00:00.000Z',
      },
    ],
    totals: { interviews: 2, drills: 1 },
    ...overrides,
  });
}

export function makeDrillResult(overrides: Partial<DrillResult> = {}): DrillResult {
  return {
    sessionId: 'd2',
    state: 'REPORT_READY',
    mode: 'TEXT',
    dimension: { key: 'sql', name: 'SQL' },
    score: 60,
    previousScore: 48,
    confidence: 'MEDIUM',
    rationale: 'Clear joins; indexing was vague.',
    questions: [
      {
        seq: 1,
        question: 'How would you find duplicate emails?',
        answered: true,
        feedback: [
          { claim: 'Used GROUP BY with HAVING correctly.', strength: 2 },
          { claim: 'Did not mention indexes.', strength: -1 },
        ],
      },
      { seq: 2, question: 'Explain a LEFT JOIN.', answered: false, feedback: [] },
    ],
    completedAt: '2026-09-29T10:00:00.000Z',
    ...overrides,
  };
}

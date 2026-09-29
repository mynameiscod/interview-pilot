import { z } from 'zod';
import { IsoDay } from './analytics.js';
import { ConfidenceLevel, ReadinessBand } from './evaluation.js';
import { InterviewState } from './interviews.js';
import { CompetencyCategory, InterviewMode } from './library.js';

/**
 * The progress hub: readiness and dimension trends, the current plan with
 * done/undone items, practice drills, streaks, goals, badges and readiness
 * certificates. Days are India-time calendar days (`YYYY-MM-DD`).
 */

// ---- Trends -----------------------------------------------------------------------------------

export const ReadinessPoint = z.object({
  sessionId: z.string(),
  /** When the interview ended (falls back to the report time). */
  at: z.iso.datetime(),
  overall: z.number().int().nullable(),
  band: ReadinessBand,
  title: z.string(),
  roleKey: z.string().nullable(),
});
export type ReadinessPoint = z.infer<typeof ReadinessPoint>;

export const DimensionPoint = z.object({
  sessionId: z.string(),
  at: z.iso.datetime(),
  score: z.number().int(),
  kind: z.enum(['INTERVIEW', 'DRILL']),
});
export type DimensionPoint = z.infer<typeof DimensionPoint>;

/**
 * One dimension across attempts at the focus role, matched by key (or, when
 * an AI-generated blueprint renamed the key, by name). `current` is false for
 * a dimension the latest blueprint no longer assesses.
 */
export const DimensionTrend = z.object({
  key: z.string(),
  name: z.string(),
  category: CompetencyCategory.nullable(),
  current: z.boolean(),
  latest: z.number().int().nullable(),
  /** Latest minus the first scored point (null with fewer than two). */
  delta: z.number().int().nullable(),
  points: z.array(DimensionPoint),
});
export type DimensionTrend = z.infer<typeof DimensionTrend>;

// ---- Plan -----------------------------------------------------------------------------------------

export const PlanBucket = z.enum(['next24h', 'next3Days', 'next7Days']);
export type PlanBucket = z.infer<typeof PlanBucket>;

/** `<bucket>.<index>` within one report revision's plan. */
export const PlanItemId = z.string().regex(/^(next24h|next3Days|next7Days)\.\d{1,2}$/);

export const PlanItemState = z.object({
  id: z.string(),
  bucket: PlanBucket,
  action: z.string(),
  why: z.string(),
  dimensionKey: z.string().nullable(),
  /** Set when the dimension is in the report (a drill can practise it). */
  dimensionName: z.string().nullable(),
  done: z.boolean(),
  doneAt: z.iso.datetime().nullable(),
});
export type PlanItemState = z.infer<typeof PlanItemState>;

export const CurrentPlan = z.object({
  sessionId: z.string(),
  revision: z.number().int(),
  title: z.string(),
  generatedAt: z.iso.datetime(),
  items: z.array(PlanItemState),
  doneCount: z.number().int(),
});
export type CurrentPlan = z.infer<typeof CurrentPlan>;

export const UpdatePlanItemBody = z.object({
  sessionId: z.string().min(1).max(64),
  revision: z.number().int().min(0).max(1000),
  itemId: PlanItemId,
  done: z.boolean(),
});
export type UpdatePlanItemBody = z.infer<typeof UpdatePlanItemBody>;

// ---- Streaks and goals -------------------------------------------------------------------------

export const StreakInfo = z.object({
  /** Consecutive practice days ending today, or yesterday while today is still open. */
  current: z.number().int(),
  longest: z.number().int(),
  practicedToday: z.boolean(),
  lastPracticeDay: IsoDay.nullable(),
  today: IsoDay,
});
export type StreakInfo = z.infer<typeof StreakInfo>;

export const ScheduleItem = z.object({
  day: IsoDay,
  kind: z.enum(['DRILL', 'INTERVIEW']),
  dimensionKey: z.string().nullable(),
  dimensionName: z.string().nullable(),
});
export type ScheduleItem = z.infer<typeof ScheduleItem>;

export const GoalInfo = z.object({
  /** Completed interviews and drills per week the candidate aims for. */
  weeklyTarget: z.number().int(),
  /** Completed this week (Monday to Sunday, India time). */
  weekCompleted: z.number().int(),
  weekStart: IsoDay,
  targetDate: IsoDay.nullable(),
  /** Days from today to the target date (0 on the day; negative once it has passed). */
  daysToTarget: z.number().int().nullable(),
  /** A suggested practice schedule up to the target date (empty without one). */
  schedule: z.array(ScheduleItem),
});
export type GoalInfo = z.infer<typeof GoalInfo>;

export const UpdateGoalsBody = z.object({
  weeklyTarget: z.number().int().min(1).max(14),
  targetDate: IsoDay.nullable(),
});
export type UpdateGoalsBody = z.infer<typeof UpdateGoalsBody>;

// ---- Badges ---------------------------------------------------------------------------------------

export const BadgeKey = z.enum([
  'FIRST_INTERVIEW',
  'FIRST_VOICE_INTERVIEW',
  'STREAK_3',
  'STREAK_7',
  'READINESS_PLUS_10',
  'PLAN_COMPLETE',
  'CODING_PASSED',
]);
export type BadgeKey = z.infer<typeof BadgeKey>;

export const BadgeState = z.object({
  key: BadgeKey,
  earned: z.boolean(),
  awardedAt: z.iso.datetime().nullable(),
});
export type BadgeState = z.infer<typeof BadgeState>;

// ---- Drills -----------------------------------------------------------------------------------------

export const DrillMode = z.enum(['TEXT', 'VOICE']);
export type DrillMode = z.infer<typeof DrillMode>;

/** `POST /drills`: practise one dimension of the candidate's current blueprint. */
export const CreateDrillBody = z.object({
  dimensionKey: z.string().trim().min(1).max(80),
  /** Defaults to the latest completed interview (its blueprint and inputs). */
  sourceSessionId: z.string().min(1).max(64).optional(),
  mode: DrillMode.default('TEXT'),
});
export type CreateDrillBody = z.infer<typeof CreateDrillBody>;

export const DrillQuota = z.object({
  /** 0 when drills are switched off. */
  freePerDay: z.number().int(),
  usedToday: z.number().int(),
  remainingToday: z.number().int(),
  questions: z.number().int(),
});
export type DrillQuota = z.infer<typeof DrillQuota>;

export const DrillSummary = z.object({
  sessionId: z.string(),
  dimensionKey: z.string(),
  dimensionName: z.string(),
  state: InterviewState,
  score: z.number().int().nullable(),
  at: z.iso.datetime(),
});
export type DrillSummary = z.infer<typeof DrillSummary>;

/** A drill's quick evaluation: its score, the evidence and feedback per question. No PDF. */
export const DrillResult = z.object({
  sessionId: z.string(),
  state: InterviewState,
  mode: InterviewMode,
  dimension: z.object({ key: z.string(), name: z.string() }),
  /** Null until evaluated, or when there was not enough evidence. */
  score: z.number().int().nullable(),
  /** The dimension's score before this drill (latest interview or drill), if any. */
  previousScore: z.number().int().nullable(),
  confidence: ConfidenceLevel.nullable(),
  rationale: z.string().nullable(),
  questions: z.array(
    z.object({
      seq: z.number().int(),
      question: z.string(),
      answered: z.boolean(),
      feedback: z.array(z.object({ claim: z.string(), strength: z.number().int() })),
    }),
  ),
  completedAt: z.iso.datetime().nullable(),
});
export type DrillResult = z.infer<typeof DrillResult>;

// ---- Certificates -------------------------------------------------------------------------------

export const CertificateStatus = z.object({
  /** The flag is on and the report's band reaches the threshold. */
  eligible: z.boolean(),
  minBand: ReadinessBand,
  certificate: z
    .object({
      code: z.string(),
      issuedAt: z.iso.datetime(),
      pdfReady: z.boolean(),
      /** `/verify/<code>` on the candidate site. */
      verifyPath: z.string(),
    })
    .nullable(),
});
export type CertificateStatus = z.infer<typeof CertificateStatus>;

/** The public verification page of a certificate. */
export const CertificateVerification = z.object({
  code: z.string(),
  candidateName: z.string().nullable(),
  roleTitle: z.string(),
  overall: z.number().int().nullable(),
  band: ReadinessBand,
  completedAt: z.iso.datetime().nullable(),
  issuedAt: z.iso.datetime(),
  /** The report behind it was replaced by a manual review (the certificate shows the original). */
  superseded: z.boolean(),
});
export type CertificateVerification = z.infer<typeof CertificateVerification>;

/** Certificate codes: `CPI-` and three groups of four unambiguous characters. */
export const CERTIFICATE_CODE_PATTERN =
  /^CPI-[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}$/;

// ---- Email preferences ------------------------------------------------------------------------

/** `POST /email/unsubscribe`: the signed token from an email link (no sign-in needed). */
export const UnsubscribeBody = z.object({ token: z.string().min(20).max(400) });
export type UnsubscribeBody = z.infer<typeof UnsubscribeBody>;

// ---- The hub ------------------------------------------------------------------------------------

export const ProgressOverview = z.object({
  readiness: z.object({
    latest: ReadinessPoint.nullable(),
    /** Latest minus the previous scored attempt at the same role. */
    delta: z.number().int().nullable(),
    trend: z.array(ReadinessPoint),
  }),
  /** The role of the latest interview; dimension trends are for this role. */
  focusRole: z.object({ roleKey: z.string().nullable(), title: z.string() }).nullable(),
  dimensions: z.array(DimensionTrend),
  plan: CurrentPlan.nullable(),
  streak: StreakInfo,
  goals: GoalInfo,
  badges: z.array(BadgeState),
  drills: DrillQuota,
  recentDrills: z.array(DrillSummary),
  /** Completed interviews (with a visible report) and drills. */
  totals: z.object({ interviews: z.number().int(), drills: z.number().int() }),
});
export type ProgressOverview = z.infer<typeof ProgressOverview>;

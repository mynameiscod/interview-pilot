import {
  awardBadges,
  BadgeAwardModel,
  InterviewReportModel,
  InterviewSessionModel,
  PlanItemProgressModel,
  practiceSessions,
  UserProgressModel,
  type InterviewReportRecord,
} from '@cbi/db';
import {
  completedThisWeek,
  computeStreak,
  daysBetween,
  dimensionTrends,
  earnedBadges,
  istDayOf,
  readinessDelta,
  suggestSchedule,
  weakestDimensions,
  weekStartOf,
  type TrendAttempt,
} from '@cbi/scoring-core';
import {
  BadgeKey,
  PlanBucket,
  type CurrentPlan,
  type DrillSummary,
  type GoalInfo,
  type PlanItemState,
  type PracticeSetting,
  type ProgressOverview,
  type ReadinessPoint,
  type ReportContent,
  type UpdateGoalsBody,
  type UpdatePlanItemBody,
} from '@cbi/shared-types';
import type { AuditService } from '../../lib/audit.js';
import { AppError } from '../../lib/errors.js';
import { iso, objectId } from '../../lib/ids.js';
import type { ClientContext } from '../../lib/request-context.js';
import type { DrillService } from './drills.service.js';

/** Drills listed on the hub. */
const RECENT_DRILLS = 5;

/** Report fields the hub reads (never the transcript or evidence quotes). */
const REPORT_FIELDS = {
  sessionId: 1,
  revision: 1,
  kind: 1,
  roleKey: 1,
  generatedAt: 1,
  'content.header': 1,
  'content.overall.score': 1,
  'content.overall.band': 1,
  'content.dimensions.key': 1,
  'content.dimensions.name': 1,
  'content.dimensions.category': 1,
  'content.dimensions.score': 1,
  'content.plan': 1,
  'content.coding': 1,
} as const;

type HubReport = Pick<
  InterviewReportRecord,
  'sessionId' | 'revision' | 'kind' | 'roleKey' | 'generatedAt'
> & { content: ReportContent };

/** When an attempt happened: the end of the interview, else when its report was built. */
const attemptAt = (r: HubReport) =>
  r.content.header.endedAt ? new Date(r.content.header.endedAt) : r.generatedAt;

/** The latest candidate-visible revision of each report, oldest attempt first. */
async function latestVisibleReports(userId: string): Promise<HubReport[]> {
  const rows = await InterviewReportModel.find(
    { userId, 'visibility.candidate': true },
    REPORT_FIELDS,
  )
    .sort({ revision: -1 })
    .lean<HubReport[]>();
  const bySession = new Map<string, HubReport>();
  for (const r of rows) {
    if (!bySession.has(String(r.sessionId))) bySession.set(String(r.sessionId), r);
  }
  return [...bySession.values()].sort((a, b) => attemptAt(a).getTime() - attemptAt(b).getTime());
}

/** Plan items of a report revision, in bucket order, with their ids. */
export function planItems(content: Pick<ReportContent, 'plan'>) {
  return PlanBucket.options.flatMap((bucket) =>
    content.plan[bucket].map((item, index) => ({ id: `${bucket}.${index}`, bucket, ...item })),
  );
}

export function createProgressService(deps: {
  audit: AuditService;
  drills: DrillService;
  practice: () => Promise<PracticeSetting>;
  now?: () => Date;
}) {
  const now = deps.now ?? (() => new Date());

  async function planState(userId: string, report: HubReport): Promise<CurrentPlan> {
    const rows = await PlanItemProgressModel.find({
      userId,
      sessionId: report.sessionId,
      revision: report.revision,
    }).lean();
    const byId = new Map(rows.map((r) => [r.itemId, r]));
    const names = new Map(report.content.dimensions.map((d) => [d.key, d.name]));
    const items: PlanItemState[] = planItems(report.content).map((item) => {
      const row = byId.get(item.id);
      return {
        id: item.id,
        bucket: item.bucket,
        action: item.action,
        why: item.why,
        dimensionKey: item.dimensionKey,
        dimensionName: item.dimensionKey ? (names.get(item.dimensionKey) ?? null) : null,
        done: row?.done ?? false,
        doneAt: row?.done && row.doneAt ? iso(row.doneAt) : null,
      };
    });
    return {
      sessionId: String(report.sessionId),
      revision: report.revision,
      title: report.content.header.title,
      generatedAt: iso(report.generatedAt),
      items,
      doneCount: items.filter((i) => i.done).length,
    };
  }

  /** When the candidate first finished every item of one of these plans. */
  async function planCompletedAt(userId: string, reports: HubReport[]): Promise<Date | null> {
    const rows = await PlanItemProgressModel.find({ userId, done: true }).lean();
    let first: Date | null = null;
    for (const r of reports) {
      const ids = planItems(r.content).map((i) => i.id);
      const done = rows.filter(
        (x) => String(x.sessionId) === String(r.sessionId) && x.revision === r.revision,
      );
      if (ids.length === 0 || !ids.every((id) => done.some((x) => x.itemId === id))) continue;
      const at = new Date(Math.max(...done.map((x) => (x.doneAt ?? x.updatedAt).getTime())));
      if (!first || at < first) first = at;
    }
    return first;
  }

  async function goals(
    userId: string,
    today: string,
    sessionDays: string[],
    focus: { key: string; name: string }[],
  ): Promise<GoalInfo> {
    const [doc, setting] = await Promise.all([
      UserProgressModel.findOne({ userId }).lean(),
      deps.practice(),
    ]);
    const weeklyTarget = doc?.weeklyTarget ?? setting.defaultWeeklyGoal;
    const targetDate = doc?.targetDate ?? null;
    return {
      weeklyTarget,
      weekCompleted: completedThisWeek(sessionDays, today),
      weekStart: weekStartOf(today),
      targetDate,
      daysToTarget: targetDate ? daysBetween(today, targetDate) : null,
      schedule: suggestSchedule({ today, targetDate, weeklyTarget, focus }),
    };
  }

  return {
    async overview(userId: string): Promise<ProgressOverview> {
      const at = now();
      const today = istDayOf(at);
      const [reports, sessions, drills] = await Promise.all([
        latestVisibleReports(userId),
        practiceSessions(userId, at),
        InterviewSessionModel.find(
          { userId, kind: 'DRILL', state: { $nin: ['CANCELLED', 'DRAFT'] } },
          { state: 1, drill: 1, endedAt: 1, createdAt: 1 },
        )
          .sort({ createdAt: -1 })
          .limit(RECENT_DRILLS)
          .lean(),
      ]);
      const interviews = reports.filter((r) => (r.kind ?? 'INTERVIEW') === 'INTERVIEW');
      const drillReports = new Map(
        reports.filter((r) => r.kind === 'DRILL').map((r) => [String(r.sessionId), r]),
      );

      const trend: ReadinessPoint[] = interviews.map((r) => ({
        sessionId: String(r.sessionId),
        at: iso(attemptAt(r)),
        overall: r.content.overall.score,
        band: r.content.overall.band,
        title: r.content.header.title,
        roleKey: r.roleKey,
      }));
      const latest = interviews.at(-1) ?? null;

      // Dimension trends: every interview and drill at the latest interview's role.
      const sameRole = latest
        ? reports.filter((r) =>
            latest.roleKey === null
              ? String(r.sessionId) === String(latest.sessionId)
              : r.roleKey === latest.roleKey,
          )
        : [];
      const dimensions = dimensionTrends(
        sameRole.map((r): TrendAttempt => ({
          sessionId: String(r.sessionId),
          at: iso(attemptAt(r)),
          kind: r.kind ?? 'INTERVIEW',
          dimensions: r.content.dimensions,
        })),
        latest?.content.dimensions.map((d) => ({
          key: d.key,
          name: d.name,
          category: d.category,
        })) ?? [],
      );

      const days = sessions.map((s) => s.day);
      const streak = computeStreak(days, today);
      const earned = earnedBadges({
        interviews: interviews.map((r) => ({
          at: attemptAt(r),
          mode: r.content.header.mode,
          overall: r.content.overall.score,
          roleKey: r.roleKey,
          codingPassed: (r.content.coding ?? []).some(
            (c) => c.total !== null && c.total > 0 && c.passed === c.total,
          ),
        })),
        practiceDays: days,
        planCompletedAt: await planCompletedAt(userId, interviews),
      });
      await awardBadges(userId, earned);
      const awards = await BadgeAwardModel.find({ userId }).lean();

      const recentDrills: DrillSummary[] = drills.flatMap((d) => {
        if (!d.drill) return [];
        const report = drillReports.get(String(d._id));
        const score =
          report?.content.dimensions.find((x) => x.key === d.drill!.competencyKey)?.score ?? null;
        return [
          {
            sessionId: String(d._id),
            dimensionKey: d.drill.competencyKey,
            dimensionName: d.drill.competencyName,
            state: d.state,
            score,
            at: iso(d.endedAt ?? d.createdAt),
          },
        ];
      });

      return {
        readiness: {
          latest: trend.at(-1) ?? null,
          delta: readinessDelta(trend),
          trend,
        },
        focusRole: latest ? { roleKey: latest.roleKey, title: latest.content.header.title } : null,
        dimensions,
        plan: latest ? await planState(userId, latest) : null,
        streak: { ...streak, today },
        goals: await goals(userId, today, days, weakestDimensions(dimensions)),
        badges: BadgeKey.options.map((key) => {
          const award = awards.find((a) => a.badge === key);
          return { key, earned: Boolean(award), awardedAt: award ? iso(award.awardedAt) : null };
        }),
        drills: await deps.drills.quota(userId),
        recentDrills,
        totals: {
          interviews: interviews.length,
          drills: sessions.filter((s) => s.kind === 'DRILL').length,
        },
      };
    },

    async updateGoals(userId: string, body: UpdateGoalsBody, ctx: ClientContext) {
      const today = istDayOf(now());
      if (body.targetDate && body.targetDate < today) {
        throw AppError.validation('Choose a target date from today onwards.');
      }
      if (body.targetDate && daysBetween(today, body.targetDate) > 366) {
        throw AppError.validation('Choose a target date within the next year.');
      }
      await UserProgressModel.updateOne(
        { userId },
        { $set: { weeklyTarget: body.weeklyTarget, targetDate: body.targetDate } },
        { upsert: true },
      );
      await deps.audit.record(
        {
          actorType: 'USER',
          actorId: userId,
          action: 'progress.goals_updated',
          resourceType: 'user',
          resourceId: userId,
          details: { weeklyTarget: body.weeklyTarget, targetDate: body.targetDate },
        },
        ctx,
      );
      return this.overview(userId);
    },

    /** Ticks a plan item of a visible interview report revision done or undone. */
    async updatePlanItem(userId: string, body: UpdatePlanItemBody): Promise<PlanItemState> {
      const sessionId = objectId(body.sessionId, 'Report');
      const report = await InterviewReportModel.findOne(
        {
          userId,
          sessionId,
          revision: body.revision,
          kind: { $ne: 'DRILL' },
          'visibility.candidate': true,
        },
        { 'content.plan': 1, 'content.dimensions.key': 1, 'content.dimensions.name': 1 },
      ).lean<Pick<InterviewReportRecord, 'content'>>();
      const item = report ? planItems(report.content).find((i) => i.id === body.itemId) : null;
      if (!report || !item) throw AppError.notFound('Plan item not found');
      const at = now();
      const saved = await PlanItemProgressModel.findOneAndUpdate(
        { userId, sessionId, revision: body.revision, itemId: body.itemId },
        { $set: { done: body.done, doneAt: body.done ? at : null } },
        { upsert: true, returnDocument: 'after' },
      ).lean();
      return {
        id: item.id,
        bucket: item.bucket,
        action: item.action,
        why: item.why,
        dimensionKey: item.dimensionKey,
        dimensionName: item.dimensionKey
          ? (report.content.dimensions.find((d) => d.key === item.dimensionKey)?.name ?? null)
          : null,
        done: saved!.done,
        doneAt: saved!.done && saved!.doneAt ? iso(saved!.doneAt) : null,
      };
    },
  };
}

export type ProgressService = ReturnType<typeof createProgressService>;

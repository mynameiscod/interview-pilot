import type { Logger } from '@cbi/config';
import {
  DRILL_TEMPLATE_KEY,
  drillsStartedToday,
  InterviewEvidenceModel,
  InterviewReportModel,
  InterviewSessionModel,
  InterviewTemplateModel,
  InterviewTurnModel,
  RoleBlueprintModel,
  transitionSession,
  type InterviewReportRecord,
  type InterviewSessionRecord,
} from '@cbi/db';
import { drillDurationSec, drillRoundType } from '@cbi/interview-engine';
import type {
  CreateDrillBody,
  DrillQuota,
  DrillResult,
  InterviewState,
  PracticeSetting,
} from '@cbi/shared-types';
import type { AuditService } from '../../lib/audit.js';
import type { Types } from 'mongoose';
import { AppError } from '../../lib/errors.js';
import { iso, objectId } from '../../lib/ids.js';
import type { ClientContext } from '../../lib/request-context.js';

/** A drill created but not started yet; creating another replaces it. */
const UNSTARTED: InterviewState[] = ['READY', 'READY_TO_START'];

/** The latest candidate-visible report revision of a session. */
export async function visibleReport(userId: string, sessionId: Types.ObjectId) {
  return InterviewReportModel.findOne({ userId, sessionId, 'visibility.candidate': true })
    .sort({ revision: -1 })
    .lean<InterviewReportRecord>();
}

/**
 * Practice drills: three questions (the `practice` setting) on one competency
 * of the blueprint of the candidate's latest completed interview, run by the
 * live engine with the versioned drill template, evaluated without a PDF.
 * Free up to `drillsPerDay` per India-time day; the start refuses more.
 */
export function createDrillService(deps: {
  audit: AuditService;
  logger: Logger;
  practice: () => Promise<PracticeSetting>;
  now?: () => Date;
}) {
  const now = deps.now ?? (() => new Date());

  async function quota(userId: string): Promise<DrillQuota> {
    const setting = await deps.practice();
    const used = await drillsStartedToday(userId, now());
    return {
      freePerDay: setting.drillsPerDay,
      usedToday: used,
      remainingToday: Math.max(0, setting.drillsPerDay - used),
      questions: setting.drillQuestions,
    };
  }

  /** The interview whose blueprint drills use: the one named, else the latest completed. */
  async function sourceInterview(userId: string, sourceSessionId?: string) {
    const filter = {
      userId,
      kind: { $ne: 'DRILL' as const },
      state: 'REPORT_READY' as const,
      blueprintId: { $ne: null },
      ...(sourceSessionId ? { _id: objectId(sourceSessionId, 'Interview') } : {}),
    };
    const source = await InterviewSessionModel.findOne(filter)
      .sort({ endedAt: -1 })
      .lean<InterviewSessionRecord>();
    if (!source) {
      throw new AppError(
        409,
        'INVALID_STATE',
        'Finish an interview first: drills practise the skills from your latest interview.',
      );
    }
    return source;
  }

  return {
    quota,

    /** Creates (or reuses) a drill ready to start; the caller returns its summary. */
    async create(userId: string, body: CreateDrillBody, ctx: ClientContext) {
      const q = await quota(userId);
      if (q.freePerDay === 0) {
        throw new AppError(403, 'FEATURE_DISABLED', 'Practice drills are not available right now.');
      }
      if (q.remainingToday === 0) {
        throw new AppError(
          402,
          'DRILL_LIMIT_REACHED',
          "You have used today's free practice drills. More are free tomorrow.",
        );
      }
      const source = await sourceInterview(userId, body.sourceSessionId);
      const [blueprint, template] = await Promise.all([
        RoleBlueprintModel.findById(source.blueprintId, { content: 1 }).lean(),
        InterviewTemplateModel.findOne({ key: DRILL_TEMPLATE_KEY, status: 'ACTIVE' }).lean(),
      ]);
      const competency = blueprint?.content.competencies.find((c) => c.key === body.dimensionKey);
      if (!competency) {
        throw AppError.validation('That skill is not part of your latest interview.');
      }
      if (!template) throw AppError.notFound('Practice drills are not set up yet.');
      if (!template.content.modes.includes(body.mode)) {
        throw AppError.validation('That mode is not available for drills.');
      }

      // One unstarted drill at a time: the same one again is reused, any other is replaced.
      const unstarted = await InterviewSessionModel.find({
        userId,
        kind: 'DRILL',
        state: { $in: UNSTARTED },
      }).lean<InterviewSessionRecord[]>();
      const same = unstarted.find(
        (d) =>
          d.drill?.competencyKey === competency.key &&
          d.mode === body.mode &&
          String(d.drill.sourceSessionId) === String(source._id),
      );
      if (same) return same;
      for (const old of unstarted) {
        await transitionSession({
          sessionId: old._id,
          userId,
          from: old.state,
          to: 'CANCELLED',
          expectedVersion: old.stateVersion,
          reason: 'replaced by another drill',
        });
      }

      const round = template.content.rounds[0]!;
      const durationSec = drillDurationSec(round, q.questions);
      const drill = await InterviewSessionModel.create({
        userId,
        kind: 'DRILL',
        drill: {
          competencyKey: competency.key,
          competencyName: competency.name,
          sourceSessionId: source._id,
        },
        jobTargetId: source.jobTargetId,
        resumeId: source.resumeId,
        templateId: template._id,
        blueprintId: source.blueprintId,
        mode: body.mode,
        language: source.language,
        // The analysis is the source interview's; only the plan differs (one short round).
        analysis: source.analysis
          ? {
              ...source.analysis,
              plannedRounds: [
                { type: drillRoundType(competency), durationSec, focus: [competency.name] },
              ],
              totalDurationSec: durationSec,
            }
          : null,
        state: 'READY',
        stateHistory: [{ from: 'DRAFT', to: 'READY', at: now(), reason: 'drill created' }],
      });
      await deps.audit.record(
        {
          actorType: 'USER',
          actorId: userId,
          action: 'drill.created',
          resourceType: 'interviewSession',
          resourceId: String(drill._id),
          details: {
            competencyKey: competency.key,
            sourceSessionId: String(source._id),
            mode: body.mode,
            templateVersion: template.version,
          },
        },
        ctx,
      );
      return drill.toObject();
    },

    /** The drill's quick evaluation (the score appears once the report is built). */
    async result(userId: string, sessionId: string): Promise<DrillResult> {
      const s = await InterviewSessionModel.findOne({
        _id: objectId(sessionId, 'Drill'),
        userId,
        kind: 'DRILL',
      }).lean<InterviewSessionRecord>();
      if (!s?.drill) throw AppError.notFound('Drill not found');
      const key = s.drill.competencyKey;
      const [report, turns, evidence] = await Promise.all([
        visibleReport(userId, s._id),
        InterviewTurnModel.find(
          { sessionId: s._id },
          { seq: 1, questionId: 1, question: 1, answer: 1 },
        )
          .sort({ seq: 1 })
          .lean(),
        s.processing
          ? InterviewEvidenceModel.find(
              { sessionId: s._id, run: s.processing.run },
              { questionId: 1, claim: 1, strength: 1 },
            )
              .sort({ strength: -1 })
              .lean()
          : Promise.resolve([]),
      ]);
      const dimension = report?.content.dimensions.find((d) => d.key === key) ?? null;
      const previous = await previousScore(userId, s, report);
      return {
        sessionId: String(s._id),
        state: s.state,
        mode: s.mode,
        dimension: { key, name: s.drill.competencyName },
        score: dimension?.score ?? null,
        previousScore: previous,
        confidence: report?.content.overall.confidence.level ?? null,
        rationale: dimension?.rationale ?? null,
        questions: turns.map((t) => ({
          seq: t.seq,
          question: t.question.text,
          answered: Boolean(t.answer?.text.trim()),
          // Evidence is shown only once the report exists (evaluation is complete).
          feedback: report
            ? evidence
                .filter((e) => e.questionId === t.questionId)
                .map((e) => ({ claim: e.claim, strength: e.strength }))
            : [],
        })),
        completedAt: s.endedAt ? iso(s.endedAt) : null,
      };
    },
  };
}

/**
 * The dimension's latest score before this drill: from any earlier report
 * (interview or drill) that scored the same key.
 */
async function previousScore(
  userId: string,
  s: InterviewSessionRecord,
  report: InterviewReportRecord | null,
): Promise<number | null> {
  const before = report?.generatedAt ?? s.endedAt ?? s.createdAt;
  const earlier = await InterviewReportModel.find(
    {
      userId,
      sessionId: { $ne: s._id },
      'visibility.candidate': true,
      generatedAt: { $lt: before },
      'content.dimensions.key': s.drill!.competencyKey,
    },
    { 'content.dimensions.key': 1, 'content.dimensions.score': 1, generatedAt: 1 },
  )
    .sort({ generatedAt: -1, revision: -1 })
    .limit(10)
    .lean();
  for (const r of earlier) {
    const d = r.content.dimensions.find((x) => x.key === s.drill!.competencyKey);
    if (d?.score !== null && d?.score !== undefined) return d.score;
  }
  return null;
}

export type DrillService = ReturnType<typeof createDrillService>;

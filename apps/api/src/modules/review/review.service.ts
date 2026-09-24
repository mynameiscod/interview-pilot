import {
  AiUsageModel,
  CampaignModel,
  InterviewEvidenceModel,
  InterviewReportModel,
  InterviewScoreModel,
  InterviewSessionModel,
  InterviewTurnModel,
  JobTargetModel,
  mongoose,
  ReviewRevisionModel,
  UserModel,
  type InterviewReportRecord,
  type InterviewScoreRecord,
  type InterviewSessionRecord,
  type ScoreDimensionRecord,
} from '@cbi/db';
import { aggregate, readinessBand } from '@cbi/scoring-core';
import type {
  AdminInterviewDetail,
  AdminInterviewQuery,
  AdminInterviewRow,
  ReviewFlagBody,
  ReviseScoreBody,
  ScoreRevisionSummary,
} from '@cbi/shared-types';
import type { Logger } from '@cbi/config';
import type { AuditService } from '../../lib/audit.js';
import { AppError } from '../../lib/errors.js';
import { iso, objectId } from '../../lib/ids.js';
import type { JobQueues } from '../../lib/jobs.js';
import type { ClientContext } from '../../lib/request-context.js';
import { transaction } from '../../lib/transaction.js';

type Session = InterviewSessionRecord;

/**
 * A reviewer's revision of dimension scores. The overall score is the
 * weighted mean of the revised dimensions (the same weights as the AI
 * original); confidence describes the evidence, which a review does not
 * change, so it is carried over.
 */
export function reviseScore(
  latest: Pick<InterviewScoreRecord, 'dimensions'>,
  changes: ReviseScoreBody['dimensions'],
) {
  const byKey = new Map(changes.map((c) => [c.key, c]));
  for (const key of byKey.keys()) {
    if (!latest.dimensions.some((d) => d.key === key)) {
      throw AppError.validation(`Unknown dimension: ${key}`);
    }
  }
  const dimensions: ScoreDimensionRecord[] = latest.dimensions.map((d) => {
    const change = byKey.get(d.key);
    return change ? { ...d, score: change.score, reviewNote: change.note } : d;
  });
  const agg = aggregate(
    dimensions.map((d) => ({ key: d.key, category: d.category, weight: d.weight, score: d.score })),
    {},
  );
  return {
    dimensions,
    overall: agg.overall,
    band: readinessBand(agg.overall),
    assessedWeight: agg.assessedWeight,
    diff: latest.dimensions
      .filter((d) => byKey.has(d.key))
      .map((d) => ({
        key: d.key,
        from: d.score,
        to: byKey.get(d.key)!.score,
        note: byKey.get(d.key)!.note,
      })),
  };
}

const scoreSummary = (s: InterviewScoreRecord): ScoreRevisionSummary => ({
  revision: s.revision,
  overall: s.overall,
  band: s.band,
  dimensions: s.dimensions.map((d) => ({
    key: d.key,
    name: d.name,
    weight: d.weight,
    score: d.score,
    note: d.reviewNote ?? null,
  })),
  createdBy: String(s.createdBy),
  reason: s.reason,
  createdAt: iso(s.createdAt),
});

export function createReviewService(deps: {
  audit: AuditService;
  jobs: JobQueues;
  logger: Logger;
}) {
  const { audit, jobs, logger } = deps;

  async function rows(sessions: Session[]): Promise<AdminInterviewRow[]> {
    const ids = sessions.map((s) => s._id);
    const [users, campaigns, scores, targets] = await Promise.all([
      UserModel.find({ _id: { $in: sessions.map((s) => s.userId) } }, { primaryEmail: 1 }).lean(),
      CampaignModel.find(
        { _id: { $in: sessions.flatMap((s) => (s.campaignId ? [s.campaignId] : [])) } },
        { name: 1 },
      ).lean(),
      InterviewScoreModel.find(
        { sessionId: { $in: ids } },
        { sessionId: 1, revision: 1, overall: 1, band: 1 },
      )
        .sort({ revision: -1 })
        .lean(),
      JobTargetModel.find(
        { _id: { $in: sessions.map((s) => s.jobTargetId) } },
        { roleTitle: 1, 'structured.title': 1 },
      ).lean(),
    ]);
    const email = new Map(users.map((u) => [String(u._id), u.primaryEmail ?? null]));
    const campaign = new Map(campaigns.map((c) => [String(c._id), c.name]));
    const target = new Map(targets.map((t) => [String(t._id), t]));
    const score = new Map<string, (typeof scores)[number]>();
    for (const s of scores) if (!score.has(String(s.sessionId))) score.set(String(s.sessionId), s);
    return sessions.map((s) => {
      const sc = score.get(String(s._id));
      const t = target.get(String(s.jobTargetId));
      return {
        id: String(s._id),
        state: s.state,
        mode: s.mode,
        title:
          s.analysis?.detectedRole.title ??
          t?.roleTitle ??
          t?.structured?.title ??
          'Practice interview',
        candidate: { userId: String(s.userId), email: email.get(String(s.userId)) ?? null },
        campaign: s.campaignId
          ? { id: String(s.campaignId), name: campaign.get(String(s.campaignId)) ?? '' }
          : null,
        overall: sc?.overall ?? null,
        band: sc?.band ?? null,
        scoreRevision: sc?.revision ?? null,
        flag: {
          flagged: Boolean(s.review?.flagged),
          reason: s.review?.reason ?? null,
          by: s.review?.by ? String(s.review.by) : null,
          at: s.review?.at ? iso(s.review.at) : null,
        },
        startedAt: s.startedAt ? iso(s.startedAt) : null,
        endedAt: s.endedAt ? iso(s.endedAt) : null,
      };
    });
  }

  async function session(id: string) {
    const s = await InterviewSessionModel.findById(objectId(id, 'Interview')).lean<Session>();
    if (!s) throw AppError.notFound('Interview not found');
    return s;
  }

  return {
    async list(query: AdminInterviewQuery): Promise<AdminInterviewRow[]> {
      const filter: Record<string, unknown> = {};
      if (query.state) filter.state = query.state;
      if (query.campaignId) filter.campaignId = new mongoose.Types.ObjectId(query.campaignId);
      if (query.flagged !== undefined)
        filter['review.flagged'] = query.flagged ? true : { $ne: true };
      if (query.q) {
        const q = query.q.trim();
        if (/^[0-9a-f]{24}$/i.test(q)) {
          filter.$or = [{ _id: q }, { userId: q }];
        } else {
          const user = await UserModel.findOne(
            { primaryEmail: q.toLowerCase() },
            { _id: 1 },
          ).lean();
          if (!user) return [];
          filter.userId = user._id;
        }
      }
      const sessions = await InterviewSessionModel.find(filter)
        .sort({ createdAt: -1 })
        .limit(query.limit)
        .lean<Session[]>();
      return rows(sessions);
    },

    /** The full record for a reviewer; every view is audited (it shows a candidate's answers). */
    async detail(id: string, actorId: string, ctx: ClientContext): Promise<AdminInterviewDetail> {
      const s = await session(id);
      const [[row], turns, evidence, scores, reports, cost] = await Promise.all([
        rows([s]),
        InterviewTurnModel.find({ sessionId: s._id }).sort({ seq: 1 }).lean(),
        s.processing
          ? InterviewEvidenceModel.find({ sessionId: s._id, run: s.processing.run }).lean()
          : [],
        InterviewScoreModel.find({ sessionId: s._id })
          .sort({ revision: 1 })
          .lean<InterviewScoreRecord[]>(),
        InterviewReportModel.find({ sessionId: s._id }, { content: 0 })
          .sort({ revision: 1 })
          .lean<InterviewReportRecord[]>(),
        AiUsageModel.aggregate<{ total: number }>([
          { $match: { sessionId: String(s._id) } },
          { $group: { _id: null, total: { $sum: '$costMicros' } } },
        ]),
      ]);
      await audit.record(
        {
          actorType: 'ADMIN',
          actorId,
          action: 'interview.review_viewed',
          resourceType: 'interviewSession',
          resourceId: id,
        },
        ctx,
      );
      return {
        ...row!,
        turns: turns.map((t) => ({
          seq: t.seq,
          roundType: t.roundType,
          question: t.question.text,
          answer: t.answer?.text ?? null,
          answerSource: t.answer?.source ?? null,
          coding: Boolean(t.question.coding),
        })),
        evidence: evidence.map((e) => ({
          id: String(e._id),
          questionId: e.questionId,
          competencyKey: e.competencyKey,
          claim: e.claim,
          strength: e.strength,
          confidence: e.confidence,
          practical: e.practical,
          uncertainty: e.uncertainty,
        })),
        scoreRevisions: scores.map(scoreSummary),
        reportRevisions: reports.map((r) => ({
          revision: r.revision,
          scoreRevision: r.scoreRevision,
          candidateVisible: r.visibility.candidate,
          pdfStatus: r.pdf.status,
          generatedAt: iso(r.generatedAt),
        })),
        aiCostMicros: cost[0]?.total ?? 0,
      };
    },

    async flag(id: string, body: ReviewFlagBody, actorId: string, ctx: ClientContext) {
      const s = await session(id);
      await transaction(async (tx) => {
        await InterviewSessionModel.updateOne(
          { _id: s._id },
          {
            $set: {
              review: { flagged: body.flagged, reason: body.reason, by: actorId, at: new Date() },
            },
          },
          { session: tx },
        );
        await audit.record(
          {
            actorType: 'ADMIN',
            actorId,
            action: body.flagged ? 'interview.flagged' : 'interview.unflagged',
            resourceType: 'interviewSession',
            resourceId: id,
            details: { reason: body.reason },
          },
          ctx,
          tx,
        );
      });
      const [row] = await rows([(await session(id))!]);
      return row!;
    },

    /**
     * A manual review: score revision n+1 and report revision m+1 (with the
     * reviewer's note). Earlier revisions, the AI original included, never change.
     */
    async revise(id: string, body: ReviseScoreBody, actorId: string, ctx: ClientContext) {
      const s = await session(id);
      if (s.state !== 'REPORT_READY') {
        throw new AppError(409, 'INVALID_STATE', 'Only interviews with a report can be reviewed.');
      }
      const [latestScore, latestReport] = await Promise.all([
        InterviewScoreModel.findOne({ sessionId: s._id })
          .sort({ revision: -1 })
          .lean<InterviewScoreRecord>(),
        InterviewReportModel.findOne({ sessionId: s._id })
          .sort({ revision: -1 })
          .lean<InterviewReportRecord>(),
      ]);
      if (!latestScore || !latestReport) throw new Error(`score or report missing for ${id}`);
      const revised = reviseScore(latestScore, body.dimensions);
      const at = new Date();
      const scoreRevision = latestScore.revision + 1;
      const reportRevision = latestReport.revision + 1;
      const changed = new Map(revised.dimensions.map((d) => [d.key, d]));
      const content = {
        ...latestReport.content,
        review: { revision: reportRevision, reviewedAt: iso(at), note: body.reason },
        overall: {
          ...latestReport.content.overall,
          score: revised.overall,
          band: revised.band,
          assessedWeight: revised.assessedWeight,
        },
        dimensions: latestReport.content.dimensions.map((d) => ({
          ...d,
          score: changed.get(d.key)?.score ?? d.score,
        })),
      };
      try {
        await transaction(async (tx) => {
          await InterviewScoreModel.create(
            [
              {
                sessionId: s._id,
                userId: s.userId,
                revision: scoreRevision,
                dimensions: revised.dimensions,
                overall: revised.overall,
                band: revised.band,
                confidence: latestScore.confidence,
                assessedWeight: revised.assessedWeight,
                templateId: latestScore.templateId,
                promptVersions: latestScore.promptVersions,
                createdBy: new mongoose.Types.ObjectId(actorId),
                reason: body.reason,
              },
            ],
            { session: tx },
          );
          await InterviewReportModel.create(
            [
              {
                sessionId: s._id,
                userId: s.userId,
                revision: reportRevision,
                scoreRevision,
                content,
                visibility: { candidate: latestReport.visibility.candidate },
                roleKey: latestReport.roleKey,
                overall: revised.overall,
                generatedAt: at,
              },
            ],
            { session: tx },
          );
          await ReviewRevisionModel.create(
            [
              {
                sessionId: s._id,
                target: 'SCORE',
                fromRevision: latestScore.revision,
                toRevision: scoreRevision,
                reportRevision,
                reviewerId: actorId,
                reason: body.reason,
                changes: revised.diff,
                at,
              },
            ],
            { session: tx },
          );
          await audit.record(
            {
              actorType: 'ADMIN',
              actorId,
              action: 'interview.score_revised',
              resourceType: 'interviewSession',
              resourceId: id,
              details: {
                fromRevision: latestScore.revision,
                toRevision: scoreRevision,
                reportRevision,
                overall: { from: latestScore.overall, to: revised.overall },
                changes: revised.diff,
                reason: body.reason,
              },
            },
            ctx,
            tx,
          );
        });
      } catch (err) {
        if ((err as { code?: number }).code === 11000) {
          throw AppError.conflict('Someone else revised this interview. Refresh and try again.');
        }
        throw err;
      }
      // The revision is saved; its PDF follows (the JSON report does not wait for it).
      await jobs
        .renderReportPdf(id, reportRevision)
        .catch((err: unknown) => logger.error({ err, sessionId: id }, 'report pdf not queued'));
      const saved = await InterviewScoreModel.findOne({
        sessionId: s._id,
        revision: scoreRevision,
      }).lean<InterviewScoreRecord>();
      return scoreSummary(saved!);
    },
  };
}

export type ReviewService = ReturnType<typeof createReviewService>;

import {
  CampaignApplicationModel,
  CampaignModel,
  cohortAnalytics,
  cohortCsvLines,
  countOrgResults,
  campaignDimensions,
  enqueueOrgEvent,
  InterviewReportModel,
  InterviewSessionModel,
  InterviewTurnModel,
  OrgModel,
  OrgNoteModel,
  orgResultRow,
  orgResultsCsv,
  orgResultsPage,
  OrgScorecardModel,
  UserModel,
  UserProfileModel,
  type CampaignApplicationRecord,
  type CampaignRecord,
  type OrgRecord,
} from '@cbi/db';
import {
  DEFAULT_SCORECARD_CRITERIA,
  type BulkStageChangeResult,
  type CohortAnalytics,
  type CohortQuery,
  type NoteBody,
  type OrgCandidateDetail,
  type OrgNote,
  type OrgResults,
  type OrgResultsExportQuery,
  type OrgResultsQuery,
  type OrgScorecard,
  type ScorecardBody,
  type StageChangeBody,
} from '@cbi/shared-types';
import type { Types } from 'mongoose';
import type { AuditService } from '../../lib/audit.js';
import { AppError } from '../../lib/errors.js';
import { iso, objectId } from '../../lib/ids.js';
import type { ClientContext } from '../../lib/request-context.js';
import { transaction } from '../../lib/transaction.js';
import type { IdentityService } from './identity.service.js';

/** The signed-in org member acting on the pipeline. */
export interface OrgMemberActor {
  userId: string;
  orgId: string;
}

/**
 * `@mentions` in a note, as written (e.g. `@asha` or `@ravi@acme.com`).
 * They are stored as plain text next to the note: nothing is linked or
 * notified, so a mention can never reveal who is in the organisation.
 */
export function parseMentions(body: string): string[] {
  const found = body.match(/(?<![\w.])@[\w.+-]+(?:@[\w-]+(?:\.[\w-]+)+)?/g) ?? [];
  return [...new Set(found.map((m) => m.slice(1).replace(/[.]+$/, '')))].slice(0, 20);
}

/** Mean of a scorecard's ratings, to two decimals. */
export function scorecardAverage(ratings: Record<string, number>): number {
  const values = Object.values(ratings);
  return Math.round((values.reduce((a, b) => a + b, 0) / values.length) * 100) / 100;
}

/** Ratings must cover exactly the organisation's criteria. */
export function checkRatings(
  ratings: Record<string, number>,
  criteria: readonly { key: string }[],
): void {
  const keys = criteria.map((c) => c.key);
  const unknown = Object.keys(ratings).filter((k) => !keys.includes(k));
  if (unknown.length) throw AppError.validation(`Unknown criteria: ${unknown.join(', ')}`);
  const missing = keys.filter((k) => ratings[k] === undefined);
  if (missing.length) throw AppError.validation(`Rate every criterion: ${missing.join(', ')}`);
}

async function people(ids: Types.ObjectId[]) {
  const [users, profiles] = await Promise.all([
    UserModel.find({ _id: { $in: ids } }, { primaryEmail: 1 }).lean(),
    UserProfileModel.find({ userId: { $in: ids } }, { userId: 1, displayName: 1 }).lean(),
  ]);
  const email = new Map(users.map((u) => [String(u._id), u.primaryEmail ?? null]));
  const name = new Map(profiles.map((p) => [String(p.userId), p.displayName ?? null]));
  return (id: Types.ObjectId) => ({
    userId: String(id),
    name: name.get(String(id)) ?? null,
    email: email.get(String(id)) ?? null,
  });
}

/**
 * The org portal's candidate pipeline: results (only candidates who agreed
 * to share with the organisation), stages, notes, scorecards, the candidate
 * view as the campaign's employer view allows, and college cohort analytics.
 * Callers pass campaigns already loaded for the member's organisation; every
 * query here is further filtered by that campaign (and so that organisation).
 */
export function createPipelineService(deps: {
  audit: AuditService;
  identity: IdentityService;
  now?: () => Date;
}) {
  const { audit } = deps;
  const now = deps.now ?? (() => new Date());

  async function criteriaOf(orgId: CampaignRecord['orgId']) {
    const org = await OrgModel.findById(orgId, { scorecardCriteria: 1 }).lean<OrgRecord>();
    return org?.scorecardCriteria.length ? org.scorecardCriteria : DEFAULT_SCORECARD_CRITERIA;
  }

  /** A consented application of this campaign; anything else reads as missing. */
  async function applicationOf(campaign: CampaignRecord, applicationId: string) {
    const app = await CampaignApplicationModel.findOne({
      _id: objectId(applicationId, 'Candidate'),
      campaignId: campaign._id,
    }).lean<CampaignApplicationRecord>();
    if (!app) throw AppError.notFound('Candidate not found');
    const session = await InterviewSessionModel.findById(app.sessionId, { consents: 1 }).lean();
    const shared = (session?.consents ?? []).some(
      (c) => c.type === 'CAMPAIGN_SHARING' && c.accepted,
    );
    if (!shared) throw AppError.notFound('Candidate not found');
    return app;
  }

  async function notesOf(app: CampaignApplicationRecord): Promise<OrgNote[]> {
    const rows = await OrgNoteModel.find({ applicationId: app._id }).sort({ createdAt: 1 }).lean();
    const who = await people(rows.map((n) => n.authorId));
    return rows.map((n) => ({
      id: String(n._id),
      author: who(n.authorId),
      body: n.body,
      mentions: n.mentions,
      createdAt: iso(n.createdAt),
    }));
  }

  async function scorecardsOf(app: CampaignApplicationRecord): Promise<OrgScorecard[]> {
    const rows = await OrgScorecardModel.find({ applicationId: app._id })
      .sort({ updatedAt: 1 })
      .lean();
    const who = await people(rows.map((s) => s.reviewerId));
    return rows.map((s) => ({
      id: String(s._id),
      reviewer: who(s.reviewerId),
      ratings: s.ratings,
      average: s.average,
      recommendation: s.recommendation,
      comment: s.comment,
      updatedAt: iso(s.updatedAt),
    }));
  }

  return {
    applicationOf,

    async results(campaign: CampaignRecord, query: OrgResultsQuery): Promise<OrgResults> {
      return orgResultsPage(campaign, query);
    },

    /** The results CSV, streamed; audited with its row count (it carries personal data). */
    async exportCsv(
      campaign: CampaignRecord,
      query: OrgResultsExportQuery,
      actor: OrgMemberActor,
      ctx: ClientContext,
    ) {
      const dimensions = await campaignDimensions(campaign);
      const rows = await countOrgResults(campaign, dimensions, query);
      await audit.record(
        {
          actorType: 'ORG_MEMBER',
          actorId: actor.userId,
          action: 'org.results_exported',
          resourceType: 'campaign',
          resourceId: String(campaign._id),
          details: { orgId: actor.orgId, format: 'csv', rows, filters: query },
        },
        ctx,
      );
      return {
        chunks: orgResultsCsv(campaign, dimensions, query),
        fileName: `campaign-${String(campaign._id)}-candidates.csv`,
      };
    },

    /** One candidate; every view is audited, as it shows a candidate's answers. */
    async detail(
      campaign: CampaignRecord,
      applicationId: string,
      actor: OrgMemberActor,
      ctx: ClientContext,
    ): Promise<OrgCandidateDetail> {
      const app = await applicationOf(campaign, applicationId);
      const found = await orgResultRow(campaign, app._id);
      if (!found) throw AppError.notFound('Candidate not found');
      const full = (campaign.employerView ?? 'FULL_REPORT') === 'FULL_REPORT';
      const [report, turns, notes, scorecards, criteria, identity] = await Promise.all([
        full
          ? InterviewReportModel.findOne({ sessionId: app.sessionId }).sort({ revision: -1 }).lean()
          : null,
        full
          ? InterviewTurnModel.find(
              { sessionId: app.sessionId },
              { 'question.text': 1, 'answer.text': 1, seq: 1 },
            )
              .sort({ seq: 1 })
              .limit(200)
              .lean()
          : [],
        notesOf(app),
        scorecardsOf(app),
        criteriaOf(campaign.orgId),
        campaign.idCapture ? deps.identity.review(app) : null,
      ]);
      const stageHistory = (app.stageHistory ?? []).map((e) => ({
        from: e.from,
        to: e.to,
        by: String(e.by),
        note: e.note,
        at: iso(e.at),
      }));
      await audit.record(
        {
          actorType: 'ORG_MEMBER',
          actorId: actor.userId,
          action: 'org.candidate_viewed',
          resourceType: 'campaignApplication',
          resourceId: applicationId,
          details: { orgId: actor.orgId, campaignId: String(campaign._id) },
        },
        ctx,
      );
      return {
        row: found.row,
        employerView: campaign.employerView ?? 'FULL_REPORT',
        report: full
          ? {
              summary: report?.content.summary ?? null,
              strengths: (report?.content.strengths ?? []).map((s) => s.text),
              gaps: (report?.content.gaps ?? []).map((g) => g.text),
              transcript: turns.map((t) => ({
                question: t.question.text,
                answer: t.answer?.text ?? null,
              })),
            }
          : null,
        stageHistory,
        notes,
        scorecards,
        criteria: criteria.map((c) => ({ key: c.key, label: c.label })),
        identity,
      };
    },

    /**
     * Moves candidates to a stage (one or many). Only consented candidates of
     * this campaign move; each change is kept in the application's history,
     * audited, and sent to the organisation's webhooks.
     */
    async setStage(
      campaign: CampaignRecord,
      applicationIds: string[],
      body: StageChangeBody,
      actor: OrgMemberActor,
      ctx: ClientContext,
    ): Promise<BulkStageChangeResult> {
      const ids = [...new Set(applicationIds)].map((id) => objectId(id, 'Candidate'));
      const at = now();
      const changed = await transaction(async (tx) => {
        const apps = await CampaignApplicationModel.find(
          { _id: { $in: ids }, campaignId: campaign._id, stage: { $ne: body.stage } },
          { userId: 1, sessionId: 1, stage: 1 },
          { session: tx },
        ).lean();
        const sessions = await InterviewSessionModel.find(
          { _id: { $in: apps.map((a) => a.sessionId) } },
          { consents: 1 },
          { session: tx },
        ).lean();
        const consented = new Set(
          sessions
            .filter((s) =>
              (s.consents ?? []).some((c) => c.type === 'CAMPAIGN_SHARING' && c.accepted),
            )
            .map((s) => String(s._id)),
        );
        let count = 0;
        for (const app of apps) {
          if (!consented.has(String(app.sessionId))) continue;
          const from = app.stage ?? 'NEW';
          const moved = await CampaignApplicationModel.updateOne(
            { _id: app._id, campaignId: campaign._id, stage: app.stage },
            {
              $set: { stage: body.stage },
              $push: {
                stageHistory: {
                  from,
                  to: body.stage,
                  by: objectId(actor.userId, 'User'),
                  note: body.note,
                  at,
                },
              },
            },
            { session: tx },
          );
          if (moved.modifiedCount !== 1) continue;
          count++;
          await enqueueOrgEvent(
            campaign.orgId!,
            'candidate.stage_changed',
            {
              campaignId: String(campaign._id),
              applicationId: String(app._id),
              candidate: { userId: String(app.userId) },
              from,
              to: body.stage,
              at: at.toISOString(),
            },
            { session: tx, now: at },
          );
        }
        await audit.record(
          {
            actorType: 'ORG_MEMBER',
            actorId: actor.userId,
            action: 'org.stage_changed',
            resourceType: 'campaign',
            resourceId: String(campaign._id),
            details: {
              orgId: actor.orgId,
              stage: body.stage,
              requested: ids.length,
              changed: count,
              applicationIds: ids.slice(0, 50).map(String),
            },
          },
          ctx,
          tx,
        );
        return count;
      });
      return { changed };
    },

    async addNote(
      campaign: CampaignRecord,
      applicationId: string,
      body: NoteBody,
      actor: OrgMemberActor,
      ctx: ClientContext,
    ): Promise<OrgNote> {
      const app = await applicationOf(campaign, applicationId);
      const note = await transaction(async (tx) => {
        const [created] = await OrgNoteModel.create(
          [
            {
              orgId: campaign.orgId!,
              campaignId: campaign._id,
              applicationId: app._id,
              candidateId: app.userId,
              authorId: actor.userId,
              body: body.body,
              mentions: parseMentions(body.body),
            },
          ],
          { session: tx },
        );
        // The note itself is not copied to the audit log (it is the organisation's text).
        await audit.record(
          {
            actorType: 'ORG_MEMBER',
            actorId: actor.userId,
            action: 'org.note_added',
            resourceType: 'campaignApplication',
            resourceId: applicationId,
            details: { orgId: actor.orgId, noteId: String(created!._id) },
          },
          ctx,
          tx,
        );
        return created!;
      });
      const who = await people([note.authorId]);
      return {
        id: String(note._id),
        author: who(note.authorId),
        body: note.body,
        mentions: note.mentions,
        createdAt: iso(note.createdAt),
      };
    },

    /** Saves the reviewer's scorecard (one per reviewer per candidate; saving again replaces it). */
    async saveScorecard(
      campaign: CampaignRecord,
      applicationId: string,
      body: ScorecardBody,
      actor: OrgMemberActor,
      ctx: ClientContext,
    ): Promise<OrgScorecard> {
      const app = await applicationOf(campaign, applicationId);
      checkRatings(body.ratings, await criteriaOf(campaign.orgId));
      const average = scorecardAverage(body.ratings);
      const saved = await transaction(async (tx) => {
        const doc = await OrgScorecardModel.findOneAndUpdate(
          { applicationId: app._id, reviewerId: objectId(actor.userId, 'User') },
          {
            $set: {
              ratings: body.ratings,
              average,
              recommendation: body.recommendation,
              comment: body.comment,
            },
            $setOnInsert: {
              orgId: campaign.orgId!,
              campaignId: campaign._id,
              candidateId: app.userId,
            },
          },
          { upsert: true, returnDocument: 'after', session: tx },
        ).lean();
        await audit.record(
          {
            actorType: 'ORG_MEMBER',
            actorId: actor.userId,
            action: 'org.scorecard_saved',
            resourceType: 'campaignApplication',
            resourceId: applicationId,
            details: { orgId: actor.orgId, average, recommendation: body.recommendation },
          },
          ctx,
          tx,
        );
        return doc!;
      });
      const who = await people([saved.reviewerId]);
      return {
        id: String(saved._id),
        reviewer: who(saved.reviewerId),
        ratings: saved.ratings,
        average: saved.average,
        recommendation: saved.recommendation,
        comment: saved.comment,
        updatedAt: iso(saved.updatedAt),
      };
    },

    // ---- College cohort analytics ----------------------------------------------------------------

    async cohort(orgId: string, query: CohortQuery): Promise<CohortAnalytics> {
      const org = await OrgModel.findById(objectId(orgId, 'Organisation'), { type: 1 }).lean();
      if (org?.type !== 'COLLEGE') {
        throw AppError.forbidden('Cohort analytics are available to colleges.');
      }
      const campaigns = await CampaignModel.find(
        {
          orgId: org._id,
          ...(query.campaignId ? { _id: objectId(query.campaignId, 'Campaign') } : {}),
        },
        { _id: 1 },
      ).lean();
      if (query.campaignId && campaigns.length === 0) throw AppError.notFound('Campaign not found');
      return cohortAnalytics(
        org._id,
        campaigns.map((c) => c._id),
        { batch: query.batch, branch: query.branch, year: query.year },
      );
    },

    async cohortCsv(orgId: string, query: CohortQuery, actorId: string, ctx: ClientContext) {
      const analytics = await this.cohort(orgId, query);
      await audit.record(
        {
          actorType: 'ORG_MEMBER',
          actorId,
          action: 'org.cohort_exported',
          resourceType: 'org',
          resourceId: orgId,
          details: { rows: analytics.students.length, filters: query },
        },
        ctx,
      );
      return { lines: cohortCsvLines(analytics), fileName: 'cohort-readiness.csv' };
    },
  };
}

export type PipelineService = ReturnType<typeof createPipelineService>;

import { createHash, randomBytes } from 'node:crypto';
import type { Logger } from '@cbi/config';
import {
  CampaignApplicationModel,
  CampaignModel,
  CompanyModel,
  InterviewReportModel,
  InterviewScoreModel,
  InterviewSessionModel,
  InterviewTemplateModel,
  JobTargetModel,
  ResumeModel,
  RoleBlueprintModel,
  RoleModel,
  UserModel,
  UserProfileModel,
  type CampaignRecord,
  type InterviewScoreRecord,
  type InterviewSessionRecord,
} from '@cbi/db';
import type { StorageProvider } from '@cbi/provider-adapters';
import {
  AVAILABLE_INTERVIEW_MODES,
  templateDurationSec,
  type ApplicationStatus,
  type CampaignClosedReason,
  type CampaignResultRow,
  type CampaignResults,
  type CampaignResultsQuery,
  type CampaignStatus,
  type CampaignStatusBody,
  type CampaignSummary,
  type CampaignWithInvite,
  type CreateCampaignBody,
  type InterviewState,
  type JoinCampaignBody,
  type JoinCampaignResult,
  type PublicCampaign,
  type MaintenanceSetting,
  type UpdateCampaignBody,
} from '@cbi/shared-types';
import type { AuditService } from '../../lib/audit.js';
import { AppError } from '../../lib/errors.js';
import { iso, objectId } from '../../lib/ids.js';
import type { ClientContext } from '../../lib/request-context.js';
import { transaction } from '../../lib/transaction.js';
import { refuseDuringMaintenance } from '../../lib/maintenance.js';
import { buildZip, type ZipEntry } from '../../lib/zip.js';

/** Invite tokens: 144 random bits, URL-safe. Only the SHA-256 is stored. */
const newToken = () => randomBytes(18).toString('base64url');
const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');
const BOM = String.fromCharCode(0xfeff);
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;

/** Allowed status changes; CLOSED is final. */
const STATUS_MOVES: Record<CampaignStatus, CampaignStatus[]> = {
  DRAFT: ['ACTIVE', 'CLOSED'],
  ACTIVE: ['PAUSED', 'CLOSED'],
  PAUSED: ['ACTIVE', 'CLOSED'],
  CLOSED: [],
};

/** A package export holds every report; beyond this, use the CSV. */
export const MAX_PACKAGE_ROWS = 500;

const CLOSED_MESSAGES: Record<CampaignClosedReason, string> = {
  NOT_STARTED: 'This interview campaign has not opened yet.',
  ENDED: 'This interview campaign has ended.',
  PAUSED: 'This interview campaign is paused. Please try again later.',
  CLOSED: 'This interview campaign is closed.',
  FULL: 'This interview campaign has reached its maximum number of candidates.',
};

export function closedReason(c: CampaignRecord, now: Date): CampaignClosedReason | null {
  if (c.status === 'CLOSED' || c.status === 'DRAFT') return 'CLOSED';
  if (c.status === 'PAUSED') return 'PAUSED';
  if (now < c.window.startAt) return 'NOT_STARTED';
  if (c.window.endAt && now >= c.window.endAt) return 'ENDED';
  if (c.maxCandidates !== null && c.joinedCount >= c.maxCandidates) return 'FULL';
  return null;
}

const STARTABLE_STATES: InterviewState[] = [
  'DRAFT',
  'ROLE_ANALYSIS',
  'READY',
  'DEVICE_CHECK',
  'CONSENT_REQUIRED',
  'READY_TO_START',
];

export function applicationStatus(state: InterviewState): ApplicationStatus {
  if (STARTABLE_STATES.includes(state)) return 'JOINED';
  if (state === 'PROCESSING' || state === 'REPORT_READY') return 'COMPLETED';
  if (state === 'CANCELLED' || state === 'EXPIRED' || state === 'FAILED') return 'DID_NOT_FINISH';
  return 'IN_PROGRESS';
}

export function campaignSummary(c: CampaignRecord): CampaignSummary {
  return {
    id: String(c._id),
    name: c.name,
    status: c.status,
    companyId: c.companyId ? String(c.companyId) : null,
    companyName: c.companyName,
    role: { id: String(c.roleId), title: c.roleTitle },
    blueprint: { id: String(c.blueprintId), version: c.blueprintVersion },
    template: {
      id: String(c.templateId),
      key: c.templateKey,
      version: c.templateVersion,
      name: c.templateName,
    },
    jobDescription: c.jobDescription,
    modes: c.modes,
    languages: c.languages,
    window: { startAt: iso(c.window.startAt), endAt: c.window.endAt ? iso(c.window.endAt) : null },
    maxCandidates: c.maxCandidates,
    joined: c.joinedCount,
    proctoring: c.proctoring,
    candidateSeesReport: c.candidateSeesReport,
    sponsoredCredits: c.sponsoredCredits
      ? { total: c.sponsoredCredits.total, used: c.sponsoredCredits.used }
      : null,
    tokenHint: c.tokenHint,
    createdAt: iso(c.createdAt),
    updatedAt: iso(c.updatedAt),
  };
}

/** CSV cell: quoted, and text that a spreadsheet would run as a formula is neutralised. */
export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  let s = String(value);
  if (typeof value === 'string' && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40) || 'candidate';

interface Deps {
  audit: AuditService;
  logger: Logger;
  storage: StorageProvider;
  /** Starts role analysis for a new campaign interview (the interview service). */
  analyze: (userId: string, sessionId: string, ctx: ClientContext) => Promise<unknown>;
  /** Maintenance mode refuses new joins. */
  maintenance?: () => Promise<MaintenanceSetting>;
  now?: () => Date;
}

export function createCampaignService({
  audit,
  logger,
  storage,
  analyze,
  maintenance,
  now = () => new Date(),
}: Deps) {
  async function byId(id: string) {
    const c = await CampaignModel.findById(objectId(id, 'Campaign')).lean<CampaignRecord>();
    if (!c) throw AppError.notFound('Campaign not found');
    return c;
  }

  /** Draft campaigns are invisible to candidates; a bad token reads like a missing one. */
  async function byToken(token: string) {
    if (!TOKEN_PATTERN.test(token)) throw AppError.notFound('Campaign not found');
    const c = await CampaignModel.findOne({ tokenHash: hashToken(token) }).lean<CampaignRecord>();
    if (!c || c.status === 'DRAFT') throw AppError.notFound('Campaign not found');
    return c;
  }

  const invitePath = (token: string) => `/campaign/${token}`;

  async function results(id: string, query: CampaignResultsQuery): Promise<CampaignResults> {
    const c = await byId(id);
    const blueprint = await RoleBlueprintModel.findById(c.blueprintId, {
      'content.competencies': 1,
    }).lean();
    const dimensions = (blueprint?.content.competencies ?? []).map((d) => ({
      key: d.key,
      name: d.name,
    }));
    const apps = await CampaignApplicationModel.find({ campaignId: c._id })
      .sort({ joinedAt: 1 })
      .lean();
    const sessionIds = apps.map((a) => a.sessionId);
    const userIds = apps.map((a) => a.userId);
    const [sessions, scores, users, profiles] = await Promise.all([
      InterviewSessionModel.find(
        { _id: { $in: sessionIds } },
        { state: 1, endedAt: 1, review: 1 },
      ).lean<Pick<InterviewSessionRecord, '_id' | 'state' | 'endedAt' | 'review'>[]>(),
      InterviewScoreModel.find({ sessionId: { $in: sessionIds } })
        .sort({ revision: -1 })
        .lean<InterviewScoreRecord[]>(),
      UserModel.find({ _id: { $in: userIds } }, { primaryEmail: 1 }).lean(),
      UserProfileModel.find({ userId: { $in: userIds } }, { userId: 1, displayName: 1 }).lean(),
    ]);
    const sessionById = new Map(sessions.map((s) => [String(s._id), s]));
    const latestScore = new Map<string, InterviewScoreRecord>();
    for (const s of scores)
      if (!latestScore.has(String(s.sessionId))) latestScore.set(String(s.sessionId), s);
    const emailOf = new Map(users.map((u) => [String(u._id), u.primaryEmail ?? null]));
    const nameOf = new Map(profiles.map((p) => [String(p.userId), p.displayName ?? null]));

    let rows: CampaignResultRow[] = apps.map((a) => {
      const s = sessionById.get(String(a.sessionId));
      const score = latestScore.get(String(a.sessionId));
      return {
        applicationId: String(a._id),
        interviewId: s ? String(s._id) : null,
        candidate: {
          userId: String(a.userId),
          name: nameOf.get(String(a.userId)) ?? null,
          email: emailOf.get(String(a.userId)) ?? null,
        },
        status: s ? applicationStatus(s.state) : 'DID_NOT_FINISH',
        joinedAt: iso(a.joinedAt),
        completedAt: s?.endedAt ? iso(s.endedAt) : null,
        overall: score?.overall ?? null,
        band: score?.band ?? null,
        confidence: score?.confidence.level ?? null,
        scoreRevision: score?.revision ?? null,
        dimensions: Object.fromEntries(
          dimensions.map((d) => [
            d.key,
            score?.dimensions.find((x) => x.key === d.key)?.score ?? null,
          ]),
        ),
        flagged: Boolean(s?.review?.flagged),
      };
    });
    if (query.status) rows = rows.filter((r) => r.status === query.status);
    if (query.minOverall !== undefined)
      rows = rows.filter((r) => r.overall !== null && r.overall >= query.minOverall!);
    if (query.dimension) {
      const [key, min] = query.dimension.split(':') as [string, string];
      rows = rows.filter((r) => (r.dimensions[key] ?? -1) >= Number(min));
    }
    // Best first; unscored candidates last, in the order they joined.
    rows.sort((a, b) => (b.overall ?? -1) - (a.overall ?? -1));
    return { campaignId: String(c._id), dimensions, rows };
  }

  function toCsv(r: CampaignResults) {
    const header = [
      'Name',
      'Email',
      'Status',
      'Joined',
      'Completed',
      'Overall',
      'Band',
      'Confidence',
      'Score revision',
      'Flagged',
      ...r.dimensions.map((d) => d.name),
      'Interview id',
    ];
    const lines = r.rows.map((row) =>
      [
        row.candidate.name,
        row.candidate.email,
        row.status,
        row.joinedAt,
        row.completedAt,
        row.overall,
        row.band,
        row.confidence,
        row.scoreRevision,
        row.flagged ? 'yes' : 'no',
        ...r.dimensions.map((d) => row.dimensions[d.key]),
        row.interviewId,
      ]
        .map(csvCell)
        .join(','),
    );
    // BOM so spreadsheet apps read names in Hindi and Telugu correctly.
    return `${BOM}${[header.map(csvCell).join(','), ...lines].join('\r\n')}\r\n`;
  }

  return {
    // ---- Admin -------------------------------------------------------------------------------

    async list(): Promise<CampaignSummary[]> {
      const rows = await CampaignModel.find().sort({ createdAt: -1 }).limit(500).lean();
      return rows.map((c) => campaignSummary(c as CampaignRecord));
    },

    async get(id: string) {
      return campaignSummary(await byId(id));
    },

    async create(
      body: CreateCampaignBody,
      actorId: string,
      ctx: ClientContext,
    ): Promise<CampaignWithInvite> {
      const role = await RoleModel.findOne({
        _id: objectId(body.roleId, 'Role'),
        active: true,
      }).lean();
      if (!role) throw AppError.notFound('Role not found');
      const blueprint = role.activeBlueprintId
        ? await RoleBlueprintModel.findOne({ _id: role.activeBlueprintId, status: 'ACTIVE' }).lean()
        : null;
      if (!blueprint) {
        throw AppError.validation('This role has no active blueprint. Activate one first.');
      }
      const template = await InterviewTemplateModel.findOne({
        key: body.templateKey,
        status: 'ACTIVE',
      }).lean();
      if (!template) throw AppError.notFound('Interview type not found');
      const modes = [...new Set(body.modes)];
      const unavailable = modes.filter(
        (m) => !template.content.modes.includes(m) || !AVAILABLE_INTERVIEW_MODES.includes(m),
      );
      if (unavailable.length > 0) {
        throw AppError.validation(
          `This interview type does not offer: ${unavailable.join(', ').toLowerCase()}.`,
        );
      }
      if (
        body.companyId &&
        !(await CompanyModel.exists({ _id: objectId(body.companyId, 'Company') }))
      ) {
        throw AppError.notFound('Company not found');
      }
      const token = newToken();
      return transaction(async (tx) => {
        const [created] = await CampaignModel.create(
          [
            {
              name: body.name,
              status: 'DRAFT',
              companyId: body.companyId ?? null,
              companyName: body.companyName,
              roleId: role._id,
              roleTitle: role.title,
              blueprintId: blueprint._id,
              blueprintVersion: blueprint.version,
              templateId: template._id,
              templateKey: template.key,
              templateVersion: template.version,
              templateName: template.content.name,
              jobDescription: body.jobDescription || null,
              modes,
              languages: [...new Set(body.languages)],
              window: {
                startAt: new Date(body.window.startAt),
                endAt: body.window.endAt ? new Date(body.window.endAt) : null,
              },
              maxCandidates: body.maxCandidates,
              joinedCount: 0,
              proctoring: body.proctoring,
              candidateSeesReport: body.candidateSeesReport,
              sponsoredCredits: body.sponsoredCredits
                ? { total: body.sponsoredCredits, used: 0 }
                : null,
              tokenHash: hashToken(token),
              tokenHint: token.slice(0, 4),
              createdBy: actorId,
            },
          ],
          { session: tx },
        );
        await audit.record(
          {
            actorType: 'ADMIN',
            actorId,
            action: 'campaign.created',
            resourceType: 'campaign',
            resourceId: String(created!._id),
            details: {
              name: body.name,
              roleId: String(role._id),
              blueprintVersion: blueprint.version,
              templateKey: template.key,
              templateVersion: template.version,
              sponsoredCredits: body.sponsoredCredits,
            },
          },
          ctx,
          tx,
        );
        return {
          campaign: campaignSummary(created!.toObject() as CampaignRecord),
          invitePath: invitePath(token),
        };
      });
    },

    async update(id: string, body: UpdateCampaignBody, actorId: string, ctx: ClientContext) {
      const c = await byId(id);
      if (c.status === 'CLOSED')
        throw new AppError(409, 'INVALID_STATE', 'This campaign is closed.');
      if (body.maxCandidates !== null && body.maxCandidates < c.joinedCount) {
        throw AppError.validation(
          `The limit cannot be lower than the ${c.joinedCount} candidates who already joined.`,
        );
      }
      const used = c.sponsoredCredits?.used ?? 0;
      if ((body.sponsoredCredits ?? 0) < used) {
        throw AppError.validation(
          `Sponsored interviews cannot be fewer than the ${used} already used.`,
        );
      }
      return transaction(async (tx) => {
        const updated = await CampaignModel.findOneAndUpdate(
          // Conditional on the counters the checks above relied on.
          {
            _id: c._id,
            status: { $ne: 'CLOSED' },
            joinedCount: { $lte: body.maxCandidates ?? Number.MAX_SAFE_INTEGER },
            ...(c.sponsoredCredits ? { 'sponsoredCredits.used': used } : {}),
          },
          {
            $set: {
              name: body.name,
              companyName: body.companyName,
              jobDescription: body.jobDescription || null,
              window: {
                startAt: new Date(body.window.startAt),
                endAt: body.window.endAt ? new Date(body.window.endAt) : null,
              },
              maxCandidates: body.maxCandidates,
              candidateSeesReport: body.candidateSeesReport,
              sponsoredCredits: body.sponsoredCredits
                ? { total: body.sponsoredCredits, used }
                : null,
            },
          },
          { returnDocument: 'after', session: tx },
        ).lean<CampaignRecord>();
        if (!updated) throw AppError.conflict('This campaign changed. Refresh and try again.');
        await audit.record(
          {
            actorType: 'ADMIN',
            actorId,
            action: 'campaign.updated',
            resourceType: 'campaign',
            resourceId: id,
            details: {
              reason: body.reason,
              maxCandidates: body.maxCandidates,
              sponsoredCredits: body.sponsoredCredits,
              candidateSeesReport: body.candidateSeesReport,
              window: body.window,
            },
          },
          ctx,
          tx,
        );
        return campaignSummary(updated);
      });
    },

    async setStatus(id: string, body: CampaignStatusBody, actorId: string, ctx: ClientContext) {
      const c = await byId(id);
      if (c.status === body.status) return campaignSummary(c);
      if (!STATUS_MOVES[c.status].includes(body.status)) {
        throw new AppError(
          409,
          'INVALID_STATE',
          `A ${c.status.toLowerCase()} campaign cannot become ${body.status.toLowerCase()}.`,
        );
      }
      return transaction(async (tx) => {
        const updated = await CampaignModel.findOneAndUpdate(
          { _id: c._id, status: c.status },
          { $set: { status: body.status } },
          { returnDocument: 'after', session: tx },
        ).lean<CampaignRecord>();
        if (!updated) throw AppError.conflict('This campaign changed. Refresh and try again.');
        await audit.record(
          {
            actorType: 'ADMIN',
            actorId,
            action: 'campaign.status_changed',
            resourceType: 'campaign',
            resourceId: id,
            details: { from: c.status, to: body.status, reason: body.reason },
          },
          ctx,
          tx,
        );
        return campaignSummary(updated);
      });
    },

    /** A new invite link; the old one stops working at once. */
    async rotateInvite(
      id: string,
      reason: string,
      actorId: string,
      ctx: ClientContext,
    ): Promise<CampaignWithInvite> {
      const c = await byId(id);
      if (c.status === 'CLOSED')
        throw new AppError(409, 'INVALID_STATE', 'This campaign is closed.');
      const token = newToken();
      return transaction(async (tx) => {
        const updated = await CampaignModel.findOneAndUpdate(
          { _id: c._id, tokenHash: c.tokenHash },
          { $set: { tokenHash: hashToken(token), tokenHint: token.slice(0, 4) } },
          { returnDocument: 'after', session: tx },
        ).lean<CampaignRecord>();
        if (!updated) throw AppError.conflict('This campaign changed. Refresh and try again.');
        await audit.record(
          {
            actorType: 'ADMIN',
            actorId,
            action: 'campaign.invite_rotated',
            resourceType: 'campaign',
            resourceId: id,
            details: { reason },
          },
          ctx,
          tx,
        );
        return { campaign: campaignSummary(updated), invitePath: invitePath(token) };
      });
    },

    results,

    async exportCsv(id: string, query: CampaignResultsQuery, actorId: string, ctx: ClientContext) {
      const r = await results(id, query);
      await audit.record(
        {
          actorType: 'ADMIN',
          actorId,
          action: 'campaign.results_exported',
          resourceType: 'campaign',
          resourceId: id,
          details: { format: 'csv', rows: r.rows.length, filters: query },
        },
        ctx,
      );
      return { body: toCsv(r), fileName: `campaign-${id}-results.csv` };
    },

    /** results.csv, the campaign settings and each candidate's latest report (JSON, and PDF when ready). */
    async exportPackage(id: string, actorId: string, ctx: ClientContext) {
      const c = await byId(id);
      const r = await results(id, {});
      if (r.rows.length > MAX_PACKAGE_ROWS) {
        throw AppError.validation(
          `Packages hold up to ${MAX_PACKAGE_ROWS} candidates. Export the CSV instead.`,
        );
      }
      const entries: ZipEntry[] = [
        { name: 'results.csv', data: Buffer.from(toCsv(r), 'utf8') },
        { name: 'campaign.json', data: Buffer.from(JSON.stringify(campaignSummary(c), null, 2)) },
      ];
      const interviewIds = r.rows.flatMap((row) => (row.interviewId ? [row.interviewId] : []));
      const reports = await InterviewReportModel.find({ sessionId: { $in: interviewIds } })
        .sort({ revision: -1 })
        .lean();
      const latest = new Map<string, (typeof reports)[number]>();
      for (const rep of reports)
        if (!latest.has(String(rep.sessionId))) latest.set(String(rep.sessionId), rep);
      for (const row of r.rows) {
        const rep = row.interviewId ? latest.get(row.interviewId) : undefined;
        if (!rep) continue;
        const base = `reports/${slug(row.candidate.name ?? row.candidate.email ?? '')}-${row.interviewId}`;
        entries.push({
          name: `${base}.json`,
          data: Buffer.from(JSON.stringify({ revision: rep.revision, ...rep.content }, null, 2)),
        });
        if (rep.pdf.status === 'READY' && rep.pdf.storageKey) {
          try {
            entries.push({ name: `${base}.pdf`, data: await storage.get(rep.pdf.storageKey) });
          } catch (err) {
            logger.warn({ err, sessionId: row.interviewId }, 'report pdf missing from package');
          }
        }
      }
      await audit.record(
        {
          actorType: 'ADMIN',
          actorId,
          action: 'campaign.results_exported',
          resourceType: 'campaign',
          resourceId: id,
          details: { format: 'package', rows: r.rows.length, files: entries.length },
        },
        ctx,
      );
      return { body: buildZip(entries, now()), fileName: `campaign-${id}-package.zip` };
    },

    // ---- Candidates ----------------------------------------------------------------------------

    async publicView(token: string, userId: string | null): Promise<PublicCampaign> {
      const c = await byToken(token);
      const [blueprint, template, application] = await Promise.all([
        RoleBlueprintModel.findById(c.blueprintId, { 'content.competencies': 1 }).lean(),
        InterviewTemplateModel.findById(c.templateId).lean(),
        userId
          ? CampaignApplicationModel.findOne({ campaignId: c._id, userId }, { sessionId: 1 }).lean()
          : null,
      ]);
      return {
        name: c.name,
        companyName: c.companyName,
        roleTitle: c.roleTitle,
        assesses: (blueprint?.content.competencies ?? []).map((d) => d.name),
        totalDurationSec: template ? templateDurationSec(template.content) : 0,
        modes: c.modes,
        languages: c.languages,
        recording: c.proctoring.recording,
        observations: c.proctoring.tabSwitchTracking,
        candidateSeesReport: c.candidateSeesReport,
        sponsored: Boolean(
          c.sponsoredCredits && c.sponsoredCredits.used < c.sponsoredCredits.total,
        ),
        window: {
          startAt: iso(c.window.startAt),
          endAt: c.window.endAt ? iso(c.window.endAt) : null,
        },
        closedReason: closedReason(c, now()),
        joinedInterviewId: application ? String(application.sessionId) : null,
      };
    },

    /**
     * Joins a campaign: one interview per candidate (joining again returns
     * it), counted atomically against the campaign's limit.
     */
    async join(
      userId: string,
      token: string,
      body: JoinCampaignBody,
      ctx: ClientContext,
    ): Promise<JoinCampaignResult> {
      const c = await byToken(token);
      const existing = async () =>
        CampaignApplicationModel.findOne({ campaignId: c._id, userId }, { sessionId: 1 }).lean();
      const before = await existing();
      if (before) return { interviewId: String(before.sessionId), created: false };
      await refuseDuringMaintenance(maintenance);
      const reason = closedReason(c, now());
      if (reason) throw new AppError(409, 'CAMPAIGN_CLOSED', CLOSED_MESSAGES[reason]);
      if (body.resumeId) {
        const resume = await ResumeModel.findOne(
          { _id: objectId(body.resumeId, 'Resume'), userId },
          { extraction: 1 },
        ).lean();
        if (!resume) throw AppError.notFound('Resume not found');
        if (resume.extraction.status === 'FAILED') {
          throw new AppError(
            409,
            'INVALID_STATE',
            'We could not read this resume. Upload a different file or continue without one.',
          );
        }
      }
      const template = await InterviewTemplateModel.findById(c.templateId).lean();
      if (!template) throw new Error(`campaign ${String(c._id)} template missing`);
      const profile = await UserProfileModel.findOne(
        { userId },
        { preferredInterviewLanguage: 1 },
      ).lean();
      const preferred = profile?.preferredInterviewLanguage;
      const language = preferred && c.languages.includes(preferred) ? preferred : c.languages[0]!;
      const mode =
        c.modes.find(
          (m) => template.content.modes.includes(m) && AVAILABLE_INTERVIEW_MODES.includes(m),
        ) ?? c.modes[0]!;

      let sessionId: string;
      try {
        sessionId = await transaction(async (tx) => {
          const at = now();
          const claimed = await CampaignModel.findOneAndUpdate(
            {
              _id: c._id,
              status: 'ACTIVE',
              'window.startAt': { $lte: at },
              $and: [
                { $or: [{ 'window.endAt': null }, { 'window.endAt': { $gt: at } }] },
                {
                  $or: [
                    { maxCandidates: null },
                    { $expr: { $lt: ['$joinedCount', '$maxCandidates'] } },
                  ],
                },
              ],
            },
            { $inc: { joinedCount: 1 } },
            { returnDocument: 'after', session: tx, projection: { _id: 1 } },
          ).lean();
          if (!claimed) {
            const fresh = await CampaignModel.findById(c._id, null, {
              session: tx,
            }).lean<CampaignRecord>();
            const why = (fresh && closedReason(fresh, at)) ?? 'CLOSED';
            throw new AppError(409, 'CAMPAIGN_CLOSED', CLOSED_MESSAGES[why]);
          }
          const [target] = await JobTargetModel.create(
            [
              {
                userId,
                source: c.jobDescription ? 'PASTE' : 'ROLE_ONLY',
                rawText: c.jobDescription,
                companyId: c.companyId,
                companyName: c.companyName,
                roleId: c.roleId,
                roleTitle: c.roleTitle,
                // The campaign's description is used as written: nothing to extract.
                extraction: {
                  status: 'READY',
                  parser: 'none',
                  charCount: c.jobDescription?.length ?? 0,
                  completedAt: at,
                },
              },
            ],
            { session: tx },
          );
          const [session] = await InterviewSessionModel.create(
            [
              {
                userId,
                jobTargetId: target!._id,
                resumeId: body.resumeId ? objectId(body.resumeId, 'Resume') : null,
                templateId: c.templateId,
                mode,
                language,
                state: 'DRAFT',
                campaignId: c._id,
              },
            ],
            { session: tx },
          );
          await CampaignApplicationModel.create(
            [{ campaignId: c._id, userId, sessionId: session!._id, joinedAt: at }],
            { session: tx },
          );
          await audit.record(
            {
              actorType: 'USER',
              actorId: userId,
              action: 'campaign.joined',
              resourceType: 'campaign',
              resourceId: String(c._id),
              details: { interviewId: String(session!._id) },
            },
            ctx,
            tx,
          );
          return String(session!._id);
        });
      } catch (err) {
        // The same candidate joined in a parallel request: return that interview.
        if ((err as { code?: number }).code === 11000) {
          const after = await existing();
          if (after) return { interviewId: String(after.sessionId), created: false };
        }
        throw err;
      }
      // Analysis uses the campaign's pinned blueprint; a failed enqueue can be retried from the interview.
      await analyze(userId, sessionId, ctx).catch((err: unknown) =>
        logger.warn({ err, sessionId }, 'campaign interview analysis not started'),
      );
      return { interviewId: sessionId, created: true };
    },
  };
}

export type CampaignService = ReturnType<typeof createCampaignService>;

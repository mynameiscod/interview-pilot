import { createHash, randomBytes } from 'node:crypto';
import type { Logger } from '@cbi/config';
import type { Readable } from 'node:stream';
import {
  AuthIdentityModel,
  CAMPAIGN_EXPORT_STUCK_AFTER_MS,
  CampaignApplicationModel,
  CampaignInviteModel,
  CampaignExportModel,
  CampaignModel,
  campaignDimensions,
  campaignResultsCsv,
  campaignResultsPage,
  campaignSummary,
  CompanyModel,
  countCampaignResults,
  InterviewSessionModel,
  InterviewTemplateModel,
  JobTargetModel,
  MAX_PACKAGE_ROWS,
  OrgModel,
  ResumeModel,
  RoleBlueprintModel,
  RoleModel,
  UserModel,
  UserProfileModel,
  type CampaignExportRecord,
  type CampaignInviteRecord,
  type CampaignRecord,
} from '@cbi/db';
import type { ClientSession } from 'mongoose';
import { StorageNotFoundError, type StorageProvider } from '@cbi/provider-adapters';
import {
  AVAILABLE_INTERVIEW_MODES,
  templateDurationSec,
  type CampaignClosedReason,
  type CampaignExport,
  type CampaignListPage,
  type CampaignListQuery,
  type CampaignResults,
  type CampaignResultsExportQuery,
  type CampaignResultsQuery,
  type CampaignStatus,
  type CampaignStatusBody,
  type CampaignWithInvite,
  type CreateCampaignBody,
  type JoinCampaignBody,
  type JoinCampaignResult,
  type PublicCampaign,
  type MaintenanceSetting,
  type UpdateCampaignBody,
} from '@cbi/shared-types';
import { maskEmail } from '@cbi/auth-core';
import type { AuditService } from '../../lib/audit.js';
import { AppError } from '../../lib/errors.js';
import { iso, objectId } from '../../lib/ids.js';
import type { ClientContext } from '../../lib/request-context.js';
import { transaction } from '../../lib/transaction.js';
import { refuseDuringMaintenance } from '../../lib/maintenance.js';
import type { JobQueues } from '../../lib/jobs.js';

/** Invite tokens: 144 random bits, URL-safe. Only the SHA-256 is stored. */
export const newToken = () => randomBytes(18).toString('base64url');
export const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');
export const TOKEN_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;

/**
 * Who is acting on campaigns: CodeBegun admins see and change every campaign;
 * an organisation's members only their own (every query is filtered by it).
 */
export type CampaignScope = { orgId: string } | null;

const actorTypeOf = (scope: CampaignScope) =>
  scope ? ('ORG_MEMBER' as const) : ('ADMIN' as const);

/** The organisation's interview quota is used up (an org campaign join). */
const QUOTA_MESSAGE =
  'This organisation cannot accept more candidates right now. Please contact them.';

/** Allowed status changes; CLOSED is final. */
const STATUS_MOVES: Record<CampaignStatus, CampaignStatus[]> = {
  DRAFT: ['ACTIVE', 'CLOSED'],
  ACTIVE: ['PAUSED', 'CLOSED'],
  PAUSED: ['ACTIVE', 'CLOSED'],
  CLOSED: [],
};

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

/** An export as the admin console sees it (the download path only while the file exists). */
export function campaignExportView(e: CampaignExportRecord): CampaignExport {
  const campaignId = String(e.campaignId);
  const id = String(e._id);
  return {
    id,
    campaignId,
    status: e.status,
    progress: { done: e.progress.done, total: e.progress.total },
    fileName: e.fileName,
    sizeBytes: e.sizeBytes,
    error: e.error,
    requestedBy: String(e.requestedBy),
    createdAt: iso(e.createdAt),
    completedAt: e.completedAt ? iso(e.completedAt) : null,
    expiresAt: e.status === 'READY' ? iso(e.expiresAt) : null,
    downloadPath:
      e.status === 'READY' ? `/admin/campaigns/${campaignId}/exports/${id}/download` : null,
  };
}

interface Deps {
  audit: AuditService;
  logger: Logger;
  storage: StorageProvider;
  /** Package exports are built by the worker. */
  jobs: Pick<JobQueues, 'exportCampaignPackage'>;
  /** Starts role analysis for a new campaign interview (the interview service). */
  analyze: (userId: string, sessionId: string, ctx: ClientContext) => Promise<unknown>;
  /** Maintenance mode refuses new joins. */
  maintenance?: () => Promise<MaintenanceSetting>;
  now?: () => Date;
}

/**
 * The email addresses a candidate has proved they own: the verified primary
 * email and every email (or Google) identity. Invites are matched on these.
 */
export async function verifiedEmails(userId: string): Promise<string[]> {
  const [user, identities] = await Promise.all([
    UserModel.findById(userId, { primaryEmail: 1, emailVerifiedAt: 1 }).lean(),
    AuthIdentityModel.find(
      { userId, provider: { $in: ['EMAIL', 'GOOGLE'] } },
      { provider: 1, subject: 1, email: 1 },
    ).lean(),
  ]);
  const emails = new Set<string>();
  if (user?.primaryEmail && user.emailVerifiedAt) emails.add(user.primaryEmail.toLowerCase());
  for (const i of identities) {
    const email = i.provider === 'EMAIL' ? i.subject : i.email;
    if (email) emails.add(email.toLowerCase());
  }
  return [...emails];
}

/**
 * Moves sponsored interviews between an organisation's wallet and one of its
 * campaigns: a positive delta takes them from the wallet (only if the
 * balance covers it, atomically), a negative one gives them back.
 */
export async function moveWalletCredits(
  orgId: CampaignRecord['orgId'],
  delta: number,
  session: ClientSession,
) {
  if (!orgId || delta === 0) return;
  const moved = await OrgModel.updateOne(
    delta > 0 ? { _id: orgId, 'wallet.balance': { $gte: delta } } : { _id: orgId },
    { $inc: { 'wallet.balance': -delta, 'wallet.allocated': delta } },
    { session },
  );
  if (moved.modifiedCount !== 1) {
    throw new AppError(
      402,
      'INSUFFICIENT_CREDITS',
      'The organisation wallet does not have enough sponsored interviews.',
    );
  }
}

export function createCampaignService({
  audit,
  logger,
  storage,
  jobs,
  analyze,
  maintenance,
  now = () => new Date(),
}: Deps) {
  async function byId(id: string, scope: CampaignScope = null) {
    const c = await CampaignModel.findOne({
      _id: objectId(id, 'Campaign'),
      ...(scope ? { orgId: objectId(scope.orgId, 'Campaign') } : {}),
    }).lean<CampaignRecord>();
    // Another organisation's campaign reads exactly like a missing one.
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

  /** One page of the grid: filtering, sorting and paging all run in MongoDB. */
  async function results(id: string, query: CampaignResultsQuery): Promise<CampaignResults> {
    return campaignResultsPage(await byId(id), query);
  }

  async function exportById(campaignId: string, exportId: string) {
    const e = await CampaignExportModel.findOne({
      _id: objectId(exportId, 'Export'),
      campaignId: objectId(campaignId, 'Campaign'),
    }).lean<CampaignExportRecord>();
    if (!e) throw AppError.notFound('Export not found');
    return e;
  }

  return {
    // ---- Admin -------------------------------------------------------------------------------

    byId,

    async list(query: CampaignListQuery, scope: CampaignScope = null): Promise<CampaignListPage> {
      const filter = {
        ...(query.status ? { status: query.status } : {}),
        ...(scope ? { orgId: objectId(scope.orgId, 'Organisation') } : {}),
      };
      const [rows, total] = await Promise.all([
        CampaignModel.find(filter)
          .sort({ createdAt: -1, _id: -1 })
          .skip((query.page - 1) * query.pageSize)
          .limit(query.pageSize)
          .lean<CampaignRecord[]>(),
        CampaignModel.countDocuments(filter),
      ]);
      return {
        items: rows.map(campaignSummary),
        total,
        page: query.page,
        pageSize: query.pageSize,
      };
    },

    async get(id: string, scope: CampaignScope = null) {
      return campaignSummary(await byId(id, scope));
    },

    async create(
      body: CreateCampaignBody,
      actorId: string,
      ctx: ClientContext,
      scope: CampaignScope = null,
    ): Promise<CampaignWithInvite> {
      if (scope) {
        const org = await OrgModel.findById(objectId(scope.orgId, 'Organisation'), {
          status: 1,
        }).lean();
        if (!org || org.status !== 'ACTIVE') throw AppError.forbidden();
      }
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
      const orgId = scope ? objectId(scope.orgId, 'Organisation') : null;
      return transaction(async (tx) => {
        // An organisation's sponsored budget comes out of its wallet.
        await moveWalletCredits(orgId, body.sponsoredCredits ?? 0, tx);
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
              orgId,
              requireInvite: body.requireInvite,
              employerView: body.employerView,
              idCapture: body.idCapture,
              reminders: body.reminders,
              createdBy: actorId,
            },
          ],
          { session: tx },
        );
        await audit.record(
          {
            actorType: actorTypeOf(scope),
            actorId,
            action: 'campaign.created',
            resourceType: 'campaign',
            resourceId: String(created!._id),
            details: {
              orgId: scope?.orgId,
              requireInvite: body.requireInvite,
              employerView: body.employerView,
              idCapture: body.idCapture,
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

    async update(
      id: string,
      body: UpdateCampaignBody,
      actorId: string,
      ctx: ClientContext,
      scope: CampaignScope = null,
    ) {
      const c = await byId(id, scope);
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
        // Raising an organisation's budget draws on its wallet; lowering it gives units back.
        await moveWalletCredits(
          c.orgId,
          (body.sponsoredCredits ?? 0) - (c.sponsoredCredits?.total ?? 0),
          tx,
        );
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
              ...(body.reminders ? { reminders: body.reminders } : {}),
            },
          },
          { returnDocument: 'after', session: tx },
        ).lean<CampaignRecord>();
        if (!updated) throw AppError.conflict('This campaign changed. Refresh and try again.');
        await audit.record(
          {
            actorType: actorTypeOf(scope),
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

    async setStatus(
      id: string,
      body: CampaignStatusBody,
      actorId: string,
      ctx: ClientContext,
      scope: CampaignScope = null,
    ) {
      const c = await byId(id, scope);
      if (c.status === body.status) return campaignSummary(c);
      if (!STATUS_MOVES[c.status].includes(body.status)) {
        throw new AppError(
          409,
          'INVALID_STATE',
          `A ${c.status.toLowerCase()} campaign cannot become ${body.status.toLowerCase()}.`,
        );
      }
      return transaction(async (tx) => {
        // Closing an organisation's campaign returns its unused sponsored interviews to the wallet.
        const unused =
          body.status === 'CLOSED' && c.orgId && c.sponsoredCredits
            ? c.sponsoredCredits.total - c.sponsoredCredits.used
            : 0;
        const updated = await CampaignModel.findOneAndUpdate(
          {
            _id: c._id,
            status: c.status,
            ...(unused > 0 ? { 'sponsoredCredits.used': c.sponsoredCredits!.used } : {}),
          },
          {
            $set: {
              status: body.status,
              ...(unused > 0 ? { 'sponsoredCredits.total': c.sponsoredCredits!.used } : {}),
            },
          },
          { returnDocument: 'after', session: tx },
        ).lean<CampaignRecord>();
        if (!updated) throw AppError.conflict('This campaign changed. Refresh and try again.');
        if (unused > 0) await moveWalletCredits(c.orgId, -unused, tx);
        if (body.status === 'CLOSED') {
          // No more invite emails or reminders for a closed campaign.
          await CampaignInviteModel.updateMany(
            { campaignId: c._id, nextSendAt: { $ne: null } },
            { $set: { nextSendAt: null } },
            { session: tx },
          );
        }
        await audit.record(
          {
            actorType: actorTypeOf(scope),
            actorId,
            action: 'campaign.status_changed',
            resourceType: 'campaign',
            resourceId: id,
            details: {
              from: c.status,
              to: body.status,
              reason: body.reason,
              ...(unused > 0 ? { returnedToWallet: unused } : {}),
            },
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
      scope: CampaignScope = null,
    ): Promise<CampaignWithInvite> {
      const c = await byId(id, scope);
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
            actorType: actorTypeOf(scope),
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

    /**
     * Audits the export, then hands back the CSV as a stream of chunks read
     * from a MongoDB cursor (the route writes them as they come).
     */
    async exportCsv(
      id: string,
      query: CampaignResultsExportQuery,
      actorId: string,
      ctx: ClientContext,
    ): Promise<{ chunks: AsyncIterable<string>; fileName: string }> {
      const c = await byId(id);
      const dimensions = await campaignDimensions(c);
      const rows = await countCampaignResults(c, dimensions, query);
      await audit.record(
        {
          actorType: 'ADMIN',
          actorId,
          action: 'campaign.results_exported',
          resourceType: 'campaign',
          resourceId: id,
          details: { format: 'csv', rows, filters: query },
        },
        ctx,
      );
      return {
        chunks: campaignResultsCsv(c, dimensions, query),
        fileName: `campaign-${id}-results.csv`,
      };
    },

    /**
     * Starts a package export (results.csv, the campaign settings and each
     * candidate's latest report, JSON and PDF), built by the worker. While one
     * is queued or running for the campaign, that one is returned instead.
     */
    async startExport(id: string, actorId: string, ctx: ClientContext): Promise<CampaignExport> {
      const c = await byId(id);
      const active = await CampaignExportModel.findOne({
        campaignId: c._id,
        status: { $in: ['QUEUED', 'RUNNING'] },
      })
        .sort({ createdAt: -1 })
        .lean<CampaignExportRecord>();
      if (active) return campaignExportView(active);
      const rows = await CampaignApplicationModel.countDocuments({ campaignId: c._id });
      if (rows > MAX_PACKAGE_ROWS) {
        throw AppError.validation(
          `Packages hold up to ${MAX_PACKAGE_ROWS} candidates. Export the CSV instead.`,
        );
      }
      const created = await CampaignExportModel.create({
        campaignId: c._id,
        requestedBy: actorId,
        status: 'QUEUED',
        progress: { done: 0, total: rows },
        fileName: `campaign-${id}-package.zip`,
        // Given up as stuck if the worker has not finished by then.
        expiresAt: new Date(now().getTime() + CAMPAIGN_EXPORT_STUCK_AFTER_MS),
      });
      const exportId = String(created._id);
      try {
        await jobs.exportCampaignPackage(exportId);
      } catch (err) {
        logger.error({ err, exportId }, 'campaign package not queued');
        await CampaignExportModel.updateOne(
          { _id: created._id },
          {
            $set: {
              status: 'FAILED',
              error: 'The export could not be started.',
              completedAt: now(),
              expiresAt: now(),
            },
          },
        );
        throw new AppError(503, 'SERVICE_UNAVAILABLE', 'Exports are unavailable. Try again later.');
      }
      await audit.record(
        {
          actorType: 'ADMIN',
          actorId,
          action: 'campaign.results_exported',
          resourceType: 'campaign',
          resourceId: id,
          details: { format: 'package', rows, exportId },
        },
        ctx,
      );
      return campaignExportView(created.toObject() as CampaignExportRecord);
    },

    async exportStatus(id: string, exportId: string): Promise<CampaignExport> {
      return campaignExportView(await exportById(id, exportId));
    },

    /** Streams a finished package from storage; each download is audited. */
    async openExport(
      id: string,
      exportId: string,
      actorId: string,
      ctx: ClientContext,
    ): Promise<{ stream: Readable; fileName: string; sizeBytes: number | null }> {
      const e = await exportById(id, exportId);
      if (e.status !== 'READY' || !e.storageKey || e.expiresAt <= now()) {
        throw new AppError(409, 'INVALID_STATE', 'This export is not ready or has expired.');
      }
      let stream: Readable;
      try {
        stream = await storage.getStream(e.storageKey);
      } catch (err) {
        if (err instanceof StorageNotFoundError) throw AppError.notFound('Export file not found');
        throw err;
      }
      await audit.record(
        {
          actorType: 'ADMIN',
          actorId,
          action: 'campaign.export_downloaded',
          resourceType: 'campaign',
          resourceId: id,
          details: { exportId, sizeBytes: e.sizeBytes },
        },
        ctx,
      );
      return { stream, fileName: e.fileName, sizeBytes: e.sizeBytes };
    },

    // ---- Candidates ----------------------------------------------------------------------------

    async publicView(token: string, userId: string | null): Promise<PublicCampaign> {
      return publicViewOf(await byToken(token), userId);
    },

    /**
     * An invite link (`/campaign/i/<token>`): the same landing page. The
     * first visit marks the invite OPENED. Revoked and unknown invites read
     * like a missing campaign.
     */
    async publicViewByInvite(token: string, userId: string | null): Promise<PublicCampaign> {
      const { campaign, invite } = await byInviteToken(token);
      if (invite.status === 'SENT' || invite.status === 'PENDING') {
        await CampaignInviteModel.updateOne(
          { _id: invite._id, status: { $in: ['SENT', 'PENDING'] } },
          { $set: { status: 'OPENED', openedAt: now() } },
        );
      }
      return publicViewOf(campaign, userId);
    },

    /**
     * Joins a campaign: one interview per candidate (joining again returns
     * it), counted atomically against the campaign's limit and, for an
     * organisation's campaign, its interview quota.
     */
    async join(
      userId: string,
      token: string,
      body: JoinCampaignBody,
      ctx: ClientContext,
    ): Promise<JoinCampaignResult> {
      return joinCampaign(await byToken(token), null, userId, body, ctx);
    },

    /** Joins through a personal invite link. */
    async joinByInvite(
      userId: string,
      token: string,
      body: JoinCampaignBody,
      ctx: ClientContext,
    ): Promise<JoinCampaignResult> {
      const { campaign, invite } = await byInviteToken(token);
      return joinCampaign(campaign, invite, userId, body, ctx);
    },
  };

  async function publicViewOf(c: CampaignRecord, userId: string | null): Promise<PublicCampaign> {
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
      sponsored: Boolean(c.sponsoredCredits && c.sponsoredCredits.used < c.sponsoredCredits.total),
      window: {
        startAt: iso(c.window.startAt),
        endAt: c.window.endAt ? iso(c.window.endAt) : null,
      },
      closedReason: closedReason(c, now()),
      joinedInterviewId: application ? String(application.sessionId) : null,
      inviteOnly: c.requireInvite ?? false,
      employerView: c.employerView ?? 'FULL_REPORT',
      idCapture: c.idCapture ?? false,
    };
  }

  /** A personal invite and its campaign; revoked, unknown and draft ones answer 404 alike. */
  async function byInviteToken(token: string) {
    if (!TOKEN_PATTERN.test(token)) throw AppError.notFound('Campaign not found');
    const invite = await CampaignInviteModel.findOne({
      tokenHash: hashToken(token),
    }).lean<CampaignInviteRecord>();
    if (!invite || invite.status === 'REVOKED') throw AppError.notFound('Campaign not found');
    const campaign = await CampaignModel.findById(invite.campaignId).lean<CampaignRecord>();
    if (!campaign || campaign.status === 'DRAFT') throw AppError.notFound('Campaign not found');
    return { campaign, invite };
  }

  /**
   * Which invite a join belongs to. With a personal link, that invite, but
   * only linked when the candidate owns its email (a forwarded link must not
   * mark someone else's invite joined). Without one, an invite to any of the
   * candidate's verified emails. Invite-only campaigns refuse everyone else.
   */
  async function resolveInvite(
    c: CampaignRecord,
    viaLink: CampaignInviteRecord | null,
    userId: string,
  ): Promise<CampaignInviteRecord | null> {
    if (!c.orgId) return null;
    const emails = await verifiedEmails(userId);
    const invite =
      viaLink && emails.includes(viaLink.email)
        ? viaLink
        : await CampaignInviteModel.findOne({
            campaignId: c._id,
            email: { $in: emails },
            status: { $ne: 'REVOKED' },
          }).lean<CampaignInviteRecord>();
    if (c.requireInvite && !invite) {
      throw new AppError(
        403,
        'INVITE_REQUIRED',
        viaLink
          ? `This invitation was sent to ${maskEmail(viaLink.email)}. Sign in with that email address to join.`
          : 'This interview is by invitation only, and your email address was not invited.',
      );
    }
    // Someone else's invite (already used by another account) is not taken over.
    if (invite?.userId && String(invite.userId) !== userId) return null;
    return invite;
  }

  async function joinCampaign(
    c: CampaignRecord,
    viaLink: CampaignInviteRecord | null,
    userId: string,
    body: JoinCampaignBody,
    ctx: ClientContext,
  ): Promise<JoinCampaignResult> {
    const existing = async () =>
      CampaignApplicationModel.findOne({ campaignId: c._id, userId }, { sessionId: 1 }).lean();
    const before = await existing();
    if (before) return { interviewId: String(before.sessionId), created: false };
    await refuseDuringMaintenance(maintenance);
    const reason = closedReason(c, now());
    if (reason) throw new AppError(409, 'CAMPAIGN_CLOSED', CLOSED_MESSAGES[reason]);
    const invite = await resolveInvite(c, viaLink, userId);
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
        if (c.orgId) {
          // The organisation's interview quota, claimed the same way (never exceeded).
          const quota = await OrgModel.updateOne(
            {
              _id: c.orgId,
              status: 'ACTIVE',
              $or: [
                { 'interviewQuota.total': null },
                { $expr: { $lt: ['$interviewQuota.used', '$interviewQuota.total'] } },
              ],
            },
            { $inc: { 'interviewQuota.used': 1 } },
            { session: tx },
          );
          if (quota.modifiedCount !== 1) throw new AppError(409, 'CAMPAIGN_CLOSED', QUOTA_MESSAGE);
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
        const [application] = await CampaignApplicationModel.create(
          [
            {
              campaignId: c._id,
              userId,
              sessionId: session!._id,
              joinedAt: at,
              inviteId: invite?._id ?? null,
            },
          ],
          { session: tx },
        );
        if (invite) {
          // Joined: no more reminders.
          await CampaignInviteModel.updateOne(
            { _id: invite._id, status: { $nin: ['REVOKED', 'JOINED', 'COMPLETED'] } },
            {
              $set: {
                status: 'JOINED',
                joinedAt: at,
                userId,
                applicationId: application!._id,
                nextSendAt: null,
              },
            },
            { session: tx },
          );
        }
        await audit.record(
          {
            actorType: 'USER',
            actorId: userId,
            action: 'campaign.joined',
            resourceType: 'campaign',
            resourceId: String(c._id),
            details: {
              interviewId: String(session!._id),
              ...(invite ? { inviteId: String(invite._id) } : {}),
            },
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
  }
}

export type CampaignService = ReturnType<typeof createCampaignService>;

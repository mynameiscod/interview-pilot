import {
  CampaignInviteModel,
  inviteTokenContext,
  mongoose,
  type CampaignInviteRecord,
  type CampaignRecord,
} from '@cbi/db';
import {
  InviteStatus,
  previewInviteCsv,
  type CampaignInviteSummary,
  type CreateInvitesBody,
  type CreateInvitesResult,
  type InviteListPage,
  type InviteListQuery,
  type InvitePreview,
} from '@cbi/shared-types';
import type { AuditService } from '../../lib/audit.js';
import { AppError } from '../../lib/errors.js';
import { iso, objectId } from '../../lib/ids.js';
import type { ClientContext } from '../../lib/request-context.js';
import { hashToken, newToken } from '../campaigns/campaigns.service.js';

/**
 * Personal campaign invites (org portal). Each invite has its own link
 * (`/campaign/i/<token>`) in addition to the campaign's shared link. The
 * token's SHA-256 is stored for lookups; the token itself is kept encrypted
 * with the platform secret box so the worker can put the same link in the
 * invite email and in each reminder. The worker sends everything: new
 * invites are PENDING with `nextSendAt` now.
 */

export function inviteSummary(i: CampaignInviteRecord): CampaignInviteSummary {
  return {
    id: String(i._id),
    email: i.email,
    name: i.name,
    language: i.language,
    tags: { batch: i.tags.batch, branch: i.tags.branch, year: i.tags.year },
    status: i.status,
    remindersSent: i.remindersSent,
    sentAt: i.sentAt ? iso(i.sentAt) : null,
    openedAt: i.openedAt ? iso(i.openedAt) : null,
    joinedAt: i.joinedAt ? iso(i.joinedAt) : null,
    completedAt: i.completedAt ? iso(i.completedAt) : null,
    lastError: i.lastError,
    createdAt: iso(i.createdAt),
  };
}

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function createInviteService(deps: {
  audit: AuditService;
  secrets: { encrypt(plaintext: string, context: string): unknown };
  now?: () => Date;
}) {
  const now = deps.now ?? (() => new Date());

  async function invitedEmails(campaignId: CampaignRecord['_id']) {
    const rows = await CampaignInviteModel.find({ campaignId }, { email: 1 }).lean();
    return new Set(rows.map((r) => r.email));
  }

  async function inviteOf(campaign: CampaignRecord, inviteId: string) {
    const invite = await CampaignInviteModel.findOne({
      _id: objectId(inviteId, 'Invite'),
      campaignId: campaign._id,
      orgId: campaign.orgId,
    }).lean<CampaignInviteRecord>();
    if (!invite) throw AppError.notFound('Invite not found');
    return invite;
  }

  return {
    /** Validates an uploaded CSV without saving anything. */
    async preview(campaign: CampaignRecord, csv: string): Promise<InvitePreview> {
      return previewInviteCsv(csv, await invitedEmails(campaign._id));
    },

    /** Creates invites (single or bulk); emails already invited are skipped. */
    async create(
      campaign: CampaignRecord,
      body: CreateInvitesBody,
      actorId: string,
      ctx: ClientContext,
    ): Promise<CreateInvitesResult> {
      if (campaign.status === 'CLOSED') {
        throw new AppError(409, 'INVALID_STATE', 'This campaign is closed.');
      }
      const already = await invitedEmails(campaign._id);
      const skipped: string[] = [];
      const seen = new Set<string>();
      const at = now();
      const docs = body.invites.flatMap((input) => {
        const email = input.email.toLowerCase();
        if (already.has(email) || seen.has(email)) {
          skipped.push(email);
          return [];
        }
        seen.add(email);
        const _id = new mongoose.Types.ObjectId();
        const token = newToken();
        return [
          {
            _id,
            orgId: campaign.orgId,
            campaignId: campaign._id,
            email,
            name: input.name,
            language: input.language,
            tags: input.tags,
            status: 'PENDING' as const,
            tokenHash: hashToken(token),
            tokenEnc: deps.secrets.encrypt(token, inviteTokenContext(String(_id))),
            remindersSent: 0,
            nextSendAt: at,
            sendAttempts: 0,
            createdBy: actorId,
          },
        ];
      });
      let created = 0;
      if (docs.length > 0) {
        try {
          created = (await CampaignInviteModel.insertMany(docs, { ordered: false })).length;
        } catch (err) {
          // A parallel upload invited some of the same emails: those count as skipped.
          const e = err as { code?: number; insertedDocs?: unknown[]; writeErrors?: unknown[] };
          if (e.code !== 11000 && !e.writeErrors) throw err;
          created = e.insertedDocs?.length ?? 0;
        }
      }
      await deps.audit.record(
        {
          actorType: 'ORG_MEMBER',
          actorId,
          action: 'org.invites_created',
          resourceType: 'campaign',
          resourceId: String(campaign._id),
          details: { orgId: String(campaign.orgId), created, skipped: skipped.length },
        },
        ctx,
      );
      return { created, skipped };
    },

    async list(campaign: CampaignRecord, query: InviteListQuery): Promise<InviteListPage> {
      const filter = {
        campaignId: campaign._id,
        orgId: campaign.orgId,
        ...(query.status ? { status: query.status } : {}),
        ...(query.q ? { email: { $regex: escapeRegex(query.q.toLowerCase()) } } : {}),
      };
      const [rows, total, counts] = await Promise.all([
        CampaignInviteModel.find(filter)
          .sort({ createdAt: -1, _id: -1 })
          .skip((query.page - 1) * query.pageSize)
          .limit(query.pageSize)
          .lean<CampaignInviteRecord[]>(),
        CampaignInviteModel.countDocuments(filter),
        CampaignInviteModel.aggregate<{ _id: InviteStatus; n: number }>([
          { $match: { campaignId: campaign._id } },
          { $group: { _id: '$status', n: { $sum: 1 } } },
        ]),
      ]);
      const funnel = Object.fromEntries(InviteStatus.options.map((s) => [s, 0])) as Record<
        InviteStatus,
        number
      >;
      for (const c of counts) funnel[c._id] = c.n;
      return {
        items: rows.map(inviteSummary),
        total,
        page: query.page,
        pageSize: query.pageSize,
        counts: funnel,
      };
    },

    /** Withdraws an invite: its link stops working and no reminders are sent. */
    async revoke(campaign: CampaignRecord, inviteId: string, actorId: string, ctx: ClientContext) {
      const invite = await inviteOf(campaign, inviteId);
      if (invite.status === 'JOINED' || invite.status === 'COMPLETED') {
        throw new AppError(409, 'INVALID_STATE', 'This candidate has already joined.');
      }
      const updated = await CampaignInviteModel.findOneAndUpdate(
        { _id: invite._id, status: { $nin: ['JOINED', 'COMPLETED'] } },
        { $set: { status: 'REVOKED', nextSendAt: null } },
        { returnDocument: 'after' },
      ).lean<CampaignInviteRecord>();
      if (!updated) throw AppError.conflict('This invite changed. Refresh and try again.');
      await deps.audit.record(
        {
          actorType: 'ORG_MEMBER',
          actorId,
          action: 'org.invite_revoked',
          resourceType: 'campaign',
          resourceId: String(campaign._id),
          details: { orgId: String(campaign.orgId), inviteId },
        },
        ctx,
      );
      return inviteSummary(updated);
    },

    /** Sends a failed invite again (the worker picks it up at once). */
    async retry(campaign: CampaignRecord, inviteId: string, actorId: string, ctx: ClientContext) {
      const invite = await inviteOf(campaign, inviteId);
      if (invite.status !== 'FAILED') {
        throw new AppError(
          409,
          'INVALID_STATE',
          'Only invites that could not be sent are retried.',
        );
      }
      const updated = await CampaignInviteModel.findOneAndUpdate(
        { _id: invite._id, status: 'FAILED' },
        { $set: { status: 'PENDING', nextSendAt: now(), sendAttempts: 0, lastError: null } },
        { returnDocument: 'after' },
      ).lean<CampaignInviteRecord>();
      if (!updated) throw AppError.conflict('This invite changed. Refresh and try again.');
      await deps.audit.record(
        {
          actorType: 'ORG_MEMBER',
          actorId,
          action: 'org.invite_retried',
          resourceType: 'campaign',
          resourceId: String(campaign._id),
          details: { orgId: String(campaign.orgId), inviteId },
        },
        ctx,
      );
      return inviteSummary(updated);
    },
  };
}

export type InviteService = ReturnType<typeof createInviteService>;

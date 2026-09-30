import type { Logger } from '@cbi/config';
import {
  CampaignModel,
  OrgMemberModel,
  OrgModel,
  UserModel,
  UserProfileModel,
  type OrgMemberRecord,
  type OrgRecord,
} from '@cbi/db';
import type { EmailProvider } from '@cbi/provider-adapters';
import {
  DEFAULT_SCORECARD_CRITERIA,
  type AuditActorType,
  type CreateOrgBody,
  type InviteOrgMemberResponse,
  type OrgListPage,
  type OrgListQuery,
  type OrgMemberSummary,
  type OrgRole,
  type OrgStatusBody,
  type OrgSummary,
  type OrgWalletAdjustBody,
  type UpdateOrgBody,
  type UpdateScorecardCriteriaBody,
} from '@cbi/shared-types';
import type { ClientSession, Types } from 'mongoose';
import type { AuditService } from '../../lib/audit.js';
import { AppError } from '../../lib/errors.js';
import { iso, objectId } from '../../lib/ids.js';
import type { ClientContext } from '../../lib/request-context.js';
import { transaction } from '../../lib/transaction.js';
import type { AccountService } from '../auth/account.service.js';
import { orgMemberInviteEmail } from '../auth/messages.js';
import type { SessionService } from '../auth/session.service.js';
import type { UserStateCache } from '../auth/user-state.js';

/** Who changes an organisation: a CodeBegun admin, or one of its own members (owners). */
export interface OrgActor {
  userId: string;
  type: Extract<AuditActorType, 'ADMIN' | 'ORG_MEMBER'>;
}

const LIVE = ['INVITED', 'ACTIVE'] as const;

export function orgSummary(o: OrgRecord, seatsUsed: number): OrgSummary {
  return {
    id: String(o._id),
    name: o.name,
    type: o.type,
    status: o.status,
    seats: { total: o.seats, used: seatsUsed },
    interviewQuota: { total: o.interviewQuota.total, used: o.interviewQuota.used },
    wallet: { balance: o.wallet.balance, allocated: o.wallet.allocated },
    mfaRequired: o.mfaRequired,
    scorecardCriteria: o.scorecardCriteria.length
      ? o.scorecardCriteria.map((c) => ({ key: c.key, label: c.label }))
      : DEFAULT_SCORECARD_CRITERIA,
    createdAt: iso(o.createdAt),
    updatedAt: iso(o.updatedAt),
  };
}

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Organisations (CodeBegun admins) and their members (admins and the
 * organisation's owners). Every mutation is audited in the same transaction.
 * An organisation always keeps at least one owner, and never has more live
 * members than seats.
 */
export function createOrgService(deps: {
  accounts: AccountService;
  sessions: SessionService;
  userState: UserStateCache;
  audit: AuditService;
  email: EmailProvider;
  logger: Logger;
  portalUrl: string;
}) {
  const { audit } = deps;

  async function byId(id: string, session?: ClientSession) {
    const org = await OrgModel.findById(objectId(id, 'Organisation'), null, {
      session,
    }).lean<OrgRecord>();
    if (!org) throw AppError.notFound('Organisation not found');
    return org;
  }

  const seatsUsed = (orgId: Types.ObjectId, session?: ClientSession) =>
    OrgMemberModel.countDocuments({ orgId, status: { $in: LIVE } }, { session });

  async function summaryOf(org: OrgRecord) {
    return orgSummary(org, await seatsUsed(org._id));
  }

  async function memberSummaries(members: OrgMemberRecord[]): Promise<OrgMemberSummary[]> {
    const ids = members.map((m) => m.userId);
    const [users, profiles] = await Promise.all([
      UserModel.find({ _id: { $in: ids } }, { primaryEmail: 1, lastLoginAt: 1 }).lean(),
      UserProfileModel.find({ userId: { $in: ids } }, { userId: 1, displayName: 1 }).lean(),
    ]);
    const user = new Map(users.map((u) => [String(u._id), u]));
    const name = new Map(profiles.map((p) => [String(p.userId), p.displayName ?? null]));
    return members.map((m) => ({
      id: String(m._id),
      userId: String(m.userId),
      email: user.get(String(m.userId))?.primaryEmail ?? null,
      name: name.get(String(m.userId)) ?? null,
      role: m.role,
      status: m.status,
      invitedAt: iso(m.invitedAt),
      lastLoginAt: user.get(String(m.userId))?.lastLoginAt
        ? iso(user.get(String(m.userId))!.lastLoginAt!)
        : null,
    }));
  }

  /**
   * Adds a member (an existing account or a new one for the email), inside
   * the caller's transaction. Seats are checked there; the unique live
   * membership index keeps one organisation per person.
   */
  async function addMember(
    org: OrgRecord,
    input: { email: string; role: OrgRole },
    actor: OrgActor,
    ctx: ClientContext,
    session: ClientSession,
  ) {
    if ((await seatsUsed(org._id, session)) >= org.seats) {
      throw AppError.conflict(`All ${org.seats} seats are in use. Remove a member or add seats.`);
    }
    const email = input.email.toLowerCase();
    let user = await deps.accounts.findUserByContact('EMAIL', email, session);
    if (!user) {
      user = new UserModel({ primaryEmail: email, invitedBy: actor.userId });
      await user.save({ session });
      await UserProfileModel.create([{ userId: user._id }], { session });
    }
    if (user.adminRoles.length > 0) {
      // Staff keep their admin console; an org membership would mix the two.
      throw AppError.conflict('CodeBegun staff accounts cannot join an organisation.');
    }
    if (user.status !== 'ACTIVE') throw AppError.conflict('This account cannot be invited.');
    const existing = await OrgMemberModel.findOne(
      { userId: user._id, status: { $in: LIVE } },
      null,
      { session },
    ).lean();
    if (existing) {
      throw AppError.conflict(
        String(existing.orgId) === String(org._id)
          ? 'This person is already a member.'
          : 'This person already belongs to another organisation.',
      );
    }
    const [member] = await OrgMemberModel.create(
      [
        {
          orgId: org._id,
          userId: user._id,
          role: input.role,
          status: 'INVITED',
          invitedBy: actor.userId,
          invitedAt: new Date(),
        },
      ],
      { session },
    );
    await audit.record(
      {
        actorType: actor.type,
        actorId: actor.userId,
        action: 'org.member_invited',
        resourceType: 'org',
        resourceId: String(org._id),
        details: { memberId: String(member!._id), userId: String(user._id), role: input.role },
      },
      ctx,
      session,
    );
    return member!.toObject() as OrgMemberRecord;
  }

  async function sendInvite(org: OrgRecord, email: string, role: OrgRole) {
    try {
      await deps.email.send(orgMemberInviteEmail(email, `${deps.portalUrl}/org`, org.name, role));
      return true;
    } catch (err) {
      deps.logger.warn({ err, orgId: String(org._id) }, 'org member invite email failed');
      return false;
    }
  }

  async function assertAnotherOwner(
    orgId: Types.ObjectId,
    excluding: Types.ObjectId,
    session: ClientSession,
  ) {
    const owners = await OrgMemberModel.countDocuments(
      { orgId, role: 'ORG_OWNER', status: { $in: LIVE }, _id: { $ne: excluding } },
      { session },
    );
    if (owners === 0) throw AppError.conflict('An organisation must keep at least one owner.');
  }

  async function memberOf(orgId: string, memberId: string, session?: ClientSession) {
    const member = await OrgMemberModel.findOne(
      { _id: objectId(memberId, 'Member'), orgId: objectId(orgId, 'Organisation') },
      null,
      { session },
    );
    if (!member || member.status === 'REMOVED') throw AppError.notFound('Member not found');
    return member;
  }

  return {
    byId,
    summaryOf,

    // ---- CodeBegun admins ----------------------------------------------------------------------

    async list(query: OrgListQuery): Promise<OrgListPage> {
      const filter = query.q ? { name: { $regex: escapeRegex(query.q), $options: 'i' } } : {};
      const [rows, total] = await Promise.all([
        OrgModel.find(filter)
          .sort({ createdAt: -1, _id: -1 })
          .skip((query.page - 1) * query.pageSize)
          .limit(query.pageSize)
          .lean<OrgRecord[]>(),
        OrgModel.countDocuments(filter),
      ]);
      return {
        items: await Promise.all(rows.map(summaryOf)),
        total,
        page: query.page,
        pageSize: query.pageSize,
      };
    },

    async get(id: string) {
      return summaryOf(await byId(id));
    },

    /** Creates the organisation and invites its first owner. */
    async create(body: CreateOrgBody, actorId: string, ctx: ClientContext) {
      const actor: OrgActor = { userId: actorId, type: 'ADMIN' };
      const org = await transaction(async (tx) => {
        const [created] = await OrgModel.create(
          [
            {
              name: body.name,
              type: body.type,
              status: 'ACTIVE',
              seats: body.seats,
              interviewQuota: { total: body.interviewQuota, used: 0 },
              wallet: { balance: body.walletCredits, allocated: 0 },
              mfaRequired: body.mfaRequired,
              scorecardCriteria: DEFAULT_SCORECARD_CRITERIA,
              createdBy: actorId,
            },
          ],
          { session: tx },
        );
        const record = created!.toObject() as OrgRecord;
        await audit.record(
          {
            actorType: 'ADMIN',
            actorId,
            action: 'org.created',
            resourceType: 'org',
            resourceId: String(record._id),
            details: {
              name: body.name,
              type: body.type,
              seats: body.seats,
              interviewQuota: body.interviewQuota,
              walletCredits: body.walletCredits,
            },
          },
          ctx,
          tx,
        );
        await addMember(record, { email: body.ownerEmail, role: 'ORG_OWNER' }, actor, ctx, tx);
        return record;
      });
      const inviteEmailSent = await sendInvite(org, body.ownerEmail, 'ORG_OWNER');
      return { org: await summaryOf(org), inviteEmailSent };
    },

    async update(id: string, body: UpdateOrgBody, actorId: string, ctx: ClientContext) {
      return transaction(async (tx) => {
        const org = await byId(id, tx);
        const used = await seatsUsed(org._id, tx);
        if (body.seats < used) {
          throw AppError.validation(`Seats cannot be fewer than the ${used} members.`);
        }
        if (body.interviewQuota !== null && body.interviewQuota < org.interviewQuota.used) {
          throw AppError.validation(
            `The quota cannot be lower than the ${org.interviewQuota.used} interviews already used.`,
          );
        }
        const updated = await OrgModel.findOneAndUpdate(
          { _id: org._id, 'interviewQuota.used': org.interviewQuota.used },
          {
            $set: {
              name: body.name,
              seats: body.seats,
              'interviewQuota.total': body.interviewQuota,
              mfaRequired: body.mfaRequired,
            },
          },
          { returnDocument: 'after', session: tx },
        ).lean<OrgRecord>();
        if (!updated) throw AppError.conflict('This organisation changed. Refresh and try again.');
        await audit.record(
          {
            actorType: 'ADMIN',
            actorId,
            action: 'org.updated',
            resourceType: 'org',
            resourceId: id,
            details: {
              reason: body.reason,
              seats: body.seats,
              interviewQuota: body.interviewQuota,
              mfaRequired: body.mfaRequired,
            },
          },
          ctx,
          tx,
        );
        return orgSummary(updated, used);
      });
    },

    /** Suspending blocks every member's sign-in and API key at once. */
    async setStatus(id: string, body: OrgStatusBody, actorId: string, ctx: ClientContext) {
      const org = await byId(id);
      const summary = await transaction(async (tx) => {
        const updated = await OrgModel.findOneAndUpdate(
          { _id: org._id },
          { $set: { status: body.status } },
          { returnDocument: 'after', session: tx },
        ).lean<OrgRecord>();
        await audit.record(
          {
            actorType: 'ADMIN',
            actorId,
            action: 'org.status_changed',
            resourceType: 'org',
            resourceId: id,
            details: { from: org.status, to: body.status, reason: body.reason },
          },
          ctx,
          tx,
        );
        return orgSummary(updated!, await seatsUsed(org._id, tx));
      });
      const members = await OrgMemberModel.find({ orgId: org._id }, { userId: 1 }).lean();
      await Promise.all(members.map((m) => deps.userState.invalidate(String(m.userId))));
      return summary;
    },

    /** Adds sponsored interviews to the wallet (or takes unallocated ones back). */
    async adjustWallet(id: string, body: OrgWalletAdjustBody, actorId: string, ctx: ClientContext) {
      return transaction(async (tx) => {
        const org = await byId(id, tx);
        const updated = await OrgModel.findOneAndUpdate(
          {
            _id: org._id,
            ...(body.delta < 0 ? { 'wallet.balance': { $gte: -body.delta } } : {}),
          },
          { $inc: { 'wallet.balance': body.delta } },
          { returnDocument: 'after', session: tx },
        ).lean<OrgRecord>();
        if (!updated) {
          throw AppError.validation(
            `Only ${org.wallet.balance} unallocated interviews can be taken from the wallet.`,
          );
        }
        await audit.record(
          {
            actorType: 'ADMIN',
            actorId,
            action: 'org.wallet_adjusted',
            resourceType: 'org',
            resourceId: id,
            details: {
              delta: body.delta,
              before: org.wallet.balance,
              after: updated.wallet.balance,
              reason: body.reason,
            },
          },
          ctx,
          tx,
        );
        return orgSummary(updated, await seatsUsed(org._id, tx));
      });
    },

    /** The organisation's campaigns count (admin detail page). */
    async campaignCount(id: string) {
      return CampaignModel.countDocuments({ orgId: objectId(id, 'Organisation') });
    },

    // ---- Members (CodeBegun admins and the organisation's owners) --------------------------------

    async members(orgId: string): Promise<OrgMemberSummary[]> {
      const members = await OrgMemberModel.find({
        orgId: objectId(orgId, 'Organisation'),
        status: { $in: LIVE },
      })
        .sort({ invitedAt: 1 })
        .lean<OrgMemberRecord[]>();
      return memberSummaries(members);
    },

    async inviteMember(
      orgId: string,
      input: { email: string; role: OrgRole },
      actor: OrgActor,
      ctx: ClientContext,
    ): Promise<InviteOrgMemberResponse> {
      const { org, member } = await transaction(async (tx) => {
        const org = await byId(orgId, tx);
        if (org.status !== 'ACTIVE') throw AppError.conflict('This organisation is suspended.');
        return { org, member: await addMember(org, input, actor, ctx, tx) };
      });
      await deps.userState.invalidate(String(member.userId));
      const inviteEmailSent = await sendInvite(org, input.email, input.role);
      const [summary] = await memberSummaries([member]);
      return { member: summary!, inviteEmailSent };
    },

    async changeRole(
      orgId: string,
      memberId: string,
      role: OrgRole,
      actor: OrgActor,
      ctx: ClientContext,
    ): Promise<OrgMemberSummary> {
      const member = await transaction(async (tx) => {
        const member = await memberOf(orgId, memberId, tx);
        const before = member.role;
        if (before === 'ORG_OWNER' && role !== 'ORG_OWNER') {
          await assertAnotherOwner(member.orgId, member._id, tx);
        }
        member.role = role;
        await member.save({ session: tx });
        await audit.record(
          {
            actorType: actor.type,
            actorId: actor.userId,
            action: 'org.member_role_changed',
            resourceType: 'org',
            resourceId: orgId,
            details: { memberId, userId: String(member.userId), before, after: role },
          },
          ctx,
          tx,
        );
        return member.toObject() as OrgMemberRecord;
      });
      await deps.userState.invalidate(String(member.userId));
      const [summary] = await memberSummaries([member]);
      return summary!;
    },

    /** Removes a member and signs them out of the org portal everywhere. */
    async removeMember(orgId: string, memberId: string, actor: OrgActor, ctx: ClientContext) {
      const userId = await transaction(async (tx) => {
        const member = await memberOf(orgId, memberId, tx);
        if (actor.type === 'ORG_MEMBER' && String(member.userId) === actor.userId) {
          throw AppError.conflict('You cannot remove yourself.');
        }
        if (member.role === 'ORG_OWNER') await assertAnotherOwner(member.orgId, member._id, tx);
        member.status = 'REMOVED';
        member.removedAt = new Date();
        await member.save({ session: tx });
        await deps.sessions.revokeAll(String(member.userId), 'ROLE_CHANGE', {
          audience: 'org',
          session: tx,
        });
        await audit.record(
          {
            actorType: actor.type,
            actorId: actor.userId,
            action: 'org.member_removed',
            resourceType: 'org',
            resourceId: orgId,
            details: { memberId, userId: String(member.userId), role: member.role },
          },
          ctx,
          tx,
        );
        return String(member.userId);
      });
      await deps.userState.invalidate(userId);
    },

    async updateCriteria(
      orgId: string,
      body: UpdateScorecardCriteriaBody,
      actor: OrgActor,
      ctx: ClientContext,
    ) {
      return transaction(async (tx) => {
        const updated = await OrgModel.findOneAndUpdate(
          { _id: objectId(orgId, 'Organisation') },
          { $set: { scorecardCriteria: body.criteria } },
          { returnDocument: 'after', session: tx },
        ).lean<OrgRecord>();
        if (!updated) throw AppError.notFound('Organisation not found');
        await audit.record(
          {
            actorType: actor.type,
            actorId: actor.userId,
            action: 'org.scorecard_criteria_changed',
            resourceType: 'org',
            resourceId: orgId,
            details: { keys: body.criteria.map((c) => c.key) },
          },
          ctx,
          tx,
        );
        return orgSummary(updated, await seatsUsed(updated._id, tx));
      });
    },
  };
}

export type OrgService = ReturnType<typeof createOrgService>;

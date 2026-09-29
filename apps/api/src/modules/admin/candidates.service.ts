import { maskEmail, maskMobile, normalizeEmail, normalizeMobile } from '@cbi/auth-core';
import {
  AuthIdentityModel,
  CampaignModel,
  ConsentModel,
  CreditAccountModel,
  InterviewSessionModel,
  JobTargetModel,
  mongoose,
  PurchaseModel,
  UserModel,
  UserProfileModel,
} from '@cbi/db';
import type {
  CandidateDetail,
  CandidateListItem,
  CandidatePage,
  CandidateSearchQuery,
  UserStatus,
} from '@cbi/shared-types';
import type { Types } from 'mongoose';
import type { AuditService } from '../../lib/audit.js';
import { AppError } from '../../lib/errors.js';
import type { ClientContext } from '../../lib/request-context.js';
import { transaction } from '../../lib/transaction.js';
import type { SessionService } from '../auth/session.service.js';
import type { UserStateCache } from '../auth/user-state.js';

export type CandidateSearch =
  | { kind: 'all' }
  | { kind: 'id'; id: string }
  | { kind: 'email'; value: string }
  | { kind: 'emailPrefix'; pattern: RegExp }
  | { kind: 'mobile'; value: string }
  | { kind: 'name'; pattern: RegExp };

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Reads a support search: a user id, an exact email (or the start of one),
 * a mobile number (any common Indian format), else the start of a word in
 * the name. Patterns are escaped and anchored so a search cannot become an
 * expensive or injected regular expression.
 */
export function parseCandidateSearch(raw: string): CandidateSearch {
  const q = raw.trim();
  if (!q) return { kind: 'all' };
  if (/^[0-9a-f]{24}$/i.test(q)) return { kind: 'id', id: q.toLowerCase() };
  if (q.includes('@')) {
    const email = normalizeEmail(q);
    return email
      ? { kind: 'email', value: email }
      : { kind: 'emailPrefix', pattern: new RegExp(`^${escapeRegex(q.toLowerCase())}`) };
  }
  if (/^[+\d][\d\s()-]{6,}$/.test(q)) {
    const mobile = normalizeMobile(q);
    if (mobile) return { kind: 'mobile', value: mobile };
  }
  return { kind: 'name', pattern: new RegExp(`(^|\\s)${escapeRegex(q.slice(0, 60))}`, 'i') };
}

interface UserRow {
  _id: Types.ObjectId;
  primaryEmail?: string | null;
  primaryMobile?: string | null;
  status: string;
  lastLoginAt?: Date | null;
  createdAt: Date;
}

function listItem(u: UserRow, displayName: string | null): CandidateListItem {
  return {
    id: String(u._id),
    displayName,
    email: u.primaryEmail ?? null,
    mobile: u.primaryMobile ?? null,
    status: u.status as UserStatus,
    lastLoginAt: u.lastLoginAt?.toISOString() ?? null,
    createdAt: u.createdAt.toISOString(),
  };
}

/** Candidates are accounts without admin roles (staff are managed under Admin users). */
const CANDIDATE = { 'adminRoles.0': { $exists: false } };

export function createCandidateAdminService(deps: {
  audit: AuditService;
  sessions: SessionService;
  userState: UserStateCache;
}) {
  async function names(ids: Types.ObjectId[]) {
    const profiles = await UserProfileModel.find(
      { userId: { $in: ids } },
      { userId: 1, displayName: 1 },
    ).lean();
    return new Map(profiles.map((p) => [String(p.userId), p.displayName ?? null]));
  }

  async function loadCandidate(id: string) {
    if (!mongoose.isValidObjectId(id)) throw AppError.notFound('Candidate not found');
    const user = await UserModel.findOne({ _id: id, ...CANDIDATE }).lean();
    if (!user || user.status === 'DELETED') throw AppError.notFound('Candidate not found');
    return user;
  }

  async function setStatus(
    id: string,
    to: 'ACTIVE' | 'SUSPENDED',
    reason: string,
    actorId: string,
    ctx: ClientContext,
  ) {
    const user = await loadCandidate(id);
    const from = to === 'SUSPENDED' ? 'ACTIVE' : 'SUSPENDED';
    if (user.status !== from) {
      throw new AppError(
        409,
        'INVALID_STATE',
        to === 'SUSPENDED'
          ? 'Only active accounts can be suspended.'
          : 'This account is not suspended.',
      );
    }
    await transaction(async (session) => {
      const res = await UserModel.updateOne(
        { _id: id, status: from },
        to === 'SUSPENDED'
          ? {
              $set: {
                status: 'SUSPENDED',
                suspension: { at: new Date(), by: new mongoose.Types.ObjectId(actorId), reason },
              },
            }
          : { $set: { status: 'ACTIVE' }, $unset: { suspension: '' } },
        { session },
      );
      if (res.modifiedCount !== 1)
        throw AppError.conflict('The account changed; reload and retry.');
      // Suspension ends every session now (refresh tokens and live access tokens).
      if (to === 'SUSPENDED') await deps.sessions.revokeAll(id, 'SUSPENDED', { session });
      await deps.audit.record(
        {
          actorType: 'ADMIN',
          actorId,
          action: to === 'SUSPENDED' ? 'candidate.suspended' : 'candidate.reinstated',
          resourceType: 'user',
          resourceId: id,
          details: { reason },
        },
        ctx,
        session,
      );
    });
    await deps.userState.invalidate(id);
  }

  return {
    async search(
      query: CandidateSearchQuery,
      actorId: string,
      ctx: ClientContext,
    ): Promise<CandidatePage> {
      const search = parseCandidateSearch(query.q);
      const filter: Record<string, unknown> = { ...CANDIDATE, status: { $ne: 'DELETED' } };
      if (query.status) filter.status = query.status;
      if (query.before) {
        if (!mongoose.isValidObjectId(query.before)) throw AppError.validation('Invalid cursor');
        filter._id = { $lt: new mongoose.Types.ObjectId(query.before) };
      }
      switch (search.kind) {
        case 'id':
          filter._id = new mongoose.Types.ObjectId(search.id);
          break;
        case 'email': {
          const identity = await AuthIdentityModel.findOne(
            { provider: 'EMAIL', subject: search.value },
            { userId: 1 },
          ).lean();
          filter.$or = [
            { primaryEmail: search.value },
            ...(identity ? [{ _id: identity.userId }] : []),
          ];
          break;
        }
        case 'emailPrefix':
          filter.primaryEmail = search.pattern;
          break;
        case 'mobile': {
          const identity = await AuthIdentityModel.findOne(
            { provider: 'MOBILE', subject: search.value },
            { userId: 1 },
          ).lean();
          filter.$or = [
            { primaryMobile: search.value },
            ...(identity ? [{ _id: identity.userId }] : []),
          ];
          break;
        }
        case 'name': {
          const profiles = await UserProfileModel.find(
            { displayName: search.pattern },
            { userId: 1 },
          )
            .limit(200)
            .lean();
          filter._id = { ...((filter._id as object) ?? {}), $in: profiles.map((p) => p.userId) };
          break;
        }
      }
      const users = await UserModel.find(filter)
        .sort({ _id: -1 })
        .limit(query.limit + 1)
        .lean();
      const page = users.slice(0, query.limit);
      const displayNames = await names(page.map((u) => u._id));
      // Searching personal data is itself audited (who looked for whom is reviewable).
      if (search.kind !== 'all') {
        await deps.audit.record(
          {
            actorType: 'ADMIN',
            actorId,
            action: 'candidate.searched',
            details: { kind: search.kind, results: page.length },
          },
          ctx,
        );
      }
      return {
        items: page.map((u) => listItem(u, displayNames.get(String(u._id)) ?? null)),
        nextCursor: users.length > query.limit ? String(page[page.length - 1]!._id) : null,
      };
    },

    async detail(id: string, actorId: string, ctx: ClientContext): Promise<CandidateDetail> {
      const user = await loadCandidate(id);
      const [profile, identities, account, sessions, purchases, consents] = await Promise.all([
        UserProfileModel.findOne({ userId: user._id }).lean(),
        AuthIdentityModel.find({ userId: user._id }).sort({ createdAt: 1 }).lean(),
        CreditAccountModel.findOne({ userId: user._id }, { balance: 1, reserved: 1 }).lean(),
        InterviewSessionModel.find(
          { userId: user._id },
          { state: 1, mode: 1, jobTargetId: 1, campaignId: 1, createdAt: 1 },
        )
          .sort({ createdAt: -1 })
          .limit(20)
          .lean(),
        PurchaseModel.find(
          { userId: user._id },
          { plan: 1, status: 1, amountMinor: 1, createdAt: 1 },
        )
          .sort({ createdAt: -1 })
          .limit(20)
          .lean(),
        ConsentModel.find({ userId: user._id }, { type: 1, accepted: 1, version: 1, at: 1 })
          .sort({ at: -1 })
          .limit(30)
          .lean(),
      ]);
      const [targets, campaigns] = await Promise.all([
        JobTargetModel.find(
          { _id: { $in: sessions.map((s) => s.jobTargetId) } },
          { roleTitle: 1, 'structured.title': 1 },
        ).lean(),
        CampaignModel.find(
          { _id: { $in: sessions.flatMap((s) => (s.campaignId ? [s.campaignId] : [])) } },
          { name: 1 },
        ).lean(),
      ]);
      const target = new Map(targets.map((t) => [String(t._id), t]));
      const campaign = new Map(campaigns.map((c) => [String(c._id), c.name]));
      await deps.audit.record(
        {
          actorType: 'ADMIN',
          actorId,
          action: 'candidate.viewed',
          resourceType: 'user',
          resourceId: id,
        },
        ctx,
      );
      return {
        candidate: {
          ...listItem(user, profile?.displayName ?? null),
          experienceLevel: profile?.experienceLevel ?? null,
          currentRole: profile?.currentRole ?? null,
          preferredInterviewLanguage: profile?.preferredInterviewLanguage ?? 'auto',
          productUpdatesOptIn: profile?.productUpdatesOptIn ?? false,
          identities: identities.map((i) => ({
            provider: i.provider,
            display:
              i.provider === 'EMAIL'
                ? maskEmail(i.subject)
                : i.provider === 'MOBILE'
                  ? maskMobile(i.subject)
                  : i.email
                    ? maskEmail(i.email)
                    : 'Google account',
          })),
          deletionScheduledFor:
            user.status === 'DELETION_PENDING' && user.deletion
              ? user.deletion.scheduledFor.toISOString()
              : null,
          suspension: user.suspension
            ? {
                at: user.suspension.at.toISOString(),
                reason: user.suspension.reason,
                by: user.suspension.by ? String(user.suspension.by) : null,
              }
            : null,
        },
        credits: { available: account?.balance ?? 0, reserved: account?.reserved ?? 0 },
        interviews: sessions.map((s) => {
          const t = target.get(String(s.jobTargetId));
          const structured = t?.structured as { title?: string } | null | undefined;
          return {
            id: String(s._id),
            state: s.state,
            mode: s.mode ?? null,
            roleTitle: t?.roleTitle ?? structured?.title ?? null,
            campaign: s.campaignId ? (campaign.get(String(s.campaignId)) ?? null) : null,
            createdAt: s.createdAt.toISOString(),
          };
        }),
        purchases: purchases.map((p) => ({
          id: String(p._id),
          planName: p.plan?.name ?? null,
          status: p.status,
          amountPaise: p.amountMinor ?? null,
          createdAt: p.createdAt.toISOString(),
        })),
        consents: consents.map((c) => ({
          type: c.type,
          accepted: c.accepted,
          version: c.version ?? null,
          at: c.at.toISOString(),
        })),
      };
    },

    suspend: (id: string, reason: string, actorId: string, ctx: ClientContext) =>
      setStatus(id, 'SUSPENDED', reason, actorId, ctx),

    reinstate: (id: string, reason: string, actorId: string, ctx: ClientContext) =>
      setStatus(id, 'ACTIVE', reason, actorId, ctx),
  };
}

export type CandidateAdminService = ReturnType<typeof createCandidateAdminService>;

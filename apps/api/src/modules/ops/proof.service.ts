import { createHash, randomBytes } from 'node:crypto';
import {
  InterviewReportModel,
  InterviewSessionModel,
  ShareLinkModel,
  UserProfileModel,
  type InterviewReportRecord,
  type ShareLinkRecord,
} from '@cbi/db';
import type { Types } from 'mongoose';
import type {
  CreateShareBody,
  CreatedShareLink,
  ProofView,
  ShareLinkSummary,
} from '@cbi/shared-types';
import type { AuditService } from '../../lib/audit.js';
import { AppError } from '../../lib/errors.js';
import { iso, objectId } from '../../lib/ids.js';
import type { ClientContext } from '../../lib/request-context.js';
import type { FlagService } from './ops.service.js';

const FLAG = 'reports.publicProof' as const;
const DAY_MS = 24 * 3600 * 1000;
/** Active (unexpired, unrevoked) links per report. */
export const MAX_ACTIVE_LINKS = 5;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;
const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

const summary = (l: ShareLinkRecord): ShareLinkSummary => ({
  id: String(l._id),
  sessionId: String(l.sessionId),
  reportRevision: l.reportRevision,
  expiresAt: iso(l.expiresAt),
  revokedAt: l.revokedAt ? iso(l.revokedAt) : null,
  views: l.views,
  lastViewedAt: l.lastViewedAt ? iso(l.lastViewedAt) : null,
  createdAt: iso(l.createdAt),
  tokenHint: l.tokenHint,
});

/** The latest revision the candidate may see (campaigns can hide reports). */
async function visibleReport(userId: Types.ObjectId | string, sessionId: Types.ObjectId) {
  return InterviewReportModel.findOne({ userId, sessionId, 'visibility.candidate': true })
    .sort({ revision: -1 })
    .lean<InterviewReportRecord>();
}

/**
 * Candidate Proof, behind the `reports.publicProof` flag. While the flag is
 * off every endpoint answers 404, as if it did not exist.
 */
export function createProofService(deps: {
  flags: FlagService;
  audit: AuditService;
  now?: () => Date;
}) {
  const now = deps.now ?? (() => new Date());
  const notFound = () => AppError.notFound('Not found');

  async function enabledFor(userId: string) {
    if (!(await deps.flags.isEnabled(FLAG, userId))) throw notFound();
  }

  return {
    async create(
      userId: string,
      sessionId: string,
      body: CreateShareBody,
      ctx: ClientContext,
    ): Promise<CreatedShareLink> {
      await enabledFor(userId);
      const sid = objectId(sessionId, 'Report');
      const report = await visibleReport(userId, sid);
      if (!report) throw AppError.notFound('Report not found');
      const at = now();
      const active = await ShareLinkModel.countDocuments({
        userId,
        sessionId: sid,
        revokedAt: null,
        expiresAt: { $gt: at },
      });
      if (active >= MAX_ACTIVE_LINKS) {
        throw AppError.conflict(
          `You can have ${MAX_ACTIVE_LINKS} active links per report. Revoke one first.`,
        );
      }
      const token = randomBytes(18).toString('base64url');
      const link = await ShareLinkModel.create({
        userId,
        sessionId: sid,
        reportRevision: report.revision,
        tokenHash: hashToken(token),
        tokenHint: token.slice(0, 4),
        expiresAt: new Date(at.getTime() + body.expiresInDays * DAY_MS),
      });
      await deps.audit.record(
        {
          actorType: 'USER',
          actorId: userId,
          action: 'proof.link_created',
          resourceType: 'shareLink',
          resourceId: String(link._id),
          details: { sessionId, expiresInDays: body.expiresInDays },
        },
        ctx,
      );
      return { link: summary(link.toObject()), path: `/proof/${token}` };
    },

    async list(userId: string, sessionId: string): Promise<ShareLinkSummary[]> {
      await enabledFor(userId);
      const links = await ShareLinkModel.find({
        userId,
        sessionId: objectId(sessionId, 'Report'),
      })
        .sort({ createdAt: -1 })
        .limit(50)
        .lean();
      return links.map(summary);
    },

    async revoke(userId: string, linkId: string, ctx: ClientContext) {
      await enabledFor(userId);
      const link = await ShareLinkModel.findOneAndUpdate(
        { _id: objectId(linkId, 'Link'), userId },
        [{ $set: { revokedAt: { $ifNull: ['$revokedAt', now()] } } }],
        { returnDocument: 'after', updatePipeline: true },
      ).lean();
      if (!link) throw AppError.notFound('Link not found');
      await deps.audit.record(
        {
          actorType: 'USER',
          actorId: userId,
          action: 'proof.link_revoked',
          resourceType: 'shareLink',
          resourceId: linkId,
        },
        ctx,
      );
      return summary(link);
    },

    /** The public page. Expired, revoked and unknown links read alike. */
    async view(token: string): Promise<ProofView> {
      if (!(await deps.flags.isSwitchedOn(FLAG))) throw notFound();
      if (!TOKEN_PATTERN.test(token)) throw notFound();
      const at = now();
      const link = await ShareLinkModel.findOneAndUpdate(
        { tokenHash: hashToken(token), revokedAt: null, expiresAt: { $gt: at } },
        { $inc: { views: 1 }, $set: { lastViewedAt: at } },
        { returnDocument: 'after' },
      ).lean();
      if (!link) throw notFound();
      const [report, session, profile] = await Promise.all([
        visibleReport(link.userId, link.sessionId),
        InterviewSessionModel.findById(link.sessionId, { mode: 1 }).lean(),
        UserProfileModel.findOne({ userId: link.userId }, { displayName: 1 }).lean(),
      ]);
      // A report hidden later (for example by a campaign) stops being shareable.
      if (!report || !session) throw notFound();
      const c = report.content;
      return {
        candidateName: profile?.displayName ?? null,
        roleTitle: c.header.title,
        mode: session.mode,
        completedAt: c.header.endedAt,
        overall: c.overall.score,
        band: c.overall.band,
        confidence: c.overall.confidence.level,
        dimensions: c.dimensions.map((d) => ({ name: d.name, score: d.score, weight: d.weight })),
        reviewed: report.revision > 0,
        expiresAt: iso(link.expiresAt),
        disclaimer: c.disclaimer,
      };
    },
  };
}

export type ProofService = ReturnType<typeof createProofService>;

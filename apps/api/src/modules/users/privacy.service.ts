import {
  AuthIdentityModel,
  BadgeAwardModel,
  CampaignApplicationModel,
  CertificateModel,
  CampaignModel,
  CodingAttemptModel,
  DesignAttemptModel,
  ConsentModel,
  CreditAccountModel,
  CreditLedgerModel,
  FeedbackModel,
  InterviewReportModel,
  InterviewSessionModel,
  InterviewTurnModel,
  JobTargetModel,
  MediaAssetModel,
  mongoose,
  PlanItemProgressModel,
  PurchaseModel,
  ResumeModel,
  ResumeTailoringModel,
  ShareLinkModel,
  UserModel,
  UserProfileModel,
  UserProgressModel,
  type MediaAssetRecord,
} from '@cbi/db';
import {
  MEDIA_LIMITS,
  type DataExportBundle,
  type DeleteAccountBody,
  type DeleteAccountResponse,
  type OtpChannel,
} from '@cbi/shared-types';
import type { AuditService } from '../../lib/audit.js';
import { AppError } from '../../lib/errors.js';
import type { ClientContext } from '../../lib/request-context.js';
import type { OtpService } from '../auth/otp.service.js';
import type { SessionService } from '../auth/session.service.js';
import type { UserStateCache } from '../auth/user-state.js';

/**
 * Fields never included in an export: credentials, hashes that only make
 * sense with server secrets, internal storage locations and version keys.
 */
const OMIT = new Set([
  '__v',
  'passwordHash',
  'mfa',
  'tokenHash',
  'codeHash',
  'ipHash',
  'secret',
  'recoveryCodeHashes',
  'storageKey',
  'manifestKey',
  'segments',
  'idempotencyKey',
  'promptVersions',
  'planner',
]);

/**
 * Converts a lean MongoDB document into plain JSON for the export: ObjectIds
 * and dates become strings, and omitted fields are removed at every depth.
 */
export function exportable(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  if (value instanceof mongoose.Types.ObjectId) return String(value);
  if (Buffer.isBuffer(value)) return undefined;
  if (Array.isArray(value)) return value.map(exportable);
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      if (OMIT.has(key)) continue;
      const converted = exportable(v);
      if (converted !== undefined) out[key === '_id' ? 'id' : key] = converted;
    }
    return out;
  }
  return value;
}

const rows = (docs: unknown[]) => docs.map((d) => exportable(d) as Record<string, unknown>);

export interface PrivacyDeps {
  audit: AuditService;
  otp: OtpService;
  sessions: SessionService;
  userState: UserStateCache;
  playbackUrl: (asset: MediaAssetRecord) => { url: string; expiresAt: string };
  graceDays: number;
}

/** Candidate data rights: export (access) and erasure requests. */
export function createPrivacyService(deps: PrivacyDeps) {
  return {
    /** Everything the platform holds about the candidate, as one JSON document. */
    async exportData(
      userId: string,
      apiOrigin: string,
      ctx: ClientContext,
    ): Promise<DataExportBundle> {
      const uid = new mongoose.Types.ObjectId(userId);
      const [
        user,
        profile,
        identities,
        consents,
        resumes,
        jobTargets,
        tailorings,
        sessions,
        turns,
        reports,
        coding,
        designs,
        feedback,
        media,
        shareLinks,
        applications,
        purchases,
        ledger,
        account,
        goals,
        planItems,
        badges,
        certificates,
      ] = await Promise.all([
        UserModel.findById(uid).lean(),
        UserProfileModel.findOne({ userId: uid }).lean(),
        AuthIdentityModel.find({ userId: uid }).lean(),
        ConsentModel.find({ userId: uid }).sort({ at: 1 }).lean(),
        ResumeModel.find({ userId: uid }).sort({ createdAt: 1 }).lean(),
        JobTargetModel.find({ userId: uid }).sort({ createdAt: 1 }).lean(),
        ResumeTailoringModel.find({ userId: uid }).sort({ createdAt: 1 }).lean(),
        InterviewSessionModel.find({ userId: uid }).sort({ createdAt: 1 }).lean(),
        InterviewTurnModel.find({ userId: uid }).sort({ sessionId: 1, seq: 1 }).lean(),
        InterviewReportModel.find({ userId: uid }).sort({ generatedAt: 1 }).lean(),
        CodingAttemptModel.find({ userId: uid }).sort({ createdAt: 1 }).lean(),
        DesignAttemptModel.find({ userId: uid }).sort({ createdAt: 1 }).lean(),
        FeedbackModel.find({ userId: uid }).lean(),
        MediaAssetModel.find({ userId: uid, 'deletion.status': 'NONE' }).lean<MediaAssetRecord[]>(),
        ShareLinkModel.find({ userId: uid }).lean(),
        CampaignApplicationModel.find({ userId: uid }).lean(),
        PurchaseModel.find({ userId: uid }).sort({ createdAt: 1 }).lean(),
        CreditLedgerModel.find({ userId: uid }).sort({ createdAt: 1 }).lean(),
        CreditAccountModel.findOne({ userId: uid }).lean(),
        UserProgressModel.findOne({ userId: uid }).lean(),
        PlanItemProgressModel.find({ userId: uid }).sort({ createdAt: 1 }).lean(),
        BadgeAwardModel.find({ userId: uid }).sort({ awardedAt: 1 }).lean(),
        CertificateModel.find({ userId: uid }).sort({ issuedAt: 1 }).lean(),
      ]);
      if (!user) throw AppError.unauthenticated();

      const campaigns = new Map(
        (
          await CampaignModel.find(
            { _id: { $in: applications.map((a) => a.campaignId) } },
            { name: 1, companyName: 1 },
          ).lean()
        ).map((c) => [String(c._id), c]),
      );

      const now = new Date();
      const recordings = media.map((asset) => {
        const link = deps.playbackUrl(asset);
        return {
          ...(exportable(asset) as Record<string, unknown>),
          playbackUrl: `${apiOrigin}${link.url}`,
          playbackUrlExpiresAt: link.expiresAt,
        };
      });

      await deps.audit.record(
        {
          actorType: 'USER',
          actorId: userId,
          action: 'privacy.data_exported',
          resourceType: 'user',
          resourceId: userId,
        },
        ctx,
      );

      return {
        format: 'careerpilot-interview-export/v1',
        generatedAt: now.toISOString(),
        account: exportable(user) as Record<string, unknown>,
        profile: profile ? (exportable(profile) as Record<string, unknown>) : null,
        identities: rows(identities),
        consents: rows(consents),
        resumes: rows(resumes),
        jobDescriptions: rows(jobTargets),
        resumeTailorings: rows(tailorings),
        interviews: rows(sessions),
        transcripts: turns.map((t) => ({
          interviewId: String(t.sessionId),
          seq: t.seq,
          round: t.roundType,
          question: t.question.text,
          askedAt: t.askedAt.toISOString(),
          answer: exportable(t.answer),
        })),
        reports: rows(reports),
        codingAttempts: rows(coding),
        designAttempts: rows(designs),
        feedback: rows(feedback),
        recordings,
        shareLinks: rows(shareLinks),
        progress: {
          goals: goals ? (exportable(goals) as Record<string, unknown>) : null,
          planItems: rows(planItems),
          badges: rows(badges),
          certificates: rows(certificates),
        },
        campaignApplications: applications.map((a) => ({
          ...(exportable(a) as Record<string, unknown>),
          campaign: campaigns.get(String(a.campaignId))?.name ?? null,
          organisation: campaigns.get(String(a.campaignId))?.companyName ?? null,
        })),
        purchases: rows(purchases),
        creditLedger: rows(ledger),
        creditBalance: account
          ? { balance: account.balance, reserved: account.reserved, lots: exportable(account.lots) }
          : null,
        linksExpireAt: new Date(now.getTime() + MEDIA_LIMITS.playbackTtlSec * 1000).toISOString(),
      };
    },

    /** Sends a re-verification code to the candidate's own verified email or mobile. */
    async requestReauth(userId: string, channel: OtpChannel, ctx: ClientContext) {
      const user = await UserModel.findById(userId).lean();
      const destination =
        channel === 'EMAIL'
          ? user?.emailVerifiedAt && user.primaryEmail
          : user?.mobileVerifiedAt && user.primaryMobile;
      if (!destination) {
        throw AppError.validation(
          channel === 'EMAIL'
            ? 'Your account has no verified email address.'
            : 'Your account has no verified mobile number.',
        );
      }
      return deps.otp.request({
        audience: 'candidate',
        purpose: 'REAUTH',
        channel,
        rawDestination: destination,
        userId,
        ctx,
      });
    },

    /**
     * Locks the account and schedules erasure. Every session ends now; signing
     * in again before `scheduledFor` cancels the request.
     */
    async requestDeletion(
      userId: string,
      body: DeleteAccountBody,
      ctx: ClientContext,
    ): Promise<DeleteAccountResponse> {
      const user = await UserModel.findById(userId).lean();
      if (!user) throw AppError.unauthenticated();
      if (user.adminRoles.length > 0) {
        throw AppError.conflict(
          'Staff accounts cannot be deleted here. Ask a super admin to remove your admin access first.',
        );
      }
      if (body.method === 'OTP') {
        await deps.otp.verify({
          audience: 'candidate',
          purpose: 'REAUTH',
          challengeId: body.challengeId,
          code: body.code,
          userId,
          ctx,
        });
      }
      const requestedAt = new Date();
      const scheduledFor = new Date(requestedAt.getTime() + deps.graceDays * 24 * 3600 * 1000);
      const res = await UserModel.updateOne(
        { _id: userId, status: 'ACTIVE' },
        {
          $set: {
            status: 'DELETION_PENDING',
            deletion: { requestedAt, scheduledFor, method: body.method, completedAt: null },
          },
        },
      );
      if (res.modifiedCount !== 1) {
        throw new AppError(409, 'INVALID_STATE', 'This account cannot be deleted right now.');
      }
      await deps.sessions.revokeAll(userId, 'ACCOUNT_DELETION');
      await deps.userState.invalidate(userId);
      await deps.audit.record(
        {
          actorType: 'USER',
          actorId: userId,
          action: 'privacy.deletion_requested',
          resourceType: 'user',
          resourceId: userId,
          details: { method: body.method, scheduledFor: scheduledFor.toISOString() },
        },
        ctx,
      );
      return { scheduledFor: scheduledFor.toISOString(), graceDays: deps.graceDays };
    },
  };
}

export type PrivacyService = ReturnType<typeof createPrivacyService>;

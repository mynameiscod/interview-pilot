import type { Types } from 'mongoose';
import { deleteMediaAsset, type MediaStorage } from './media.js';
import { AuthIdentityModel } from './models/auth-identity.js';
import { CampaignApplicationModel, ReviewRevisionModel } from './models/campaign.js';
import { CodingAttemptModel } from './models/coding.js';
import {
  FeedbackModel,
  InterviewEvidenceModel,
  InterviewReportModel,
  InterviewScoreModel,
} from './models/evaluation.js';
import { JobTargetModel, ResumeModel } from './models/inputs.js';
import { InterviewSessionModel } from './models/interview-session.js';
import { InterviewTurnModel } from './models/interview-turn.js';
import { IntegrityEventModel, MediaAssetModel } from './models/media.js';
import { AnalyticsEventModel, ShareLinkModel } from './models/ops.js';
import {
  BadgeAwardModel,
  CertificateModel,
  PlanItemProgressModel,
  UserProgressModel,
} from './models/progress.js';
import { OtpChallengeModel } from './models/otp-challenge.js';
import { RefreshTokenModel } from './models/refresh-token.js';
import { UserProfileModel } from './models/user-profile.js';
import { UserModel } from './models/user.js';

/**
 * Account erasure (DPDP Act 2023 s.12) after the deletion grace period.
 *
 * Deleted: resumes and job descriptions (files and text), interviews with
 * their turns (transcripts), evidence, scores, reports and PDFs, feedback,
 * coding attempts, integrity observations, recordings, review revisions,
 * campaign applications, proof share links, sign-in identities, refresh
 * sessions, OTP challenges and the profile.
 *
 * Retained, pseudonymised: purchases, payments, coupon redemptions and the
 * credit ledger (Indian tax and accounting law). They only reference the user
 * id, and the user record becomes a tombstone without contact details, so
 * they no longer identify anyone. Consent records (proof of consent, s.6(10))
 * and the audit log are kept the same way. Analytics events lose their user id.
 *
 * Idempotent: storage objects are deleted first; a storage failure throws and
 * leaves the account DELETION_PENDING so the next sweep retries.
 */

export type ErasureStorage = MediaStorage;

export interface ErasureResult {
  userId: string;
  storageObjects: number;
  documents: Record<string, number>;
}

/** Every stored object that belongs to the person's inputs and reports (recordings are separate). */
export function erasureStorageKeys(input: {
  resumes: { storageKey: string | null }[];
  jobTargets: { storageKey: string | null }[];
  reports: { pdf?: { storageKey: string | null } | null }[];
}): string[] {
  const keys = [
    ...input.resumes.map((r) => r.storageKey),
    ...input.jobTargets.map((t) => t.storageKey),
    ...input.reports.map((r) => r.pdf?.storageKey ?? null),
  ].filter((k): k is string => typeof k === 'string' && k.length > 0);
  return [...new Set(keys)];
}

/** The tombstone left in `users`: no contact details, no credentials, no roles. */
export function tombstoneUpdate(now: Date) {
  return {
    $set: { status: 'DELETED', 'deletion.completedAt': now, adminRoles: [] },
    $unset: {
      primaryEmail: '',
      primaryMobile: '',
      emailVerifiedAt: '',
      mobileVerifiedAt: '',
      passwordHash: '',
      passwordSetAt: '',
      mfa: '',
      suspension: '',
      invitedBy: '',
      lastLoginAt: '',
      onboardingCompletedAt: '',
    },
    $inc: { tokenVersion: 1 },
  } as const;
}

/**
 * Evaluation revisions and similar logs refuse deletes through Mongoose
 * middleware (they are immutable in normal operation). Erasure is the one
 * lawful exception, so it goes to the collection driver directly.
 */
async function hardDelete(
  model: { collection: { deleteMany(filter: object): Promise<{ deletedCount: number }> } },
  filter: object,
) {
  return (await model.collection.deleteMany(filter)).deletedCount;
}

export async function eraseAccount(
  userId: Types.ObjectId | string,
  storage: ErasureStorage,
  opts: { now?: Date } = {},
): Promise<ErasureResult | null> {
  const now = opts.now ?? new Date();
  const user = await UserModel.findOne({ _id: userId, status: 'DELETION_PENDING' }).lean();
  if (!user) return null;
  const uid = user._id;

  const [resumes, jobTargets, sessions, reports, media, certificates] = await Promise.all([
    ResumeModel.find({ userId: uid }, { storageKey: 1 }).lean(),
    JobTargetModel.find({ userId: uid }, { storageKey: 1 }).lean(),
    InterviewSessionModel.find({ userId: uid }, { _id: 1 }).lean(),
    InterviewReportModel.find({ userId: uid }, { pdf: 1 }).lean(),
    MediaAssetModel.find({ userId: uid }, { _id: 1 }).lean(),
    CertificateModel.find({ userId: uid }, { pdf: 1 }).lean(),
  ]);

  // 1. Stored objects (idempotent; a failure aborts before any record is removed).
  // Certificate PDFs are stored like report PDFs.
  const keys = erasureStorageKeys({ resumes, jobTargets, reports: [...reports, ...certificates] });
  for (const key of keys) await storage.delete(key);
  for (const asset of media) {
    await deleteMediaAsset(asset._id, storage, { reason: 'ACCOUNT_ERASURE', by: 'SYSTEM', now });
  }

  // 2. Records.
  const sessionIds = sessions.map((s) => s._id);
  const bySession = { sessionId: { $in: sessionIds } };
  const contacts = [user.primaryEmail, user.primaryMobile].filter(Boolean) as string[];
  const documents: Record<string, number> = {
    resumes: await hardDelete(ResumeModel, { userId: uid }),
    jobTargets: await hardDelete(JobTargetModel, { userId: uid }),
    interviewTurns: await hardDelete(InterviewTurnModel, { userId: uid }),
    interviewEvidence: await hardDelete(InterviewEvidenceModel, { userId: uid }),
    interviewScores: await hardDelete(InterviewScoreModel, { userId: uid }),
    interviewReports: await hardDelete(InterviewReportModel, { userId: uid }),
    feedback: await hardDelete(FeedbackModel, { userId: uid }),
    codingAttempts: await hardDelete(CodingAttemptModel, { userId: uid }),
    integrityEvents: await hardDelete(IntegrityEventModel, { userId: uid }),
    mediaAssets: await hardDelete(MediaAssetModel, { userId: uid }),
    reviewRevisions: await hardDelete(ReviewRevisionModel, bySession),
    campaignApplications: await hardDelete(CampaignApplicationModel, { userId: uid }),
    shareLinks: await hardDelete(ShareLinkModel, { userId: uid }),
    certificates: await hardDelete(CertificateModel, { userId: uid }),
    planItemProgress: await hardDelete(PlanItemProgressModel, { userId: uid }),
    userProgress: await hardDelete(UserProgressModel, { userId: uid }),
    badgeAwards: await hardDelete(BadgeAwardModel, { userId: uid }),
    interviewSessions: await hardDelete(InterviewSessionModel, { userId: uid }),
    authIdentities: await hardDelete(AuthIdentityModel, { userId: uid }),
    refreshTokens: await hardDelete(RefreshTokenModel, { userId: uid }),
    otpChallenges: await hardDelete(OtpChallengeModel, {
      $or: [{ userId: uid }, ...(contacts.length ? [{ destination: { $in: contacts } }] : [])],
    }),
    userProfiles: await hardDelete(UserProfileModel, { userId: uid }),
  };
  documents.analyticsEventsAnonymised = (
    await AnalyticsEventModel.updateMany({ userId: uid }, { $set: { userId: null } })
  ).modifiedCount;

  // 3. The tombstone (keeps retained tax records' references valid).
  await UserModel.updateOne({ _id: uid, status: 'DELETION_PENDING' }, tombstoneUpdate(now));

  return { userId: String(uid), storageObjects: keys.length + media.length, documents };
}

/** Accounts whose grace period has ended, oldest first. */
export async function dueErasures(now: Date, limit = 20): Promise<Types.ObjectId[]> {
  const rows = await UserModel.find(
    { status: 'DELETION_PENDING', 'deletion.scheduledFor': { $lte: now } },
    { _id: 1 },
  )
    .sort({ 'deletion.scheduledFor': 1 })
    .limit(limit)
    .lean();
  return rows.map((r) => r._id);
}

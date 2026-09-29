import {
  AiModelModel,
  AiProviderModel,
  AiRouteModel,
  AiUsageModel,
  PromptTemplateModel,
  ProviderHealthModel,
} from './models/ai.js';
import {
  AUDIT_LOG_RETENTION_DAYS_DEFAULT,
  AUDIT_LOG_TTL_KEY,
  AuditLogModel,
} from './models/audit-log.js';
import {
  CampaignApplicationModel,
  CampaignExportModel,
  CampaignModel,
  ReviewRevisionModel,
} from './models/campaign.js';
import {
  AnalyticsDailyModel,
  AnalyticsEventModel,
  FeatureFlagModel,
  IntegrationConfigModel,
  ShareLinkModel,
  SystemSettingModel,
} from './models/ops.js';
import { CodingAttemptModel, ProblemModel } from './models/coding.js';
import {
  BadgeAwardModel,
  CertificateModel,
  PlanItemProgressModel,
  UserProgressModel,
} from './models/progress.js';
import { ConsentModel, ConsentTextModel } from './models/consent.js';
import { IntegrityEventModel, MediaAssetModel } from './models/media.js';
import {
  CouponModel,
  CouponRedemptionModel,
  CouponUserUsageModel,
  PaymentModel,
  PlanModel,
  PurchaseModel,
  WebhookEventModel,
} from './models/commerce.js';
import { CreditAccountModel, CreditLedgerModel } from './models/credits.js';
import {
  FeedbackModel,
  InterviewEvidenceModel,
  InterviewReportModel,
  InterviewScoreModel,
} from './models/evaluation.js';
import { InterviewTurnModel } from './models/interview-turn.js';
import { JobTargetModel, ResumeModel } from './models/inputs.js';
import { InterviewSessionModel } from './models/interview-session.js';
import {
  CompanyModel,
  InterviewTemplateModel,
  RoleBlueprintModel,
  RoleModel,
} from './models/library.js';
import { AuthIdentityModel } from './models/auth-identity.js';
import { OtpChallengeModel } from './models/otp-challenge.js';
import { RefreshTokenModel } from './models/refresh-token.js';
import { UserProfileModel } from './models/user-profile.js';
import { UserModel } from './models/user.js';

const MODELS = [
  UserModel,
  UserProfileModel,
  AuthIdentityModel,
  RefreshTokenModel,
  OtpChallengeModel,
  AuditLogModel,
  AiProviderModel,
  AiModelModel,
  AiRouteModel,
  AiUsageModel,
  ProviderHealthModel,
  PromptTemplateModel,
  ResumeModel,
  JobTargetModel,
  CompanyModel,
  RoleModel,
  RoleBlueprintModel,
  InterviewTemplateModel,
  InterviewSessionModel,
  InterviewTurnModel,
  CreditLedgerModel,
  CreditAccountModel,
  InterviewEvidenceModel,
  InterviewScoreModel,
  InterviewReportModel,
  FeedbackModel,
  PlanModel,
  CouponModel,
  CouponRedemptionModel,
  CouponUserUsageModel,
  PurchaseModel,
  PaymentModel,
  WebhookEventModel,
  ConsentTextModel,
  ConsentModel,
  MediaAssetModel,
  IntegrityEventModel,
  ProblemModel,
  CodingAttemptModel,
  CampaignModel,
  CampaignApplicationModel,
  CampaignExportModel,
  ReviewRevisionModel,
  AnalyticsEventModel,
  AnalyticsDailyModel,
  FeatureFlagModel,
  SystemSettingModel,
  ShareLinkModel,
  IntegrationConfigModel,
  PlanItemProgressModel,
  UserProgressModel,
  BadgeAwardModel,
  CertificateModel,
];

export interface EnsureIndexesOptions {
  /** Days audit log entries are kept (default 730). */
  auditLogRetentionDays?: number;
}

/**
 * Creates every declared index (unique, TTL, query). Idempotent; never drops
 * indexes. Run at API startup so correctness does not depend on Mongoose
 * autoIndex, which is disabled in production.
 */
export async function ensureIndexes(opts: EnsureIndexesOptions = {}): Promise<void> {
  for (const model of MODELS) await model.createIndexes();
  await ensureAuditLogRetention(opts.auditLogRetentionDays ?? AUDIT_LOG_RETENTION_DAYS_DEFAULT);
}

interface IndexInfo {
  name?: string;
  key: Record<string, unknown>;
  expireAfterSeconds?: number;
}

export type TtlIndexPlan =
  { op: 'create' } | { op: 'collMod'; name: string; from: number | null } | { op: 'none' };

const sameKey = (a: Record<string, unknown>, b: Record<string, unknown>) =>
  JSON.stringify(Object.entries(a)) === JSON.stringify(Object.entries(b));

/**
 * What to do so that the index on `key` expires documents after `seconds`:
 * create it, change its expiry in place (collMod; this also turns a plain
 * index into a TTL one), or nothing. createIndex alone would fail on an
 * existing index with different options.
 */
export function planTtlIndex(
  existing: readonly IndexInfo[],
  key: Record<string, unknown>,
  seconds: number,
): TtlIndexPlan {
  const index = existing.find((i) => sameKey(i.key, key));
  if (!index) return { op: 'create' };
  if (index.expireAfterSeconds === seconds) return { op: 'none' };
  return { op: 'collMod', name: index.name!, from: index.expireAfterSeconds ?? null };
}

/** Applies the audit log retention (AUDIT_LOG_RETENTION_DAYS) to its TTL index. */
export async function ensureAuditLogRetention(days: number): Promise<TtlIndexPlan> {
  const seconds = Math.round(days * 24 * 3600);
  const collection = AuditLogModel.collection;
  const existing = (await collection.listIndexes().toArray()) as IndexInfo[];
  const plan = planTtlIndex(existing, AUDIT_LOG_TTL_KEY, seconds);
  if (plan.op === 'create') {
    await collection.createIndex(AUDIT_LOG_TTL_KEY, { expireAfterSeconds: seconds });
  } else if (plan.op === 'collMod') {
    await collection.db.command({
      collMod: collection.collectionName,
      index: { name: plan.name, expireAfterSeconds: seconds },
    });
  }
  return plan;
}

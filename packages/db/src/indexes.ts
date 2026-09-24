import {
  AiModelModel,
  AiProviderModel,
  AiRouteModel,
  AiUsageModel,
  PromptTemplateModel,
  ProviderHealthModel,
} from './models/ai.js';
import { AuditLogModel } from './models/audit-log.js';
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
];

/**
 * Creates every declared index (unique, TTL, query). Idempotent; never drops
 * indexes. Run at API startup so correctness does not depend on Mongoose
 * autoIndex, which is disabled in production.
 */
export async function ensureIndexes(): Promise<void> {
  for (const model of MODELS) await model.createIndexes();
}

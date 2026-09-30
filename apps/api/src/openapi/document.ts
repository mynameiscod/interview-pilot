import { OpenApiGeneratorV31, OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import {
  ActiveSession,
  AdminSignInResponse,
  CandidateDetail,
  CandidatePage,
  CandidateSearchQuery,
  DataExportBundle,
  DeleteAccountBody,
  DeleteAccountResponse,
  LegalInfo,
  MfaCodeBody,
  MfaEnrollment,
  MfaRecoveryCodes,
  MfaSessionResponse,
  MfaStatus,
  MfaVerifyBody,
  PasswordLoginBody,
  ReauthOtpRequestBody,
  SuspendCandidateBody,
  IntegrationSummary,
  IntegrationTestResult,
  TestIntegrationBody,
  UpdateIntegrationBody,
  ClientFlags,
  CostQuery,
  CostReport,
  CreateShareBody,
  CreatedShareLink,
  CertificateStatus,
  CertificateVerification,
  CreateDrillBody,
  DrillResult,
  PlanItemState,
  ProgressOverview,
  UnsubscribeBody,
  UpdateGoalsBody,
  UpdatePlanItemBody,
  Dashboard,
  DateRangeQuery,
  FailedJob,
  FailedJobsQuery,
  FeatureFlag,
  ProofView,
  PublicSystemStatus,
  QueueCounts,
  RetryJobBody,
  RollupBody,
  SettingEntry,
  ShareLinkSummary,
  SystemHealth,
  TrackEventsBody,
  TrackEventsResult,
  UpdateFlagBody,
  UpdateSettingBody,
  AdminInterviewDetail,
  AdminInterviewQuery,
  AdminInterviewRow,
  CampaignResults,
  CampaignExport,
  CampaignListPage,
  CampaignListQuery,
  CampaignResultsExportQuery,
  CampaignResultsQuery,
  CampaignStatusBody,
  CampaignSummary,
  CampaignWithInvite,
  CreateCampaignBody,
  JoinCampaignBody,
  JoinCampaignResult,
  PublicCampaign,
  ReviewFlagBody,
  ReviseScoreBody,
  RotateInviteBody,
  ScoreRevisionSummary,
  UpdateCampaignBody,
  AssistBody,
  CodingWorkspace,
  CreateDesignPromptVersionBody,
  CustomRunBody,
  DesignPromptSummary,
  DesignWorkspace,
  SaveDesignBody,
  CustomRunResult,
  CreateProblemVersionBody,
  ProblemActivationBody,
  ProblemSummary,
  SaveCodeBody,
  ActivateConsentTextBody,
  AdminIntegrityEvent,
  AdminMediaAsset,
  AdminMediaQuery,
  ConsentDecisionBody,
  ConsentTextSummary,
  CreateConsentTextBody,
  FinalizeMediaBody,
  MediaAssetSummary,
  PlaybackUrl,
  PurgeMediaBody,
  SegmentUploadQuery,
  SegmentUploadResult,
  SessionConsents,
  UserConsentEntry,
  DeviceCheckBody,
  SwitchModeBody,
  TranscribeFields,
  VoiceHealth,
  VoiceReadiness,
  VoiceTranscript,
  AdminPurchase,
  AdminPurchaseQuery,
  AdminReconcileResult,
  AdminRefundResult,
  CheckoutOrder,
  CheckoutProfile,
  CouponSummary,
  CreateOrderBody,
  CreatePlanVersionBody,
  MockCheckoutBody,
  MockCheckoutResult,
  PlanActivationBody,
  PlanSummary,
  PublicPlan,
  PurchaseSummary,
  Quote,
  QuoteBody,
  RefundBody,
  RefundPreview,
  UpsertCouponBody,
  VerifyPaymentBody,
  CompareQuery,
  CompareResult,
  FeedbackBody,
  FeedbackSummary,
  ProcessingProgress,
  ReportHistoryItem,
  ReportSummary,
  AdminCreditAccount,
  AdminCreditLookupQuery,
  CreditAdjustmentBody,
  CreditBalance,
  CreditLedgerEntry,
  CreditLedgerQuery,
  InterviewSnapshot,
  BlueprintListQuery,
  BlueprintSummary,
  CompanySummary,
  CreateBlueprintVersionBody,
  CreateInterviewBody,
  CreateJobTargetBody,
  CreateResumeTextBody,
  CreateTemplateVersionBody,
  Extraction,
  InterviewListQuery,
  InterviewSummary,
  JobTargetSummary,
  LibraryReasonBody,
  LibrarySearchItem,
  LibrarySearchQuery,
  PatternVerificationBody,
  PromoteBlueprintBody,
  ResumeMatchReport,
  ResumeSummary,
  ResumeTailoringSummary,
  ResumeToolsBody,
  RoleSummary,
  StartInterviewBody,
  TemplateSummary,
  UpdateInterviewSetupBody,
  UpdateJdStructuredBody,
  UpdateJobTargetBody,
  UpdateResumeStructuredBody,
  UploadJobTargetFields,
  UpsertCompanyBody,
  UpsertRoleBody,
  ActivatePromptBody,
  AddAiModelPriceBody,
  AdminMeResponse,
  AiModelHealth,
  AiModelSummary,
  AiProviderSummary,
  AiRouteSummary,
  AiUsageEntriesPage,
  AiUsageEntriesQuery,
  AiUsageReport,
  CreateAiModelBody,
  CreatePromptVersionBody,
  PromptListQuery,
  PromptTemplateSummary,
  RemoveAiProviderCredentialBody,
  SetAiProviderCredentialBody,
  TestAiModelResponse,
  UpdateAiModelBody,
  UpdateAiProviderBody,
  UpsertAiRouteBody,
  AdminUserSummary,
  ApiErrorBody,
  AuditLogPage,
  AuditLogExportQuery,
  AuditLogQuery,
  AuthProvidersResponse,
  GoogleLoginBody,
  InviteAdminBody,
  InviteAdminResponse,
  LivenessResponse,
  MeResponse,
  OtpRequestBody,
  OtpRequestResponse,
  OtpVerifyBody,
  ReadinessResponse,
  ResetAdminMfaBody,
  RevokeAdminAccessBody,
  SessionResponse,
  UpdateAdminRolesBody,
  UpdateProfileBody,
} from '@cbi/shared-types';
import { z } from 'zod';
import { registerOrgPaths } from './org-paths.js';

export type OpenApiDocument = ReturnType<OpenApiGeneratorV31['generateDocument']>;

export type Method = 'get' | 'post' | 'put' | 'patch' | 'delete';

export interface RouteSpec {
  summary: string;
  tag: string;
  auth?: 'bearer' | 'refreshCookie';
  body?: z.ZodType;
  /** multipart/form-data body (file uploads). */
  multipart?: z.ZodObject;
  query?: z.ZodObject;
  /** Success response data schema (wrapped in `{ data }`), or null for 204. */
  response: z.ZodType | null;
  status?: 200 | 201 | 202 | 204;
  errors?: number[];
}

/**
 * The OpenAPI document is generated from the same Zod schemas the API and the
 * web apps use, so documentation cannot drift from the contract.
 *
 * Only `registerPath` is used: `registry.register()` relies on a prototype
 * patch that the CommonJS build of zod-to-openapi cannot apply to ESM zod.
 */
export function buildOpenApiDocument(version: string): OpenApiDocument {
  const registry = new OpenAPIRegistry();
  const bearer = registry.registerComponent('securitySchemes', 'bearerAuth', {
    type: 'http',
    scheme: 'bearer',
    bearerFormat: 'JWT',
  });
  const refreshCookie = registry.registerComponent('securitySchemes', 'refreshCookie', {
    type: 'apiKey',
    in: 'cookie',
    name: 'cbi_rt',
    description:
      'httpOnly refresh cookie (`cbi_rt` / `cbi_admin_rt`; `__Secure-` prefix over HTTPS). Requests must also send `X-CB-CSRF: 1`.',
  });

  const route = (method: Method, path: string, spec: RouteSpec) => {
    const status = spec.status ?? (spec.response ? 200 : 204);
    const errors = Object.fromEntries(
      (spec.errors ?? [400, 401, 429]).map((code) => [
        code,
        { description: 'Error', content: { 'application/json': { schema: ApiErrorBody } } },
      ]),
    );
    registry.registerPath({
      method,
      path: `/api/v1${path}`,
      tags: [spec.tag],
      summary: spec.summary,
      security:
        spec.auth === 'bearer'
          ? [{ [bearer.name]: [] }]
          : spec.auth === 'refreshCookie'
            ? [{ [refreshCookie.name]: [] }]
            : undefined,
      request: {
        ...(spec.body ? { body: { content: { 'application/json': { schema: spec.body } } } } : {}),
        ...(spec.multipart
          ? { body: { content: { 'multipart/form-data': { schema: spec.multipart } } } }
          : {}),
        ...(spec.query ? { query: spec.query } : {}),
      },
      responses: {
        [status]: spec.response
          ? {
              description: 'Success',
              content: { 'application/json': { schema: z.object({ data: spec.response }) } },
            }
          : { description: 'No content' },
        ...errors,
      },
    });
  };

  // ---- Operations ------------------------------------------------------------
  registry.registerPath({
    method: 'get',
    path: '/healthz',
    tags: ['Operations'],
    summary: 'Liveness probe',
    responses: {
      200: {
        description: 'Process is running',
        content: { 'application/json': { schema: LivenessResponse } },
      },
    },
  });
  registry.registerPath({
    method: 'get',
    path: '/readyz',
    tags: ['Operations'],
    summary: 'Readiness probe (MongoDB, Redis, draining state)',
    responses: {
      200: {
        description: 'Ready to receive traffic',
        content: { 'application/json': { schema: ReadinessResponse } },
      },
      503: {
        description: 'Not ready; a dependency is down or the process is draining',
        content: { 'application/json': { schema: ReadinessResponse } },
      },
    },
  });

  // ---- Authentication (candidate and admin share the same shapes) -----------
  for (const [prefix, tag] of [
    ['/auth', 'Candidate auth'],
    ['/admin/auth', 'Admin auth'],
    ['/org/auth', 'Org auth'],
  ] as const) {
    route('get', `${prefix}/providers`, {
      tag,
      summary: 'Which sign-in methods are enabled',
      response: AuthProvidersResponse,
      errors: [],
    });
    route('post', `${prefix}/otp/request`, {
      tag,
      summary: 'Send a one-time code by email or SMS',
      body: OtpRequestBody,
      response: OtpRequestResponse,
      status: 202,
      errors: [400, 429, 503],
    });
    route('post', `${prefix}/otp/verify`, {
      tag,
      summary: 'Verify the code and start a session (sets the refresh cookie)',
      body: OtpVerifyBody,
      response: SessionResponse,
      errors: [400, 403, 429],
    });
    route('post', `${prefix}/google`, {
      tag,
      summary: 'Sign in with a Google Identity Services ID token',
      body: GoogleLoginBody,
      response: SessionResponse,
      errors: [400, 401, 403, 429, 503],
    });
    route('post', `${prefix}/refresh`, {
      tag,
      summary: 'Rotate the refresh token and get a new access token',
      auth: 'refreshCookie',
      response: SessionResponse,
      errors: [401, 403, 429],
    });
    route('post', `${prefix}/logout`, {
      tag,
      summary: 'End this session',
      auth: 'refreshCookie',
      response: null,
      errors: [403],
    });
    route('post', `${prefix}/logout-all`, {
      tag,
      summary: 'End every session on every device',
      auth: 'bearer',
      response: null,
      errors: [401, 403],
    });
    route('get', `${prefix}/sessions`, {
      tag,
      summary: 'Signed-in devices for this app',
      auth: 'bearer',
      response: z.array(ActiveSession),
      errors: [401, 403],
    });
    route('delete', `${prefix}/sessions/{id}`, {
      tag,
      summary: 'Sign one device out (it can no longer refresh)',
      auth: 'bearer',
      response: null,
      errors: [401, 403, 404],
    });
  }
  route('post', '/admin/auth/password/login', {
    tag: 'Admin auth',
    summary: 'Email and password; answers a session or a second-factor challenge',
    body: PasswordLoginBody,
    response: AdminSignInResponse,
    errors: [400, 401, 403, 429],
  });
  route('post', '/org/auth/mfa/verify', {
    tag: 'Org auth',
    summary:
      'Second sign-in step when the organisation requires an authenticator (or the member set one up)',
    body: MfaVerifyBody,
    response: MfaSessionResponse,
    errors: [400, 401, 403, 429],
  });
  route('post', '/admin/auth/mfa/verify', {
    tag: 'Admin auth',
    summary: 'Second sign-in step: authenticator or recovery code (sets the refresh cookie)',
    body: MfaVerifyBody,
    response: MfaSessionResponse,
    errors: [400, 401, 403, 429],
  });
  route('get', '/admin/auth/mfa', {
    tag: 'Admin auth',
    summary: 'Two-factor status for the signed-in admin',
    auth: 'bearer',
    response: MfaStatus,
    errors: [401, 403],
  });
  route('post', '/admin/auth/mfa/enroll', {
    tag: 'Admin auth',
    summary: 'Start setting up an authenticator app (secret and otpauth URI)',
    auth: 'bearer',
    response: MfaEnrollment,
    errors: [401, 403, 409, 429],
  });
  route('post', '/admin/auth/mfa/enroll/confirm', {
    tag: 'Admin auth',
    summary: 'Confirm set-up with a code; returns recovery codes (shown once)',
    auth: 'bearer',
    body: MfaCodeBody,
    response: MfaRecoveryCodes,
    errors: [400, 401, 403, 429],
  });
  route('post', '/admin/auth/mfa/recovery-codes', {
    tag: 'Admin auth',
    summary: 'Replace the recovery codes (needs a current code)',
    auth: 'bearer',
    body: MfaCodeBody,
    response: MfaRecoveryCodes,
    errors: [400, 401, 403, 409, 429],
  });
  route('post', '/admin/auth/mfa/disable', {
    tag: 'Admin auth',
    summary: 'Turn two-factor off (not allowed when required for the role)',
    auth: 'bearer',
    body: MfaCodeBody,
    response: null,
    errors: [400, 401, 403, 429],
  });
  route('post', '/auth/link/otp/request', {
    tag: 'Candidate auth',
    summary: 'Send a code to an email/mobile to link to the signed-in account',
    auth: 'bearer',
    body: OtpRequestBody,
    response: OtpRequestResponse,
    status: 202,
    errors: [400, 401, 429, 503],
  });
  route('post', '/auth/link/otp/verify', {
    tag: 'Candidate auth',
    summary: 'Verify and link the email/mobile',
    auth: 'bearer',
    body: OtpVerifyBody,
    response: MeResponse,
    errors: [400, 401, 409, 429],
  });
  route('post', '/auth/link/google', {
    tag: 'Candidate auth',
    summary: 'Link a Google account',
    auth: 'bearer',
    body: GoogleLoginBody,
    response: MeResponse,
    errors: [400, 401, 409, 429, 503],
  });

  // ---- Users -------------------------------------------------------------------
  route('get', '/users/me', {
    tag: 'Users',
    summary: 'The signed-in candidate',
    auth: 'bearer',
    response: MeResponse,
    errors: [401, 403],
  });
  route('patch', '/users/me/profile', {
    tag: 'Users',
    summary: 'Save onboarding/profile details',
    auth: 'bearer',
    body: UpdateProfileBody,
    response: MeResponse,
    errors: [400, 401, 403],
  });
  route('get', '/legal', {
    tag: 'Users',
    summary: 'Public details for the legal pages (grievance officer, retention periods)',
    response: LegalInfo,
    errors: [],
  });
  route('get', '/users/me/export', {
    tag: 'Users',
    summary: 'Download a copy of my data (DPDP right of access)',
    auth: 'bearer',
    response: DataExportBundle,
    errors: [401, 403, 429],
  });
  route('post', '/users/me/reauth/otp', {
    tag: 'Users',
    summary: 'Send a re-verification code to my own email or mobile',
    auth: 'bearer',
    body: ReauthOtpRequestBody,
    response: OtpRequestResponse,
    status: 202,
    errors: [400, 401, 403, 429, 503],
  });
  route('delete', '/users/me', {
    tag: 'Users',
    summary: 'Delete my account: locked now, erased after the grace period (sign-in cancels)',
    auth: 'bearer',
    body: DeleteAccountBody,
    response: DeleteAccountResponse,
    status: 202,
    errors: [400, 401, 403, 409, 429],
  });

  // ---- Admin -------------------------------------------------------------------
  route('get', '/admin/me', {
    tag: 'Admin',
    summary: 'The signed-in admin, with effective permissions',
    auth: 'bearer',
    response: AdminMeResponse,
    errors: [401, 403],
  });
  route('get', '/admin/users', {
    tag: 'Admin',
    summary: 'List admin accounts (admin_users.read)',
    auth: 'bearer',
    response: z.array(AdminUserSummary),
    errors: [401, 403],
  });
  route('post', '/admin/users', {
    tag: 'Admin',
    summary: 'Invite an admin (admin_users.manage)',
    auth: 'bearer',
    body: InviteAdminBody,
    response: InviteAdminResponse,
    status: 201,
    errors: [400, 401, 403, 409],
  });
  route('put', '/admin/users/{id}/roles', {
    tag: 'Admin',
    summary: "Replace an admin's roles (admin_users.manage)",
    auth: 'bearer',
    body: UpdateAdminRolesBody,
    response: AdminUserSummary,
    errors: [400, 401, 403, 404, 409],
  });
  route('post', '/admin/users/{id}/reset-mfa', {
    tag: 'Admin',
    summary:
      "Reset another admin's two-factor authentication, confirmed with your own authenticator code; signs them out everywhere, audited (admin_users.manage)",
    auth: 'bearer',
    body: ResetAdminMfaBody,
    response: AdminUserSummary,
    errors: [400, 401, 403, 404, 409],
  });
  route('post', '/admin/users/{id}/revoke-access', {
    tag: 'Admin',
    summary: 'Remove all admin roles and end admin sessions (admin_users.manage)',
    auth: 'bearer',
    body: RevokeAdminAccessBody,
    response: null,
    errors: [400, 401, 403, 404, 409],
  });
  route('get', '/admin/candidates', {
    tag: 'Admin',
    summary: 'Search candidates by email, mobile or name (candidates.read)',
    auth: 'bearer',
    query: CandidateSearchQuery,
    response: CandidatePage,
    errors: [400, 401, 403],
  });
  route('get', '/admin/candidates/{id}', {
    tag: 'Admin',
    summary: 'A candidate: profile, credits, interviews, purchases, consents (candidates.read)',
    auth: 'bearer',
    response: CandidateDetail,
    errors: [401, 403, 404],
  });
  route('post', '/admin/candidates/{id}/suspend', {
    tag: 'Admin',
    summary: 'Suspend a candidate and end their sessions (candidates.manage)',
    auth: 'bearer',
    body: SuspendCandidateBody,
    response: null,
    errors: [400, 401, 403, 404, 409],
  });
  route('post', '/admin/candidates/{id}/reinstate', {
    tag: 'Admin',
    summary: 'Lift a suspension (candidates.manage)',
    auth: 'bearer',
    body: SuspendCandidateBody,
    response: null,
    errors: [400, 401, 403, 404, 409],
  });
  route('get', '/admin/audit-logs', {
    tag: 'Admin',
    summary: 'Security and admin audit trail, newest first (audit.read)',
    auth: 'bearer',
    query: AuditLogQuery,
    response: AuditLogPage,
    errors: [400, 401, 403],
  });
  route('get', '/admin/audit-logs/export.csv', {
    tag: 'Admin',
    summary:
      'Every matching audit entry as CSV (text/csv), streamed newest first; same filters (audit.export; audited)',
    auth: 'bearer',
    query: AuditLogExportQuery,
    response: null,
    status: 200,
    errors: [400, 401, 403],
  });

  // ---- Admin: AI provider layer ------------------------------------------------
  const ai = (method: Method, path: string, spec: Omit<RouteSpec, 'tag' | 'auth'>) =>
    route(method, path, { tag: 'Admin AI', auth: 'bearer', errors: [400, 401, 403, 404], ...spec });
  ai('get', '/admin/ai/providers', {
    summary: 'AI providers; credentials are shown as last4 only (ai.read)',
    response: z.array(AiProviderSummary),
  });
  ai('patch', '/admin/ai/providers/{id}', {
    summary: 'Enable/disable a provider or change its base URL, region or notes (ai.manage)',
    body: UpdateAiProviderBody,
    response: AiProviderSummary,
  });
  ai('put', '/admin/ai/providers/{id}/credential', {
    summary: 'Store (encrypt) a provider API key (ai.manage)',
    body: SetAiProviderCredentialBody,
    response: AiProviderSummary,
  });
  ai('delete', '/admin/ai/providers/{id}/credential', {
    summary: 'Remove the stored provider API key (ai.manage)',
    body: RemoveAiProviderCredentialBody,
    response: AiProviderSummary,
    errors: [400, 401, 403, 404, 409],
  });
  ai('get', '/admin/ai/models', {
    summary: 'Models with parameters and effective-dated pricing (ai.read)',
    response: z.array(AiModelSummary),
  });
  ai('post', '/admin/ai/models', {
    summary: 'Add a model to a provider (ai.manage)',
    body: CreateAiModelBody,
    response: AiModelSummary,
    status: 201,
    errors: [400, 401, 403, 404, 409],
  });
  ai('patch', '/admin/ai/models/{id}', {
    summary: 'Change a model’s name, languages, parameters or enabled state (ai.manage)',
    body: UpdateAiModelBody,
    response: AiModelSummary,
  });
  ai('post', '/admin/ai/models/{id}/prices', {
    summary: 'Add a price effective now or later; history is never rewritten (ai.manage)',
    body: AddAiModelPriceBody,
    response: AiModelSummary,
    status: 201,
  });
  ai('post', '/admin/ai/models/{id}/test', {
    summary: 'Send a small billed request straight to the model (ai.manage; 10/min)',
    response: TestAiModelResponse,
    errors: [401, 403, 404, 429],
  });
  ai('get', '/admin/ai/routes', {
    summary: 'Fallback chain per feature (ai.read)',
    response: z.array(AiRouteSummary),
  });
  ai('put', '/admin/ai/routes/{feature}', {
    summary: 'Replace a feature’s fallback chain; applies to every process immediately (ai.manage)',
    body: UpsertAiRouteBody,
    response: AiRouteSummary,
  });
  ai('get', '/admin/ai/usage', {
    summary:
      'Calls, tokens, cost (micro-units per currency) and latency by feature, model or day (ai_usage.read)',
    query: z.object({
      from: z.iso.datetime().optional(),
      to: z.iso.datetime().optional(),
      groupBy: z.enum(['feature', 'model', 'day']).optional(),
      feature: z.string().optional(),
    }),
    response: AiUsageReport,
  });
  ai('get', '/admin/ai/usage/entries', {
    summary: 'Individual metered calls, newest first (ai_usage.read)',
    query: AiUsageEntriesQuery,
    response: AiUsageEntriesPage,
  });
  ai('get', '/admin/ai/health', {
    summary: 'Circuit-breaker state and the latest 5-minute health window per model (ai.read)',
    response: z.array(AiModelHealth),
  });
  ai('get', '/admin/prompts', {
    summary: 'Prompt template versions (prompts.read)',
    query: PromptListQuery,
    response: z.array(PromptTemplateSummary),
  });
  ai('post', '/admin/prompts', {
    summary:
      'Create the next version of a prompt as a DRAFT; content is immutable (prompts.manage)',
    body: CreatePromptVersionBody,
    response: PromptTemplateSummary,
    status: 201,
    errors: [400, 401, 403, 409],
  });
  ai('post', '/admin/prompts/{id}/activate', {
    summary: 'Activate a version and retire the previous one (prompts.manage)',
    body: ActivatePromptBody,
    response: PromptTemplateSummary,
    errors: [400, 401, 403, 404, 409],
  });

  // ---- Candidate inputs and interviews (Phase 3) ----------------------------------
  const file = z.string().meta({
    format: 'binary',
    description: 'PDF, DOCX or plain text; the type is detected from the bytes (UPLOAD_MAX_MB)',
  });
  const candidate = (method: Method, path: string, spec: Omit<RouteSpec, 'auth'>) =>
    route(method, path, { auth: 'bearer', errors: [400, 401, 404, 429], ...spec });
  candidate('post', '/resumes', {
    tag: 'Resumes',
    summary: 'Upload a resume (201 new, 200 when the same file was already uploaded)',
    multipart: z.object({ file }),
    response: ResumeSummary,
    status: 201,
    errors: [400, 401, 409, 413, 415, 429, 503],
  });
  candidate('post', '/resumes/text', {
    tag: 'Resumes',
    summary:
      'Add a resume from pasted text, e.g. a LinkedIn profile copied by the candidate (201 new, 200 duplicate)',
    body: CreateResumeTextBody,
    response: ResumeSummary,
    status: 201,
    errors: [400, 401, 409, 429, 503],
  });
  candidate('get', '/resumes', {
    tag: 'Resumes',
    summary: 'My resumes, newest first',
    response: z.array(ResumeSummary),
  });
  candidate('get', '/resumes/{id}', {
    tag: 'Resumes',
    summary: 'One of my resumes',
    response: ResumeSummary,
  });
  candidate('get', '/resumes/{id}/status', {
    tag: 'Resumes',
    summary: 'Extraction status',
    response: Extraction,
  });
  candidate('delete', '/resumes/{id}', {
    tag: 'Resumes',
    summary: 'Delete a resume and its file',
    response: null,
  });
  candidate('put', '/resumes/{id}/structured', {
    tag: 'Resumes',
    summary:
      'Save my corrections to the parsed resume as a revision that analysis prefers (READY resumes only)',
    body: UpdateResumeStructuredBody,
    response: ResumeSummary,
    errors: [400, 401, 404, 409, 429],
  });
  candidate('delete', '/resumes/{id}/structured', {
    tag: 'Resumes',
    summary: 'Discard my corrections and go back to the AI-read version',
    response: ResumeSummary,
    errors: [400, 401, 404, 409, 429],
  });
  candidate('post', '/jobs', {
    tag: 'Job targets',
    summary:
      'Add a job target: pasted JD, JD URL (fetched by the SSRF-guarded worker) or role only',
    body: CreateJobTargetBody,
    response: JobTargetSummary,
    status: 201,
    errors: [400, 401, 429, 503],
  });
  candidate('post', '/jobs/upload', {
    tag: 'Job targets',
    summary: 'Add a job target from an uploaded JD file',
    multipart: UploadJobTargetFields.extend({ file }),
    response: JobTargetSummary,
    status: 201,
    errors: [400, 401, 413, 415, 429, 503],
  });
  candidate('get', '/jobs', {
    tag: 'Job targets',
    summary: 'My recent job targets',
    response: z.array(JobTargetSummary),
  });
  candidate('get', '/jobs/{id}', {
    tag: 'Job targets',
    summary: 'One of my job targets',
    response: JobTargetSummary,
  });
  candidate('patch', '/jobs/{id}', {
    tag: 'Job targets',
    summary: 'Set the company and role of a job target (omitted fields are cleared)',
    body: UpdateJobTargetBody,
    response: JobTargetSummary,
  });
  candidate('delete', '/jobs/{id}', {
    tag: 'Job targets',
    summary: 'Delete a job description and its file (kept as a title for past interviews)',
    response: null,
  });
  candidate('get', '/jobs/{id}/status', {
    tag: 'Job targets',
    summary: 'Extraction status',
    response: Extraction,
  });
  candidate('put', '/jobs/{id}/structured', {
    tag: 'Job targets',
    summary:
      'Save my corrections to the parsed job description (skills, seniority, responsibilities) as a revision that analysis prefers',
    body: UpdateJdStructuredBody,
    response: JobTargetSummary,
    errors: [400, 401, 404, 409, 429],
  });
  candidate('delete', '/jobs/{id}/structured', {
    tag: 'Job targets',
    summary: 'Discard my corrections and go back to the AI-read version',
    response: JobTargetSummary,
    errors: [400, 401, 404, 409, 429],
  });
  candidate('post', '/resume-tools/match', {
    tag: 'Resume tools',
    summary:
      'Resume ↔ job description match score (0-100, deterministic, itemised reasons); free and rate-limited',
    body: ResumeToolsBody,
    response: ResumeMatchReport,
    errors: [400, 401, 404, 409, 429],
  });
  candidate('post', '/resume-tools/tailorings', {
    tag: 'Resume tools',
    summary:
      'Ask for AI tailoring suggestions (202 queued; 200 reuses unchanged inputs). Poll GET /resume-tools/tailorings/{id}',
    body: ResumeToolsBody,
    response: ResumeTailoringSummary,
    status: 202,
    errors: [400, 401, 404, 409, 429, 503],
  });
  candidate('get', '/resume-tools/tailorings/{id}', {
    tag: 'Resume tools',
    summary: 'Tailoring suggestions (PENDING until the worker finishes)',
    response: ResumeTailoringSummary,
  });
  route('get', '/companies', {
    tag: 'Library',
    summary: 'Search active companies (names only)',
    query: LibrarySearchQuery,
    response: z.array(LibrarySearchItem),
    errors: [400, 429],
  });
  route('get', '/roles', {
    tag: 'Library',
    summary: 'Search active roles by title or alias',
    query: LibrarySearchQuery,
    response: z.array(LibrarySearchItem),
    errors: [400, 429],
  });
  candidate('post', '/interviews', {
    tag: 'Interviews',
    summary: 'Create a DRAFT interview from a job target, optional resume and template',
    body: CreateInterviewBody,
    response: InterviewSummary,
    status: 201,
    errors: [400, 401, 404, 409, 429],
  });
  candidate('get', '/interviews', {
    tag: 'Interviews',
    summary: 'My interviews',
    query: InterviewListQuery,
    response: z.array(InterviewSummary),
  });
  candidate('get', '/interviews/{id}', {
    tag: 'Interviews',
    summary: 'One of my interviews (poll while in ROLE_ANALYSIS)',
    response: InterviewSummary,
  });
  candidate('post', '/interviews/{id}/analyze', {
    tag: 'Interviews',
    summary: 'Start or retry role analysis: DRAFT, FAILED or READY to ROLE_ANALYSIS',
    response: InterviewSummary,
    status: 202,
    errors: [401, 404, 409, 429, 503],
  });
  candidate('patch', '/interviews/{id}/setup', {
    tag: 'Interviews',
    summary: 'Choose mode and language (READY only)',
    body: UpdateInterviewSetupBody,
    response: InterviewSummary,
    errors: [400, 401, 404, 409],
  });
  candidate('post', '/interviews/{id}/start', {
    tag: 'Interviews',
    summary:
      'Start the interview (READY or READY_TO_START → ACTIVE), reserving one credit. The first question arrives in the realtime room. The optional UI locale settles an `auto` interview language when the profile does not',
    body: StartInterviewBody,
    response: InterviewSummary,
    errors: [400, 401, 402, 404, 409],
  });
  candidate('post', '/interviews/{id}/end', {
    tag: 'Interviews',
    summary:
      'End the interview early; it moves to PROCESSING and the credit is consumed only if enough of it was used',
    response: InterviewSummary,
    errors: [401, 404, 409],
  });
  candidate('get', '/interviews/{id}/live', {
    tag: 'Interviews',
    summary:
      'The live snapshot the realtime room sends on join (Socket.IO namespace /rt; see docs/architecture/live-interview.md)',
    response: InterviewSnapshot,
  });
  candidate('get', '/credits/balance', {
    tag: 'Credits',
    summary: 'Available and reserved credits (the one-time free credit is granted on first use)',
    response: CreditBalance,
  });
  candidate('get', '/credits/ledger', {
    tag: 'Credits',
    summary: 'My credit ledger, newest first',
    query: CreditLedgerQuery,
    response: z.array(CreditLedgerEntry),
  });
  candidate('get', '/interviews/{id}/progress', {
    tag: 'Interviews',
    summary: 'Evaluation progress after the interview (stage, status, report ready)',
    response: ProcessingProgress,
  });
  candidate('get', '/reports', {
    tag: 'Reports',
    summary: 'My readiness reports, newest first (history)',
    response: z.array(ReportHistoryItem),
  });
  candidate('get', '/reports/compare', {
    tag: 'Reports',
    summary: 'Compare 2–4 attempts at the same role: dimension scores and change',
    query: CompareQuery,
    response: CompareResult,
  });
  candidate('get', '/reports/{sessionId}', {
    tag: 'Reports',
    summary: 'The latest revision of an interview’s readiness report',
    response: ReportSummary,
  });
  route('get', '/reports/{sessionId}/pdf', {
    tag: 'Reports',
    auth: 'bearer',
    summary: 'Download the report as a PDF (application/pdf); 409 while it is being prepared',
    response: null,
    status: 200,
    errors: [401, 404, 409],
  });
  candidate('get', '/users/me/progress', {
    tag: 'Progress',
    summary:
      'The progress hub: readiness and dimension trends, the current plan with done items, streak, weekly goal and schedule, badges (awarded idempotently on read), drill quota and recent drills',
    response: ProgressOverview,
  });
  candidate('put', '/users/me/progress/goals', {
    tag: 'Progress',
    summary: 'Set the weekly goal (sessions per week) and the optional target interview date',
    body: UpdateGoalsBody,
    response: ProgressOverview,
  });
  candidate('put', '/users/me/progress/plan-items', {
    tag: 'Progress',
    summary: 'Tick a plan item of a report revision done or undone',
    body: UpdatePlanItemBody,
    response: PlanItemState,
  });
  candidate('post', '/drills', {
    tag: 'Progress',
    summary:
      'Create a practice drill on one dimension of the latest interview’s blueprint (reuses an unstarted one). Start it with POST /interviews/{id}/start; free up to `practice.drillsPerDay` a day (402 DRILL_LIMIT_REACHED)',
    body: CreateDrillBody,
    response: InterviewSummary,
    status: 201,
    errors: [400, 401, 402, 403, 404, 409, 429],
  });
  candidate('get', '/drills/{id}', {
    tag: 'Progress',
    summary: 'A drill’s quick evaluation: score, previous score and feedback per question',
    response: DrillResult,
  });
  route('post', '/email/unsubscribe', {
    tag: 'Progress',
    summary:
      'Unsubscribe from product emails with the signed token from an email link (no sign-in; allowed during maintenance)',
    body: UnsubscribeBody,
    response: z.object({ unsubscribed: z.literal(true) }),
    errors: [400, 429],
  });
  candidate('post', '/feedback', {
    tag: 'Feedback',
    summary: 'Rate an interview and its report (one per interview; sending again updates it)',
    body: FeedbackBody,
    response: FeedbackSummary,
    errors: [400, 401, 404, 409],
  });
  candidate('get', '/feedback/{sessionId}', {
    tag: 'Feedback',
    summary: 'My feedback for an interview, or null',
    response: FeedbackSummary.nullable(),
  });
  route('post', '/admin/interviews/{id}/reprocess', {
    tag: 'Admin interviews',
    auth: 'bearer',
    summary:
      'Start a new evaluation run for an interview stuck or failed in PROCESSING (interviews.manage)',
    body: LibraryReasonBody,
    response: z.object({ run: z.number().int() }),
    status: 202,
    errors: [400, 401, 403, 404, 409],
  });
  candidate('post', '/interviews/{id}/cancel', {
    tag: 'Interviews',
    summary: 'Cancel an interview before it starts',
    response: InterviewSummary,
    errors: [401, 404, 409],
  });

  // ---- Admin interview library (Phase 3) -------------------------------------------
  const lib = (method: Method, path: string, spec: Omit<RouteSpec, 'tag' | 'auth'>) =>
    route(method, path, {
      tag: 'Admin library',
      auth: 'bearer',
      errors: [400, 401, 403, 404],
      ...spec,
    });
  const conflict = [400, 401, 403, 404, 409];
  lib('get', '/admin/roles', {
    summary: 'Canonical roles (library.read)',
    response: z.array(RoleSummary),
  });
  lib('post', '/admin/roles', {
    summary: 'Create a role (library.manage)',
    body: UpsertRoleBody,
    response: RoleSummary,
    status: 201,
    errors: conflict,
  });
  lib('put', '/admin/roles/{id}', {
    summary: 'Update a role (library.manage)',
    body: UpsertRoleBody,
    response: RoleSummary,
    errors: conflict,
  });
  lib('get', '/admin/roles/{id}/blueprints', {
    summary: 'Blueprint versions of a role, newest first (library.read)',
    response: z.array(BlueprintSummary),
  });
  lib('post', '/admin/roles/{id}/blueprints', {
    summary: 'Add the next blueprint version as a DRAFT (library.manage)',
    body: CreateBlueprintVersionBody,
    response: BlueprintSummary,
    status: 201,
  });
  lib('get', '/admin/blueprints', {
    summary: 'Recent blueprints, e.g. AI-generated ones to review (library.read)',
    query: BlueprintListQuery,
    response: z.array(BlueprintSummary),
  });
  lib('get', '/admin/blueprints/{id}', {
    summary: 'One blueprint version (library.read)',
    response: BlueprintSummary,
  });
  lib('post', '/admin/blueprints/{id}/activate', {
    summary: 'Activate a role blueprint version and retire the previous one (library.manage)',
    body: LibraryReasonBody,
    response: BlueprintSummary,
    errors: conflict,
  });
  lib('post', '/admin/blueprints/{id}/promote', {
    summary: 'Copy an AI-generated blueprint into a role as a DRAFT (library.manage)',
    body: PromoteBlueprintBody,
    response: BlueprintSummary,
    status: 201,
    errors: conflict,
  });
  lib('get', '/admin/companies', {
    summary: 'Companies with verified interview patterns (library.read)',
    response: z.array(CompanySummary),
  });
  lib('post', '/admin/companies', {
    summary: 'Create a company; new patterns start unverified (library.manage)',
    body: UpsertCompanyBody,
    response: CompanySummary,
    status: 201,
    errors: conflict,
  });
  lib('put', '/admin/companies/{id}', {
    summary: 'Update a company; new or edited patterns start unverified (library.manage)',
    body: UpsertCompanyBody,
    response: CompanySummary,
    errors: conflict,
  });
  lib('post', '/admin/companies/{id}/patterns/verify', {
    summary: 'Verify one interview pattern so it can shape interviews (library.manage, audited)',
    body: PatternVerificationBody,
    response: CompanySummary,
    errors: conflict,
  });
  lib('post', '/admin/companies/{id}/patterns/unverify', {
    summary: 'Withdraw verification of one pattern (library.manage, audited)',
    body: PatternVerificationBody,
    response: CompanySummary,
    errors: conflict,
  });
  lib('get', '/admin/templates', {
    summary: 'Interview template versions (library.read)',
    response: z.array(TemplateSummary),
  });
  lib('post', '/admin/templates', {
    summary: 'Add the next template version as a DRAFT (library.manage)',
    body: CreateTemplateVersionBody,
    response: TemplateSummary,
    status: 201,
  });
  lib('post', '/admin/templates/{id}/activate', {
    summary: 'Activate a template version and retire the previous one (library.manage)',
    body: LibraryReasonBody,
    response: TemplateSummary,
    errors: conflict,
  });

  // ---- Voice (Phase 7) ----------------------------------------------------------------
  candidate('get', '/voice/health', {
    tag: 'Voice',
    summary:
      'Speech recognition and synthesis status (AVAILABLE, DEGRADED = fallback only, UNAVAILABLE)',
    response: VoiceHealth,
    errors: [401],
  });
  candidate('post', '/interviews/{id}/device-check', {
    tag: 'Voice',
    summary: 'Record the browser device check for a voice interview (before starting)',
    body: DeviceCheckBody,
    response: VoiceReadiness,
    errors: [400, 401, 404, 409],
  });
  candidate('post', '/interviews/{id}/voice/transcribe', {
    tag: 'Voice',
    summary:
      'Transcribe a recorded answer to the current question; submit it with answer:text + voiceTranscriptId. 503 SPEECH_UNAVAILABLE also emits interview:degraded',
    multipart: TranscribeFields.extend({
      audio: z.string().meta({
        format: 'binary',
        description:
          'The recorded answer: WebM, Ogg, MP4, MP3 or WAV (detected from the bytes), up to 10 MB',
      }),
    }),
    response: VoiceTranscript,
    errors: [400, 401, 404, 409, 413, 415, 429, 503],
  });
  route('get', '/interviews/{id}/questions/{questionId}/audio', {
    tag: 'Voice',
    auth: 'bearer',
    summary:
      'The spoken question (audio/mpeg or audio/wav), synthesized once and cached; 503 SPEECH_UNAVAILABLE when no TTS model can serve',
    response: null,
    status: 200,
    errors: [401, 404, 429, 503],
  });
  candidate('post', '/interviews/{id}/mode', {
    tag: 'Voice',
    summary: 'Switch a running interview between voice and text (state and clock are unchanged)',
    body: SwitchModeBody,
    response: z.object({ mode: z.enum(['TEXT', 'VOICE']) }),
    errors: [400, 401, 404, 409],
  });

  // ---- Coding (Phase 9) ------------------------------------------------------------------------
  candidate('get', '/interviews/{id}/coding/{questionId}', {
    tag: 'Coding',
    summary:
      'The coding workspace: the problem (visible tests only; hidden ones are counted), your code and results',
    response: CodingWorkspace,
    errors: [401, 404],
  });
  candidate('put', '/interviews/{id}/coding/{questionId}', {
    tag: 'Coding',
    summary: 'Autosave your code (every few seconds and on blur)',
    body: SaveCodeBody,
    response: CodingWorkspace,
    errors: [400, 401, 404, 409, 413],
  });
  candidate('post', '/interviews/{id}/coding/{questionId}/run', {
    tag: 'Coding',
    summary:
      'Run the visible tests on the code judge. 503 JUDGE_UNAVAILABLE when it cannot run (keep working; submit still works)',
    body: SaveCodeBody,
    response: CodingWorkspace,
    errors: [400, 401, 404, 409, 413, 429, 503],
  });
  candidate('post', '/interviews/{id}/coding/{questionId}/custom-run', {
    tag: 'Coding',
    summary:
      'Run the code once with your own input (SQL: statements after the schema). Nothing is compared and it is not a test. Own rate limit; 503 JUDGE_UNAVAILABLE when the judge cannot run it',
    body: CustomRunBody,
    response: CustomRunResult,
    errors: [400, 401, 404, 409, 413, 429, 503],
  });
  candidate('post', '/interviews/{id}/coding/{questionId}/assist', {
    tag: 'Coding',
    summary:
      'AI-allowed rounds only: send one message to the in-editor assistant (the code is saved with it). The whole conversation is kept and evaluated. 403 FEATURE_DISABLED when the round has no assistant, 429 QUOTA_EXCEEDED when its turns are used up',
    body: AssistBody,
    response: CodingWorkspace,
    errors: [400, 401, 403, 404, 409, 413, 429],
  });
  candidate('post', '/interviews/{id}/coding/{questionId}/submit', {
    tag: 'Coding',
    summary:
      'Submit: judged against visible and hidden tests (counts only for hidden), recorded even when the judge is down, and answers the coding question',
    body: SaveCodeBody,
    response: CodingWorkspace,
    errors: [400, 401, 404, 409, 413, 429],
  });
  lib('get', '/admin/problems', {
    summary: 'Coding problem versions, with hidden tests (library.read)',
    response: z.array(ProblemSummary),
  });
  lib('post', '/admin/problems', {
    summary: 'Add the next version of a problem, inactive (library.manage)',
    body: CreateProblemVersionBody,
    response: ProblemSummary,
    status: 201,
  });
  lib('post', '/admin/problems/{id}/activate', {
    summary: 'Make this version the one asked for its key (library.manage)',
    body: ProblemActivationBody,
    response: ProblemSummary,
  });
  lib('post', '/admin/problems/{id}/deactivate', {
    summary: 'Stop asking this problem (library.manage)',
    body: ProblemActivationBody,
    response: ProblemSummary,
  });

  // ---- System design rounds ----------------------------------------------------------------------
  candidate('get', '/interviews/{id}/design/{questionId}', {
    tag: 'Design',
    summary:
      'The design workspace: the prompt (without its rubric), your notes and diagram, and whether it was submitted',
    response: DesignWorkspace,
    errors: [401, 404],
  });
  candidate('put', '/interviews/{id}/design/{questionId}', {
    tag: 'Design',
    summary: 'Autosave the whiteboard and notes (every few seconds while you work)',
    body: SaveDesignBody,
    response: DesignWorkspace,
    errors: [400, 401, 404, 409],
  });
  candidate('post', '/interviews/{id}/design/{questionId}/submit', {
    tag: 'Design',
    summary:
      'Submit the design: it becomes read-only and answers the design question; the interviewer then asks probes about it',
    body: SaveDesignBody,
    response: DesignWorkspace,
    errors: [400, 401, 404, 409, 429],
  });
  lib('get', '/admin/design-prompts', {
    summary: 'System design prompt versions, with their rubric (library.read)',
    response: z.array(DesignPromptSummary),
  });
  lib('post', '/admin/design-prompts', {
    summary: 'Add the next version of a design prompt, inactive (library.manage)',
    body: CreateDesignPromptVersionBody,
    response: DesignPromptSummary,
    status: 201,
  });
  lib('post', '/admin/design-prompts/{id}/activate', {
    summary: 'Make this version the one asked for its key (library.manage)',
    body: ProblemActivationBody,
    response: DesignPromptSummary,
  });
  lib('post', '/admin/design-prompts/{id}/deactivate', {
    summary: 'Stop asking this design prompt (library.manage)',
    body: ProblemActivationBody,
    response: DesignPromptSummary,
  });

  // ---- Consent, recordings and integrity (Phase 8) ------------------------------------------
  candidate('get', '/interviews/{id}/consents', {
    tag: 'Consent',
    summary:
      'The consents this interview asks for (by mode and template policy) and your decisions',
    response: SessionConsents,
    errors: [401, 404],
  });
  candidate('post', '/interviews/{id}/consents', {
    tag: 'Consent',
    summary:
      'Accept or decline the current consent texts (before starting; every decision is kept)',
    body: ConsentDecisionBody,
    response: SessionConsents,
    errors: [400, 401, 404, 409],
  });
  candidate('get', '/users/me/consents', {
    tag: 'Consent',
    summary: 'My consent history',
    response: z.array(UserConsentEntry),
  });
  route('post', '/interviews/{id}/media/segments/{idx}', {
    tag: 'Recordings',
    auth: 'bearer',
    summary:
      'Upload one MediaRecorder segment as the raw body (Content-Type video/webm or video/mp4, ≤ 8 MB), with the recorder part that produced it (each MediaRecorder instance is a new part). Idempotent by index: 200 duplicate, 201 stored; 503 means retry later',
    query: SegmentUploadQuery,
    response: SegmentUploadResult,
    status: 201,
    errors: [400, 401, 404, 409, 413, 415, 429, 503],
  });
  candidate('post', '/interviews/{id}/media/finalize', {
    tag: 'Recordings',
    summary:
      'Close the recording with the number of segments produced (COMPLETE, PARTIAL or FAILED)',
    body: FinalizeMediaBody,
    response: MediaAssetSummary.nullable(),
    errors: [400, 401, 404, 409],
  });
  candidate('get', '/interviews/{id}/media', {
    tag: 'Recordings',
    summary: 'My recording of this interview, or null',
    response: MediaAssetSummary.nullable(),
    errors: [401, 404],
  });
  candidate('get', '/interviews/{id}/media/playback-url', {
    tag: 'Recordings',
    summary:
      'Signed playback links for my recording (valid 30 minutes; ask again when they expire): the joined file, or its parts in order',
    response: PlaybackUrl,
    errors: [401, 404],
  });
  candidate('delete', '/interviews/{id}/media', {
    tag: 'Recordings',
    summary: 'Delete my recording now (the record of the deletion is kept)',
    response: MediaAssetSummary,
    errors: [401, 404, 503],
  });
  route('get', '/media/play/{assetId}', {
    tag: 'Recordings',
    summary:
      'Stream a recording from a signed link (exp, sig and, for one part, part query parameters; no Authorization header, for <video>). Single byte ranges: 206 with Content-Range, 416 past the end',
    response: null,
    status: 200,
    errors: [403, 404, 416, 503],
  });
  const media = (method: Method, path: string, spec: Omit<RouteSpec, 'tag' | 'auth'>) =>
    route(method, path, {
      tag: 'Admin recordings',
      auth: 'bearer',
      errors: [400, 401, 403, 404],
      ...spec,
    });
  media('get', '/admin/media', {
    summary:
      'Recordings with retention and deletion state; q matches session, user or email (media.read)',
    query: AdminMediaQuery,
    response: z.array(AdminMediaAsset),
  });
  media('get', '/admin/media/{id}', {
    summary: 'One recording (media.read)',
    response: AdminMediaAsset,
  });
  media('post', '/admin/media/{id}/playback', {
    summary: 'A signed playback link; every issue is audited (media.read)',
    response: PlaybackUrl,
  });
  media('post', '/admin/media/{id}/purge', {
    summary: 'Delete a recording now, audited (media.manage)',
    body: PurgeMediaBody,
    response: AdminMediaAsset,
    errors: [400, 401, 403, 404, 409, 503],
  });
  media('post', '/admin/media/{id}/rebuild-file', {
    summary:
      'Queue the joined, seekable file to be built again (after FAILED or UNAVAILABLE, or to replace it); audited (media.manage)',
    response: AdminMediaAsset,
    errors: [401, 403, 404, 409],
  });
  media('get', '/admin/interviews/{id}/integrity', {
    summary: 'Integrity observations of an interview, in order (media.read)',
    response: z.array(AdminIntegrityEvent),
  });
  media('get', '/admin/consent-texts', {
    summary: 'Consent text versions (consent.read)',
    response: z.array(ConsentTextSummary),
  });
  media('post', '/admin/consent-texts', {
    summary: 'Add the next version of a consent text, inactive (consent.manage)',
    body: CreateConsentTextBody,
    response: ConsentTextSummary,
    status: 201,
  });
  media('post', '/admin/consent-texts/{id}/activate', {
    summary:
      'Make a version current; candidates are asked again before their next start (consent.manage)',
    body: ActivateConsentTextBody,
    response: ConsentTextSummary,
  });

  // ---- Plans and payments (Phase 6) -------------------------------------------------
  route('get', '/plans', {
    tag: 'Payments',
    summary: 'Active plans for the pricing page (public)',
    response: z.array(PublicPlan),
    errors: [429],
  });
  candidate('post', '/payments/quote', {
    tag: 'Payments',
    summary:
      'Server-side price for a plan and optional coupon (explains a coupon that does not apply)',
    body: QuoteBody,
    response: Quote,
    errors: [400, 401, 404, 409, 429],
  });
  candidate('post', '/payments/orders', {
    tag: 'Payments',
    summary:
      'Create a purchase and its gateway order for Checkout; a zero total completes at once (provider null)',
    body: CreateOrderBody,
    response: CheckoutOrder,
    status: 201,
    errors: [400, 401, 404, 409, 429, 503],
  });
  candidate('post', '/payments/verify', {
    tag: 'Payments',
    summary:
      'Verify the Checkout result (signature, then captured amount) and issue credits; idempotent',
    body: VerifyPaymentBody,
    response: PurchaseSummary,
    errors: [400, 401, 404, 429],
  });
  route('post', '/payments/webhooks/razorpay', {
    tag: 'Payments',
    summary:
      'Razorpay webhook (raw JSON body signed in X-Razorpay-Signature; each X-Razorpay-Event-Id is processed once)',
    response: z.object({ result: z.string() }),
    errors: [400, 500],
  });
  candidate('post', '/payments/mock/checkout', {
    tag: 'Payments',
    summary: 'DEVELOPMENT ONLY (mock gateway): complete or fail mock Checkout for a purchase',
    body: MockCheckoutBody,
    response: MockCheckoutResult,
    errors: [400, 401, 404, 409],
  });
  candidate('get', '/payments/purchases', {
    tag: 'Payments',
    summary: 'My purchases, newest first',
    response: z.array(PurchaseSummary),
  });
  candidate('get', '/payments/purchases/{purchaseId}', {
    tag: 'Payments',
    summary: 'One of my purchases (poll after Checkout until PAID or FAILED)',
    response: PurchaseSummary,
    errors: [401, 404],
  });
  route('get', '/payments/purchases/{purchaseId}/receipt', {
    tag: 'Payments',
    auth: 'bearer',
    summary:
      'Download the receipt of a paid purchase (application/pdf; a GST tax invoice when a seller GSTIN is set, CGST + SGST or IGST by place of supply); 409 before payment',
    response: null,
    status: 200,
    errors: [401, 404, 409],
  });
  route('get', '/payments/purchases/{purchaseId}/credit-notes/{key}', {
    tag: 'Payments',
    auth: 'bearer',
    summary:
      'Download the credit note of a processed refund (application/pdf); key is from creditNotes',
    response: null,
    status: 200,
    errors: [401, 404],
  });
  candidate('get', '/payments/checkout-profile', {
    tag: 'Payments',
    summary: 'My buyer details for invoices (the state that sets the place of supply)',
    response: CheckoutProfile,
  });
  const pay = (method: Method, path: string, spec: Omit<RouteSpec, 'tag' | 'auth'>) =>
    route(method, path, {
      tag: 'Admin payments',
      auth: 'bearer',
      errors: [400, 401, 403, 404],
      ...spec,
    });
  pay('get', '/admin/plans', {
    summary: 'All plan versions (payments.read)',
    response: z.array(PlanSummary),
  });
  pay('post', '/admin/plans', {
    summary: 'Add the next version of a plan, inactive (payments.manage)',
    body: CreatePlanVersionBody,
    response: PlanSummary,
    status: 201,
  });
  pay('post', '/admin/plans/{id}/activate', {
    summary: 'Make this version the one on sale for its code (payments.manage)',
    body: PlanActivationBody,
    response: PlanSummary,
  });
  pay('post', '/admin/plans/{id}/deactivate', {
    summary: 'Take a plan version off sale (payments.manage)',
    body: PlanActivationBody,
    response: PlanSummary,
  });
  pay('get', '/admin/coupons', {
    summary: 'Coupons (payments.read)',
    response: z.array(CouponSummary),
  });
  pay('post', '/admin/coupons', {
    summary: 'Create a coupon (payments.manage)',
    body: UpsertCouponBody,
    response: CouponSummary,
    status: 201,
    errors: conflict,
  });
  pay('put', '/admin/coupons/{id}', {
    summary: 'Update a coupon; the code cannot change (payments.manage)',
    body: UpsertCouponBody,
    response: CouponSummary,
  });
  pay('get', '/admin/purchases', {
    summary:
      'Purchases with payment history; q matches ids, order/payment ids or email (payments.read)',
    query: AdminPurchaseQuery,
    response: z.array(AdminPurchase),
  });
  pay('get', '/admin/purchases/{id}', {
    summary: 'One purchase with its payment history (payments.read)',
    response: AdminPurchase,
  });
  pay('get', '/admin/purchases/{id}/receipt', {
    summary: 'Download the receipt of a paid purchase (application/pdf) (payments.read)',
    response: null,
    status: 200,
    errors: [401, 403, 404, 409],
  });
  pay('get', '/admin/purchases/{id}/credit-notes/{key}', {
    summary: 'Download the credit note of a processed refund (application/pdf) (payments.read)',
    response: null,
    status: 200,
    errors: [401, 403, 404],
  });
  pay('get', '/admin/purchases/{id}/refund-preview', {
    summary:
      'Refundable amount, credits used and unused, and a prorated suggestion (payments.read)',
    response: RefundPreview,
  });
  pay('post', '/admin/purchases/{id}/refund', {
    summary:
      'Refund all or part of a paid purchase; unused credits are withdrawn; used credits need acknowledgeUsedCredits (payments.manage)',
    body: RefundBody,
    response: AdminRefundResult,
    errors: [...conflict, 503],
  });
  pay('get', '/admin/credits/account', {
    summary:
      "A candidate's balance and latest ledger entries, by exact email or user id (payments.read)",
    query: AdminCreditLookupQuery,
    response: AdminCreditAccount,
  });
  pay('post', '/admin/credits/adjustments', {
    summary:
      'Grant or deduct credits by hand with a reason; audited (credits.adjust). 409 when a deduction exceeds usable credits',
    body: CreditAdjustmentBody,
    response: AdminCreditAccount,
    errors: conflict,
  });
  pay('post', '/admin/purchases/{id}/reconcile', {
    summary: 'Ask the gateway what happened to a purchase and apply it (payments.manage)',
    response: AdminReconcileResult,
    errors: [401, 403, 404, 503],
  });

  // ---- Campaigns and review (Phase 10) --------------------------------------------------------
  route('get', '/campaigns/{token}', {
    tag: 'Campaigns',
    summary:
      'An invite link landing page (public). With a candidate token it also says whether you already joined',
    response: PublicCampaign,
    errors: [404, 429],
  });
  candidate('post', '/campaigns/{token}/join', {
    tag: 'Campaigns',
    summary:
      'Join a campaign: 201 with a new interview, or 200 with the one you already have. 409 CAMPAIGN_CLOSED when not open',
    body: JoinCampaignBody,
    response: JoinCampaignResult,
    status: 201,
    errors: [400, 401, 404, 409],
  });
  const camp = (method: Method, path: string, spec: Omit<RouteSpec, 'tag' | 'auth'>) =>
    route(method, path, {
      tag: 'Admin campaigns',
      auth: 'bearer',
      errors: [400, 401, 403, 404],
      ...spec,
    });
  camp('get', '/admin/campaigns', {
    summary: 'Campaigns, newest first, a page at a time (campaigns.read)',
    query: CampaignListQuery,
    response: CampaignListPage,
  });
  camp('post', '/admin/campaigns', {
    summary:
      'Create a draft campaign, pinning the role blueprint and template versions. The invite path is shown only here (campaigns.manage)',
    body: CreateCampaignBody,
    response: CampaignWithInvite,
    status: 201,
  });
  camp('get', '/admin/campaigns/{id}', {
    summary: 'One campaign (campaigns.read)',
    response: CampaignSummary,
  });
  camp('put', '/admin/campaigns/{id}', {
    summary: 'Change name, dates, limit, budget and report visibility (campaigns.manage)',
    body: UpdateCampaignBody,
    response: CampaignSummary,
    errors: [400, 401, 403, 404, 409],
  });
  camp('post', '/admin/campaigns/{id}/status', {
    summary: 'Activate, pause or close (closed is final) (campaigns.manage)',
    body: CampaignStatusBody,
    response: CampaignSummary,
    errors: [400, 401, 403, 404, 409],
  });
  camp('post', '/admin/campaigns/{id}/rotate-invite', {
    summary: 'Replace the invite link; the old one stops working (campaigns.manage)',
    body: RotateInviteBody,
    response: CampaignWithInvite,
    errors: [400, 401, 403, 404, 409],
  });
  camp('get', '/admin/campaigns/{id}/results', {
    summary:
      'Results grid, one page: candidates, status, latest scores by dimension; filtered, sorted and paged by the server (campaigns.read)',
    query: CampaignResultsQuery,
    response: CampaignResults,
  });
  camp('get', '/admin/campaigns/{id}/results.csv', {
    summary:
      'Every matching result as CSV, streamed; same filters and order as the grid (campaigns.manage; audited)',
    query: CampaignResultsExportQuery,
    response: null,
    status: 200,
  });
  camp('post', '/admin/campaigns/{id}/exports', {
    summary:
      'Start a package export built by the worker: a ZIP with results.csv, the campaign settings and each report (JSON, and PDF when ready). Returns the running export if there is one (campaigns.manage; audited)',
    response: CampaignExport,
    status: 202,
  });
  camp('get', '/admin/campaigns/{id}/exports/{exportId}', {
    summary:
      'Export status and progress; `downloadPath` is set while the file can be downloaded (campaigns.manage)',
    response: CampaignExport,
  });
  camp('get', '/admin/campaigns/{id}/exports/{exportId}/download', {
    summary:
      'The package ZIP, streamed from storage; 409 when not ready or expired (campaigns.manage; audited)',
    response: null,
    status: 200,
    errors: [400, 401, 403, 404, 409],
  });
  const review = (method: Method, path: string, spec: Omit<RouteSpec, 'tag' | 'auth'>) =>
    route(method, path, {
      tag: 'Admin review',
      auth: 'bearer',
      errors: [400, 401, 403, 404],
      ...spec,
    });
  review('get', '/admin/interviews', {
    summary: 'Interviews by state, campaign, flag, id or email (interviews.read)',
    query: AdminInterviewQuery,
    response: z.array(AdminInterviewRow),
  });
  review('get', '/admin/interviews/{id}', {
    summary:
      'Transcript, evidence and every score and report revision (interviews.read; each view is audited)',
    response: AdminInterviewDetail,
  });
  review('post', '/admin/interviews/{id}/flag', {
    summary: 'Flag or unflag for review (interviews.review)',
    body: ReviewFlagBody,
    response: AdminInterviewRow,
  });
  review('post', '/admin/interviews/{id}/revise-score', {
    summary:
      'Revise dimension scores: a new score and report revision with the reviewer note; earlier revisions never change (interviews.review)',
    body: ReviseScoreBody,
    response: ScoreRevisionSummary,
    status: 201,
    errors: [400, 401, 403, 404, 409],
  });

  // ---- Analytics, operations and Candidate Proof (Phase 11) -------------------------------------
  route('post', '/analytics/events', {
    tag: 'Analytics',
    summary:
      'Send up to 25 allow-listed product events (no personal data; route patterns only). Signed-in callers are linked by their token',
    body: TrackEventsBody,
    response: TrackEventsResult,
    status: 202,
    errors: [400, 429],
  });
  route('get', '/flags', {
    tag: 'Operations',
    summary: 'Client-visible feature flags, evaluated for the caller (token optional)',
    response: ClientFlags,
    errors: [429],
  });
  route('get', '/system/status', {
    tag: 'Operations',
    summary: 'Public status: the maintenance banner',
    response: PublicSystemStatus,
    errors: [429],
  });
  candidate('get', '/reports/{sessionId}/shares', {
    tag: 'Candidate Proof',
    summary: 'My proof links for a report (flag reports.publicProof; 404 while off)',
    response: z.array(ShareLinkSummary),
    errors: [401, 404],
  });
  candidate('post', '/reports/{sessionId}/shares', {
    tag: 'Candidate Proof',
    summary:
      'Create a proof link (1–30 days, at most 5 active per report). The path is shown only here',
    body: CreateShareBody,
    response: CreatedShareLink,
    status: 201,
    errors: [400, 401, 404, 409],
  });
  candidate('delete', '/reports/shares/{id}', {
    tag: 'Candidate Proof',
    summary: 'Revoke a proof link',
    response: ShareLinkSummary,
    errors: [401, 404],
  });
  candidate('get', '/reports/{sessionId}/certificate', {
    tag: 'Candidate Proof',
    summary:
      'Readiness certificate status: whether the report reaches the `practice.certificateMinBand` band, and the certificate if issued (flag reports.publicProof; 404 while off)',
    response: CertificateStatus,
    errors: [401, 404],
  });
  candidate('post', '/reports/{sessionId}/certificate', {
    tag: 'Candidate Proof',
    summary:
      'Issue the interview’s readiness certificate (once; again returns it) and queue its PDF. 409 below the band',
    response: CertificateStatus,
    errors: [401, 404, 409],
  });
  route('get', '/reports/{sessionId}/certificate/pdf', {
    tag: 'Candidate Proof',
    auth: 'bearer',
    summary: 'Download the certificate (application/pdf); 409 while it is being prepared',
    response: null,
    status: 200,
    errors: [401, 404, 409],
  });
  route('get', '/certificates/{code}', {
    tag: 'Candidate Proof',
    summary:
      'Public certificate verification: the facts frozen at issue and whether a review replaced the report. Unknown codes answer 404',
    response: CertificateVerification,
    errors: [404, 429],
  });
  route('get', '/proof/{token}', {
    tag: 'Candidate Proof',
    summary:
      'Public proof page: scores only, never the transcript, evidence or contact details. Expired, revoked and unknown links answer 404',
    response: ProofView,
    errors: [404, 429],
  });
  const opsAdmin = (method: Method, path: string, spec: Omit<RouteSpec, 'tag' | 'auth'>) =>
    route(method, path, {
      tag: 'Admin analytics & operations',
      auth: 'bearer',
      errors: [400, 401, 403, 404],
      ...spec,
    });
  opsAdmin('get', '/admin/analytics/dashboard', {
    summary:
      'KPIs with targets, daily series, cohort funnel and provider health for a range of India-time days (analytics.read)',
    query: DateRangeQuery,
    response: Dashboard,
  });
  opsAdmin('get', '/admin/analytics/costs', {
    summary: 'AI cost by feature, provider, model or day, with revenue and margin (analytics.read)',
    query: CostQuery,
    response: CostReport,
  });
  opsAdmin('post', '/admin/analytics/rollup', {
    summary: 'Recompute the daily rollups of a range now (queues.manage; audited)',
    body: RollupBody,
    response: z.object({ days: z.number().int() }),
  });
  opsAdmin('get', '/admin/system/health', {
    summary: 'Dependencies, worker heartbeats, queue counts and stuck interviews (system.read)',
    response: SystemHealth,
  });
  opsAdmin('get', '/admin/system/queues', {
    summary: 'Job counts per queue (system.read)',
    response: z.array(QueueCounts),
  });
  opsAdmin('get', '/admin/system/queues/{name}/failed', {
    summary: 'Failed jobs of a queue (ids only; system.read)',
    query: FailedJobsQuery,
    response: z.array(FailedJob),
  });
  opsAdmin('post', '/admin/system/queues/{name}/jobs/{jobId}/retry', {
    summary: 'Retry one failed job (queues.manage; audited)',
    body: RetryJobBody,
    response: z.object({ retried: z.boolean() }),
  });
  opsAdmin('get', '/admin/flags', {
    summary: 'Feature flags (system.read)',
    response: z.array(FeatureFlag),
  });
  opsAdmin('put', '/admin/flags/{key}', {
    summary: 'Switch a flag and set its rollout (system.manage; audited)',
    body: UpdateFlagBody,
    response: FeatureFlag,
  });
  opsAdmin('get', '/admin/integrations', {
    summary:
      'Provider credentials for email, payments, storage, SMS and the judge: source (admin/env/none), readiness, settings and secret state (last 4 only) (system.read)',
    response: z.array(IntegrationSummary),
  });
  opsAdmin('get', '/admin/integrations/{kind}', {
    summary: 'One integration (system.read)',
    response: IntegrationSummary,
  });
  opsAdmin('put', '/admin/integrations/{kind}', {
    summary:
      'Configure an integration: provider, settings and write-only secrets (omitted keeps, null clears). Applied by every process at once (system.manage; audited without values)',
    body: UpdateIntegrationBody,
    response: IntegrationSummary,
  });
  opsAdmin('post', '/admin/integrations/{kind}/test', {
    summary: 'Test the connection (email sends to `to`) and record the result (system.manage)',
    body: TestIntegrationBody,
    response: IntegrationTestResult,
  });
  opsAdmin('post', '/admin/integrations/{kind}/reset', {
    summary: 'Remove the admin configuration; the environment file applies again (system.manage)',
    body: RetryJobBody,
    response: IntegrationSummary,
  });
  opsAdmin('get', '/admin/settings', {
    summary:
      'System settings: maintenance, finance (exchange rate, gateway fee), KPI targets (system.read)',
    response: z.array(SettingEntry),
  });
  opsAdmin('put', '/admin/settings/{key}', {
    summary:
      'Update one setting; the value is validated against its schema (system.manage; audited)',
    body: UpdateSettingBody,
    response: SettingEntry,
  });

  registerOrgPaths(route);

  const generator = new OpenApiGeneratorV31(registry.definitions);
  return generator.generateDocument({
    openapi: '3.1.0',
    info: {
      title: 'CareerPilot Interview API',
      version,
      description:
        'REST API for CareerPilot Interview by CodeBegun. Versioned endpoints live under /api/v1. ' +
        'Successful responses are `{ data }`; errors are `{ error: { code, message, details?, requestId } }`.',
    },
    servers: [{ url: 'https://api.interview.codebegun.com' }],
  });
}

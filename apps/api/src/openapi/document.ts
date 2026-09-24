import { OpenApiGeneratorV31, OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import {
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
  UpsertCouponBody,
  VerifyPaymentBody,
  CompareQuery,
  CompareResult,
  FeedbackBody,
  FeedbackSummary,
  ProcessingProgress,
  ReportHistoryItem,
  ReportSummary,
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
  CreateTemplateVersionBody,
  Extraction,
  InterviewListQuery,
  InterviewSummary,
  JobTargetSummary,
  LibraryReasonBody,
  LibrarySearchItem,
  LibrarySearchQuery,
  PromoteBlueprintBody,
  ResumeSummary,
  RoleSummary,
  TemplateSummary,
  UpdateInterviewSetupBody,
  UpdateJobTargetBody,
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
  RevokeAdminAccessBody,
  SessionResponse,
  UpdateAdminRolesBody,
  UpdateProfileBody,
} from '@cbi/shared-types';
import { z } from 'zod';

export type OpenApiDocument = ReturnType<OpenApiGeneratorV31['generateDocument']>;

type Method = 'get' | 'post' | 'put' | 'patch' | 'delete';

interface RouteSpec {
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
  }
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
  route('post', '/admin/users/{id}/revoke-access', {
    tag: 'Admin',
    summary: 'Remove all admin roles and end admin sessions (admin_users.manage)',
    auth: 'bearer',
    body: RevokeAdminAccessBody,
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
  candidate('get', '/jobs/{id}/status', {
    tag: 'Job targets',
    summary: 'Extraction status',
    response: Extraction,
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
      'Start the interview (READY or READY_TO_START → ACTIVE), reserving one credit. The first question arrives in the realtime room',
    response: InterviewSummary,
    errors: [401, 402, 404, 409],
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
    summary: 'Create a company; patterns are verified by the saving admin (library.manage)',
    body: UpsertCompanyBody,
    response: CompanySummary,
    status: 201,
    errors: conflict,
  });
  lib('put', '/admin/companies/{id}', {
    summary: 'Update a company (library.manage)',
    body: UpsertCompanyBody,
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
      'Upload one MediaRecorder segment as the raw body (Content-Type video/webm or video/mp4, ≤ 8 MB). Idempotent by index: 200 duplicate, 201 stored; 503 means retry later',
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
    summary: 'A signed playback link for my recording (valid 5 minutes)',
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
      'Stream a recording from a signed link (exp and sig query parameters; no Authorization header, for <video>)',
    response: null,
    status: 200,
    errors: [403, 404],
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
  pay('post', '/admin/purchases/{id}/refund', {
    summary: 'Refund a paid purchase in full; unused credits are withdrawn (payments.manage)',
    body: RefundBody,
    response: AdminRefundResult,
    errors: [...conflict, 503],
  });
  pay('post', '/admin/purchases/{id}/reconcile', {
    summary: 'Ask the gateway what happened to a purchase and apply it (payments.manage)',
    response: AdminReconcileResult,
    errors: [401, 403, 404, 503],
  });

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

import { OpenApiGeneratorV31, OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import {
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

/**
 * TEST SUPPORT ONLY (imported as '@cbi/web-core/testing'). A fetch stand-in
 * for component tests; never used by application code.
 */
import type { MeResponse, SessionResponse } from '@cbi/shared-types';
import { vi } from 'vitest';

type Reply = { status: number; body?: unknown };
type Handler = (body: unknown) => Reply | Promise<Reply>;

export const ok = (data: unknown): Reply => ({ status: 200, body: { data } });
export const fail = (status: number, code: string, details?: unknown): Reply => ({
  status,
  body: { error: { code, message: code, details, requestId: 'test' } },
});

export function makeUser(overrides: Partial<MeResponse> = {}): MeResponse {
  return {
    id: 'u1',
    email: 'asha@example.com',
    mobile: null,
    status: 'ACTIVE',
    adminRoles: [],
    onboardingCompleted: true,
    profile: {
      displayName: 'Asha',
      preferredInterviewLanguage: 'auto',
      experienceLevel: null,
      currentRole: null,
      productUpdatesOptIn: false,
    },
    identities: [
      { provider: 'EMAIL', display: 'a***a@example.com', verifiedAt: new Date().toISOString() },
    ],
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

export function makeSession(user: MeResponse = makeUser()): SessionResponse {
  return {
    accessToken: 'access-token',
    accessTokenExpiresAt: new Date(Date.now() + 600_000).toISOString(),
    user,
  };
}

/**
 * A fetch stand-in keyed by "METHOD /path" (path relative to /api/v1).
 * Defaults: signed out, email + mobile enabled, Google disabled.
 */
export function fakeApi(handlers: Record<string, Handler> = {}) {
  const all: Record<string, Handler> = {
    'POST /auth/refresh': () => fail(401, 'UNAUTHENTICATED'),
    'GET /auth/providers': () =>
      ok({ google: { enabled: false }, email: { enabled: true }, mobile: { enabled: true } }),
    ...handlers,
  };
  const calls: { key: string; body: unknown; headers: Record<string, string> }[] = [];
  const fetchImpl = vi.fn(async (url: string, init: RequestInit = {}) => {
    const path = new URL(url, 'http://test').pathname.replace(/^\/api\/v1/, '');
    const key = `${init.method ?? 'GET'} ${path}`;
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ key, body, headers: init.headers as Record<string, string> });
    const handler = all[key];
    const reply = handler ? await handler(body) : fail(404, 'NOT_FOUND');
    return new Response(reply.body === undefined ? null : JSON.stringify(reply.body), {
      status: reply.status,
      headers: { 'Content-Type': 'application/json' },
    });
  });
  return { fetchImpl: fetchImpl as unknown as typeof fetch, calls };
}

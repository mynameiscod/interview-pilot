import type { SessionAudience, SessionResponse } from '@cbi/shared-types';
import { ApiClientError, createApiClient, type ApiClient } from '../api-client';

export interface SessionManagerOptions {
  baseUrl: string;
  audience: SessionAudience;
  fetchImpl?: typeof fetch;
  /** Web Locks API; injected in tests. Defaults to navigator.locks when available. */
  locks?: Pick<LockManager, 'request'> | null;
}

type Listener = (session: SessionResponse | null) => void;

/**
 * Owns the access token (memory only — never localStorage) and the refresh
 * flow. Refreshes are single-flight within a tab and serialized across tabs
 * with the Web Locks API, because every refresh rotates the httpOnly cookie
 * and parallel rotations would look like token theft to the server.
 */
export function createSessionManager(opts: SessionManagerOptions) {
  const authBase = opts.audience === 'admin' ? '/admin/auth' : '/auth';
  const locks =
    opts.locks !== undefined
      ? opts.locks
      : typeof navigator !== 'undefined' && 'locks' in navigator
        ? navigator.locks
        : null;

  let session: SessionResponse | null = null;
  let inflight: Promise<SessionResponse | null> | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const listeners = new Set<Listener>();

  const bare = createApiClient({ baseUrl: opts.baseUrl, fetchImpl: opts.fetchImpl });

  function set(next: SessionResponse | null) {
    session = next;
    clearTimeout(timer);
    if (next) {
      // Refresh a minute before expiry so requests rarely hit a 401.
      const delay = new Date(next.accessTokenExpiresAt).getTime() - Date.now() - 60_000;
      timer = setTimeout(() => void refresh(), Math.max(delay, 5_000));
    }
    for (const listener of listeners) listener(next);
  }

  async function doRefresh(): Promise<SessionResponse | null> {
    try {
      const next = await bare.post<SessionResponse>(`${authBase}/refresh`, undefined, {
        csrf: true,
        noRefresh: true,
      });
      set(next);
      return next;
    } catch (err) {
      if (err instanceof ApiClientError && err.code === 'NETWORK_ERROR') throw err;
      set(null);
      return null;
    }
  }

  function refresh(): Promise<SessionResponse | null> {
    if (!inflight) {
      const run = locks
        ? () =>
            locks.request(
              `cbi-refresh-${opts.audience}`,
              doRefresh,
            ) as Promise<SessionResponse | null>
        : doRefresh;
      inflight = run().finally(() => {
        inflight = null;
      });
    }
    return inflight;
  }

  const api: ApiClient = createApiClient({
    baseUrl: opts.baseUrl,
    fetchImpl: opts.fetchImpl,
    getAccessToken: () => session?.accessToken ?? null,
    refreshAccessToken: async () => (await refresh())?.accessToken ?? null,
  });

  return {
    api,
    authBase,
    get current() {
      return session;
    },
    /** Called after a successful sign-in response. */
    start: (next: SessionResponse) => set(next),
    refresh,
    subscribe(listener: Listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async signOut() {
      try {
        await bare.post(`${authBase}/logout`, undefined, { csrf: true, noRefresh: true });
      } finally {
        set(null);
      }
    },
    async signOutEverywhere() {
      try {
        await api.post(`${authBase}/logout-all`, undefined, { csrf: true });
      } finally {
        set(null);
      }
    },
  };
}

export type SessionManager = ReturnType<typeof createSessionManager>;

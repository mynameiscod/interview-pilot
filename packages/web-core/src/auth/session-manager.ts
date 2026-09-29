import type { SessionAudience, SessionResponse } from '@cbi/shared-types';
import { ApiClientError, createApiClient, type ApiClient } from '../api-client';

export interface SessionManagerOptions {
  baseUrl: string;
  audience: SessionAudience;
  fetchImpl?: typeof fetch;
  /** Web Locks API; injected in tests. Defaults to navigator.locks when available. */
  locks?: Pick<LockManager, 'request'> | null;
  /**
   * Cross-tab channel (BroadcastChannel); injected in tests. Defaults to a
   * channel per audience when the browser supports it.
   */
  channel?: SessionChannel | null;
}

/** The parts of BroadcastChannel the manager uses. */
export type SessionChannel = Pick<BroadcastChannel, 'postMessage' | 'close'> & {
  onmessage: ((event: MessageEvent) => void) | null;
};

/** Why the session changed: `remote-sign-out` = the person signed out in another tab. */
export type SessionChangeReason = 'local' | 'remote-sign-out';

type Listener = (session: SessionResponse | null, reason: SessionChangeReason) => void;

type TabMessage = { type: 'signed-out' } | { type: 'signed-in' };

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
  const channel =
    opts.channel !== undefined
      ? opts.channel
      : typeof BroadcastChannel !== 'undefined'
        ? new BroadcastChannel(`cbi-session-${opts.audience}`)
        : null;
  // Node (tests, SSR tooling) keeps the process alive for an open channel.
  (channel as { unref?: () => void } | null)?.unref?.();
  const broadcast = (message: TabMessage) => {
    try {
      channel?.postMessage(message);
    } catch {
      // A closed channel only means other tabs find out on their next refresh.
    }
  };

  const bare = createApiClient({ baseUrl: opts.baseUrl, fetchImpl: opts.fetchImpl });

  function set(next: SessionResponse | null, reason: SessionChangeReason = 'local') {
    session = next;
    clearTimeout(timer);
    if (next) {
      // Refresh a minute before expiry so requests rarely hit a 401.
      const delay = new Date(next.accessTokenExpiresAt).getTime() - Date.now() - 60_000;
      timer = setTimeout(() => void refresh(), Math.max(delay, 5_000));
    }
    for (const listener of listeners) listener(next, reason);
  }

  // Signing out in one tab signs out every tab of the same app (the refresh
  // cookie is shared, so the others could otherwise keep a stale access token
  // for up to its lifetime). Signing in elsewhere lets a signed-out tab pick
  // up the new session.
  if (channel) {
    channel.onmessage = (event: MessageEvent) => {
      const message = event.data as TabMessage | undefined;
      if (message?.type === 'signed-out' && session) set(null, 'remote-sign-out');
      if (message?.type === 'signed-in' && !session) void refresh().catch(() => undefined);
    };
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
    start: (next: SessionResponse) => {
      set(next);
      broadcast({ type: 'signed-in' });
    },
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
        broadcast({ type: 'signed-out' });
      }
    },
    async signOutEverywhere() {
      try {
        await api.post(`${authBase}/logout-all`, undefined, { csrf: true });
      } finally {
        set(null);
        broadcast({ type: 'signed-out' });
      }
    },
    /** Ends the session locally after the server already did (e.g. account deletion). */
    endLocally() {
      set(null);
      broadcast({ type: 'signed-out' });
    },
  };
}

export type SessionManager = ReturnType<typeof createSessionManager>;

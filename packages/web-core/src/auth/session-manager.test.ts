import type { SessionResponse } from '@cbi/shared-types';
import { describe, expect, it, vi } from 'vitest';
import { createSessionManager, type SessionChannel } from './session-manager';

const session = (token: string): SessionResponse => ({
  accessToken: token,
  accessTokenExpiresAt: new Date(Date.now() + 600_000).toISOString(),
  user: {
    id: 'u1',
    email: 'a@example.com',
    mobile: null,
    status: 'ACTIVE',
    adminRoles: [],
    onboardingCompleted: true,
    profile: {
      displayName: 'A',
      preferredInterviewLanguage: 'auto',
      experienceLevel: null,
      currentRole: null,
      productUpdatesOptIn: false,
    },
    identities: [],
    createdAt: new Date().toISOString(),
  },
});

const ok = (body: unknown) =>
  new Response(JSON.stringify({ data: body }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });

describe('session manager', () => {
  it('runs concurrent refreshes as a single request', async () => {
    let resolve!: (r: Response) => void;
    const fetchImpl = vi.fn().mockReturnValue(new Promise<Response>((r) => (resolve = r)));
    const manager = createSessionManager({
      baseUrl: '',
      audience: 'candidate',
      fetchImpl,
      locks: null,
    });
    const a = manager.refresh();
    const b = manager.refresh();
    resolve(ok(session('t1')));
    await expect(Promise.all([a, b])).resolves.toHaveLength(2);
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(fetchImpl.mock.calls[0]![0]).toBe('/api/v1/auth/refresh');
    expect(manager.current?.accessToken).toBe('t1');
  });

  it('serializes refreshes across tabs with a named Web Lock', async () => {
    const request = vi.fn((_name: string, cb: () => Promise<unknown>) => cb());
    const fetchImpl = vi.fn().mockResolvedValue(ok(session('t2')));
    const manager = createSessionManager({
      baseUrl: '',
      audience: 'admin',
      fetchImpl,
      locks: { request } as never,
    });
    await manager.refresh();
    expect(request).toHaveBeenCalledWith('cbi-refresh-admin', expect.any(Function));
    expect(fetchImpl.mock.calls[0]![0]).toBe('/api/v1/admin/auth/refresh');
  });

  it('clears the session and notifies listeners when refresh is rejected', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: { code: 'UNAUTHENTICATED', message: 'x' } }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    const manager = createSessionManager({
      baseUrl: '',
      audience: 'candidate',
      fetchImpl,
      locks: null,
    });
    manager.start(session('old'));
    const listener = vi.fn();
    manager.subscribe(listener);
    await expect(manager.refresh()).resolves.toBeNull();
    expect(manager.current).toBeNull();
    expect(listener).toHaveBeenCalledWith(null, 'local');
  });

  it('keeps the session through a network error instead of signing out', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new TypeError('offline'));
    const manager = createSessionManager({
      baseUrl: '',
      audience: 'candidate',
      fetchImpl,
      locks: null,
    });
    manager.start(session('kept'));
    await expect(manager.refresh()).rejects.toMatchObject({ code: 'NETWORK_ERROR' });
    expect(manager.current?.accessToken).toBe('kept');
  });

  it('signs every tab out when one tab signs out', async () => {
    // Two tabs joined by an in-memory stand-in for BroadcastChannel.
    const tabs: SessionChannel[] = [];
    const channel = (): SessionChannel => {
      const self: SessionChannel = {
        onmessage: null,
        close: () => undefined,
        postMessage: (data: unknown) => {
          for (const other of tabs) {
            if (other !== self) other.onmessage?.({ data } as MessageEvent);
          }
        },
      };
      tabs.push(self);
      return self;
    };
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    const a = createSessionManager({
      baseUrl: '',
      audience: 'candidate',
      fetchImpl,
      locks: null,
      channel: channel(),
    });
    const b = createSessionManager({
      baseUrl: '',
      audience: 'candidate',
      fetchImpl,
      locks: null,
      channel: channel(),
    });
    // Both tabs are already signed in, so neither start() makes the other refresh.
    b.start(session('b'));
    a.start(session('a'));
    const listener = vi.fn();
    b.subscribe(listener);
    await a.signOut();
    expect(a.current).toBeNull();
    expect(b.current).toBeNull();
    expect(listener).toHaveBeenCalledWith(null, 'remote-sign-out');
  });

  it('lets a signed-out tab pick up a sign-in from another tab', async () => {
    let deliver: ((data: unknown) => void) | null = null;
    const sender: SessionChannel = {
      onmessage: null,
      close: () => undefined,
      postMessage: (data: unknown) => deliver?.(data),
    };
    const receiver: SessionChannel = {
      onmessage: null,
      close: () => undefined,
      postMessage: () => undefined,
    };
    deliver = (data) => receiver.onmessage?.({ data } as MessageEvent);
    const fetchImpl = vi.fn().mockResolvedValue(ok(session('shared')));
    const a = createSessionManager({
      baseUrl: '',
      audience: 'admin',
      locks: null,
      channel: sender,
    });
    const b = createSessionManager({
      baseUrl: '',
      audience: 'admin',
      fetchImpl,
      locks: null,
      channel: receiver,
    });
    a.start(session('new'));
    await vi.waitFor(() => expect(b.current?.accessToken).toBe('shared'));
    expect(fetchImpl.mock.calls[0]![0]).toBe('/api/v1/admin/auth/refresh');
  });

  it('signs out locally even if the server call fails', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new TypeError('offline'));
    const manager = createSessionManager({
      baseUrl: '',
      audience: 'candidate',
      fetchImpl,
      locks: null,
    });
    manager.start(session('t'));
    await manager.signOut().catch(() => undefined);
    expect(manager.current).toBeNull();
  });
});

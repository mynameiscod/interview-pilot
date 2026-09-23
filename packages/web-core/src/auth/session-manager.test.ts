import type { SessionResponse } from '@cbi/shared-types';
import { describe, expect, it, vi } from 'vitest';
import { createSessionManager } from './session-manager';

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
    expect(listener).toHaveBeenCalledWith(null);
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

import { createAccessTokenIssuer } from '@cbi/auth-core';
import type { Redis } from '@cbi/db';
import type { Request } from 'express';
import { describe, expect, it, vi } from 'vitest';
import { authenticate } from '../../middleware/authenticate.js';
import { createRevokedSessions } from './revoked-sessions.js';

/** An in-memory stand-in for the few Redis commands used (TTL recorded, not enforced). */
function fakeRedis(opts: { down?: boolean } = {}) {
  const keys = new Map<string, number>();
  const redis = {
    multi() {
      const ops: [string, number][] = [];
      const tx = {
        set(key: string, _v: string, _ex: 'EX', ttl: number) {
          ops.push([key, ttl]);
          return tx;
        },
        async exec() {
          if (opts.down) throw new Error('Connection is closed.');
          for (const [k, ttl] of ops) keys.set(k, ttl);
          return [];
        },
      };
      return tx;
    },
    async exists(key: string) {
      if (opts.down) throw new Error('Connection is closed.');
      return keys.has(key) ? 1 : 0;
    },
  };
  return { redis: redis as unknown as Redis, keys };
}

describe('revoked sessions', () => {
  it('remembers revoked session ids for the access-token lifetime plus skew', async () => {
    const { redis, keys } = fakeRedis();
    const revoked = createRevokedSessions(redis, 600);
    await revoked.revoke(['fam-1', 'fam-1', 'fam-2']);
    expect([...keys]).toEqual([
      ['cbi:revoked-session:fam-1', 660],
      ['cbi:revoked-session:fam-2', 660],
    ]);
    expect(await revoked.isRevoked('fam-1')).toBe(true);
    expect(await revoked.isRevoked('fam-3')).toBe(false);
    await revoked.revoke([]);
    expect(keys.size).toBe(2);
  });

  it('lets requests through (logged) when Redis is unavailable', async () => {
    const warn = vi.fn();
    const revoked = createRevokedSessions(fakeRedis({ down: true }).redis, 600, {
      warn,
    } as never);
    await expect(revoked.revoke(['fam-1'])).resolves.toBeUndefined();
    expect(await revoked.isRevoked('fam-1')).toBe(false);
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('makes authenticate refuse a revoked session’s still-valid access token', async () => {
    const tokens = createAccessTokenIssuer({ secret: 'x'.repeat(48), ttlSec: 600 });
    const { token } = await tokens.sign({
      userId: '64b000000000000000000001',
      audience: 'candidate',
      sessionId: 'fam-1',
      tokenVersion: 0,
      adminRoles: [],
    });
    const revoked = createRevokedSessions(fakeRedis().redis, 600);
    const userState = {
      get: async () => ({ status: 'ACTIVE' as const, tokenVersion: 0, adminRoles: [] }),
      invalidate: async () => undefined,
    };
    const handler = authenticate('candidate', { tokens, userState, revokedSessions: revoked });
    const run = async () => {
      const req = { headers: { authorization: `Bearer ${token}` } } as unknown as Request;
      const next = vi.fn();
      await handler(req, {} as never, next);
      return { req, next };
    };
    const ok = await run();
    expect(ok.next).toHaveBeenCalled();
    expect(ok.req.auth?.sessionId).toBe('fam-1');

    await revoked.revoke(['fam-1']);
    await expect(run()).rejects.toMatchObject({ status: 401 });
  });
});

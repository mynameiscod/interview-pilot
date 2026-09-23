import { randomUUID } from 'node:crypto';
import type { Redis } from 'ioredis';
import type { BreakerSnapshot } from './breaker.js';

/**
 * Cross-replica coordination for the router: a per-model concurrency
 * semaphore, circuit-breaker state and a probe lock. Breaker updates are
 * read-modify-write and therefore best-effort under concurrency; that is
 * acceptable because the breaker only needs to be approximately right.
 */
export interface CoordinationStore {
  /** Returns a lease token, or null when `limit` leases are already held. */
  acquireSlot(key: string, limit: number, leaseMs: number): Promise<string | null>;
  releaseSlot(key: string, token: string): Promise<void>;
  readBreaker(key: string): Promise<BreakerSnapshot | null>;
  writeBreaker(key: string, snapshot: BreakerSnapshot, ttlMs: number): Promise<void>;
  /** Set-if-absent lock with expiry; true when acquired. */
  tryLock(key: string, ttlMs: number): Promise<boolean>;
}

export const AI_COORDINATION_PREFIX = 'cbi:ai:' as const;

// Leases are sorted-set members scored by expiry, so a crashed holder's slot
// frees itself when its lease runs out.
const ACQUIRE_SCRIPT = `
local key, now, expiry, limit, token, ttl = KEYS[1], tonumber(ARGV[1]), tonumber(ARGV[2]), tonumber(ARGV[3]), ARGV[4], tonumber(ARGV[5])
redis.call('ZREMRANGEBYSCORE', key, '-inf', now)
if redis.call('ZCARD', key) < limit then
  redis.call('ZADD', key, expiry, token)
  redis.call('PEXPIRE', key, ttl)
  return 1
end
return 0`;

export function createRedisCoordination(
  redis: Redis,
  now: () => number = Date.now,
): CoordinationStore {
  const slotKey = (key: string) => `${AI_COORDINATION_PREFIX}slots:${key}`;
  const breakerKey = (key: string) => `${AI_COORDINATION_PREFIX}breaker:${key}`;
  return {
    async acquireSlot(key, limit, leaseMs) {
      const token = randomUUID();
      const t = now();
      const acquired = await redis.eval(
        ACQUIRE_SCRIPT,
        1,
        slotKey(key),
        String(t),
        String(t + leaseMs),
        String(limit),
        token,
        String(leaseMs * 2),
      );
      return acquired === 1 ? token : null;
    },
    async releaseSlot(key, token) {
      await redis.zrem(slotKey(key), token);
    },
    async readBreaker(key) {
      const raw = await redis.get(breakerKey(key));
      return raw ? (JSON.parse(raw) as BreakerSnapshot) : null;
    },
    async writeBreaker(key, snapshot, ttlMs) {
      await redis.set(breakerKey(key), JSON.stringify(snapshot), 'PX', ttlMs);
    },
    async tryLock(key, ttlMs) {
      const result = await redis.set(
        `${AI_COORDINATION_PREFIX}lock:${key}`,
        '1',
        'PX',
        ttlMs,
        'NX',
      );
      return result === 'OK';
    },
  };
}

/** Single-process implementation for unit tests and tools. */
export function createMemoryCoordination(now: () => number = Date.now): CoordinationStore {
  const slots = new Map<string, Map<string, number>>();
  const breakers = new Map<string, { value: BreakerSnapshot; expiresAt: number }>();
  const locks = new Map<string, number>();
  return {
    async acquireSlot(key, limit, leaseMs) {
      const leases = slots.get(key) ?? new Map<string, number>();
      slots.set(key, leases);
      for (const [token, expiry] of leases) if (expiry <= now()) leases.delete(token);
      if (leases.size >= limit) return null;
      const token = randomUUID();
      leases.set(token, now() + leaseMs);
      return token;
    },
    async releaseSlot(key, token) {
      slots.get(key)?.delete(token);
    },
    async readBreaker(key) {
      const entry = breakers.get(key);
      return entry && entry.expiresAt > now() ? entry.value : null;
    },
    async writeBreaker(key, value, ttlMs) {
      breakers.set(key, { value, expiresAt: now() + ttlMs });
    },
    async tryLock(key, ttlMs) {
      const expiry = locks.get(key);
      if (expiry !== undefined && expiry > now()) return false;
      locks.set(key, now() + ttlMs);
      return true;
    },
  };
}

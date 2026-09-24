import { randomUUID } from 'node:crypto';
import type { Redis } from '@cbi/db';

/** Deletes the key only if it still holds our token (never another holder's lock). */
const RELEASE = `if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end`;

export const LOCK_BUSY = Symbol('lock-busy');

/**
 * Runs `fn` while holding a Redis lock shared by every API replica. Waits up
 * to `waitMs` for the lock, then gives up with LOCK_BUSY. The TTL bounds how
 * long a crashed holder can block others.
 */
export async function withLock<T>(
  redis: Redis,
  key: string,
  fn: () => Promise<T>,
  opts: { ttlMs?: number; waitMs?: number } = {},
): Promise<T | typeof LOCK_BUSY> {
  const ttlMs = opts.ttlMs ?? 90_000;
  const deadline = Date.now() + (opts.waitMs ?? 0);
  const token = randomUUID();
  for (;;) {
    const acquired = await redis.set(key, token, 'PX', ttlMs, 'NX');
    if (acquired === 'OK') break;
    if (Date.now() >= deadline) return LOCK_BUSY;
    await new Promise((r) => setTimeout(r, 100));
  }
  try {
    return await fn();
  } finally {
    await redis.eval(RELEASE, 1, key, token).catch(() => undefined);
  }
}

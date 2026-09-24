import { createRequire } from 'node:module';
import { join } from 'node:path';
import { MONGODB_URI, REDIS_URL, REPO_ROOT } from './env';

/**
 * Direct MongoDB and Redis access for test setup (creating admins, clearing
 * rate-limit counters). The drivers are borrowed from @cbi/db so the suite
 * does not pin its own copies; only the minimal surface used here is typed.
 */
interface Collection {
  insertOne(doc: Record<string, unknown>): Promise<unknown>;
  findOne(filter: Record<string, unknown>): Promise<Record<string, unknown> | null>;
}
interface Db {
  collection(name: string): Collection;
  dropDatabase(): Promise<unknown>;
  databaseName: string;
}
interface MongoClientLike {
  db(): Db;
  close(): Promise<void>;
}
interface RedisLike {
  scan(cursor: string, ...args: (string | number)[]): Promise<[string, string[]]>;
  del(...keys: string[]): Promise<number>;
  flushdb(): Promise<unknown>;
  quit(): Promise<unknown>;
}

const dbRequire = createRequire(join(REPO_ROOT, 'packages/db/package.json'));
const { MongoClient } = (
  dbRequire('mongoose') as {
    mongo: { MongoClient: { connect(uri: string): Promise<MongoClientLike> } };
  }
).mongo;
const Redis = (dbRequire('ioredis') as { default: new (url: string) => RedisLike }).default;

/** Refuses to touch a database or Redis index that is not clearly the e2e one. */
export function assertE2eTargets() {
  const dbName = new URL(MONGODB_URI).pathname.slice(1);
  if (!/e2e/i.test(dbName)) {
    throw new Error(`E2E_MONGODB_URI must name a database containing "e2e" (got "${dbName}")`);
  }
  const index = Number(new URL(REDIS_URL).pathname.slice(1) || 0);
  if (index === 0) {
    throw new Error('E2E_REDIS_URL must select a dedicated, non-zero Redis DB index (e.g. /13)');
  }
}

export async function withDb<T>(fn: (db: Db) => Promise<T>): Promise<T> {
  const client = await MongoClient.connect(MONGODB_URI);
  try {
    return await fn(client.db());
  } finally {
    await client.close();
  }
}

export async function withRedis<T>(fn: (redis: RedisLike) => Promise<T>): Promise<T> {
  const redis = new Redis(REDIS_URL);
  try {
    return await fn(redis);
  } finally {
    await redis.quit();
  }
}

/** Fresh state for a run: drop the e2e database and flush the e2e Redis DB index. */
export async function resetStores() {
  assertE2eTargets();
  await withDb((db) => db.dropDatabase());
  await withRedis((redis) => redis.flushdb());
}

/**
 * The API rate-limits OTP requests per IP (10 per 15 minutes); every browser
 * in the suite shares one IP, so the counters are cleared before each test.
 */
export async function clearRateLimits() {
  await withRedis(async (redis) => {
    let cursor = '0';
    do {
      const [next, keys] = await redis.scan(cursor, 'MATCH', 'cbi:rl:*', 'COUNT', 500);
      if (keys.length > 0) await redis.del(...keys);
      cursor = next;
    } while (cursor !== '0');
  });
}

export type AdminRole =
  'SUPER_ADMIN' | 'OPERATIONS_ADMIN' | 'CONTENT_ADMIN' | 'SUPPORT_ADMIN' | 'FINANCE_ADMIN';

/** Admins are granted by a super admin; tests insert the user directly. */
export async function createAdmin(email: string, roles: AdminRole[]) {
  await withDb((db) =>
    db.collection('users').insertOne({
      primaryEmail: email,
      adminRoles: roles,
      status: 'ACTIVE',
      tokenVersion: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    }),
  );
}

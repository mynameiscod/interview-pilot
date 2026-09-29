import { createLogger } from '@cbi/config';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensureAuditLogRetention, ensureIndexes } from './indexes.js';
import { AuditLogModel } from './models/audit-log.js';
import { connectMongo, disconnectMongo } from './mongo.js';

const MONGODB_URI = process.env.MONGODB_URI;
if (
  !MONGODB_URI ||
  !/test/i.test(new URL(MONGODB_URI.replace(/^mongodb(\+srv)?:/, 'http:')).pathname)
) {
  throw new Error(
    'Integration tests need MONGODB_URI pointing at a database whose name contains "test".',
  );
}

const DAY = 24 * 3600;

beforeAll(async () => {
  await connectMongo({
    uri: MONGODB_URI,
    autoIndex: false,
    logger: createLogger({ service: 'test', level: 'silent' }),
  });
});
afterAll(async () => {
  // Leave the default for the suites that follow.
  await ensureAuditLogRetention(730);
  await disconnectMongo();
});

async function ttl() {
  const indexes = await AuditLogModel.collection.listIndexes().toArray();
  const at = indexes.filter((i) => JSON.stringify(i.key) === JSON.stringify({ at: -1 }));
  expect(at).toHaveLength(1);
  return at[0]!.expireAfterSeconds as number | undefined;
}

describe('audit log retention', () => {
  it('creates the TTL index with the configured retention and updates it in place', async () => {
    await ensureIndexes();
    expect(await ttl()).toBe(730 * DAY);

    await ensureIndexes({ auditLogRetentionDays: 365 });
    expect(await ttl()).toBe(365 * DAY);

    expect(await ensureAuditLogRetention(365)).toEqual({ op: 'none' });
    expect(await ensureAuditLogRetention(30)).toMatchObject({ op: 'collMod', from: 365 * DAY });
    expect(await ttl()).toBe(30 * DAY);
  });

  it('turns an existing plain time index (older deployments) into the TTL index', async () => {
    await ensureIndexes();
    const name = (await AuditLogModel.collection.listIndexes().toArray()).find(
      (i) => JSON.stringify(i.key) === JSON.stringify({ at: -1 }),
    )!.name as string;
    await AuditLogModel.collection.dropIndex(name);
    await AuditLogModel.collection.createIndex({ at: -1 });
    expect(await ttl()).toBeUndefined();

    expect(await ensureAuditLogRetention(730)).toMatchObject({ op: 'collMod', from: null });
    expect(await ttl()).toBe(730 * DAY);
  });
});

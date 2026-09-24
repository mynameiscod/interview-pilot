import { buildAiRuntime } from '@cbi/ai-runtime';
import { createLogger } from '@cbi/config';
import {
  connectMongo,
  createRedis,
  disconnectMongo,
  ensureAiCatalog,
  ensureIndexes,
  ensureLibraryCatalog,
  mongoose,
} from '@cbi/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EVAL_FIXTURES } from './fixtures.js';
import { runEvalSuite } from './runner.js';

const MONGODB_URI = process.env.MONGODB_URI;
const REDIS_URL = process.env.REDIS_URL;
if (
  !MONGODB_URI ||
  !REDIS_URL ||
  !/test/i.test(new URL(MONGODB_URI.replace(/^mongodb(\+srv)?:/, 'http:')).pathname)
) {
  throw new Error(
    'Integration tests need REDIS_URL and a MONGODB_URI whose database name contains "test".',
  );
}

const logger = createLogger({ service: 'test', level: 'silent' });
const redisUrl = new URL(REDIS_URL);
redisUrl.pathname = '/15';
const redis = createRedis(redisUrl.toString(), logger);

beforeAll(async () => {
  await connectMongo({ uri: MONGODB_URI, autoIndex: false, logger });
  await ensureIndexes();
  await redis.connect();
  const db = mongoose.connection.db!;
  for (const { name } of await db.listCollections().toArray())
    await db.collection(name).deleteMany({});
  await ensureAiCatalog({ mockMode: true });
  await ensureLibraryCatalog();
});
afterAll(async () => {
  await disconnectMongo();
  await redis.quit();
});

describe('AI regression runner (structure mode, mock model)', () => {
  it('runs every fixture through the real prompts and scoring end to end', async () => {
    const ai = buildAiRuntime({
      env: {
        APP_ENV: 'test',
        AI_MOCK_MODE: true,
        AI_SECRETS_MASTER_KEY: Buffer.alloc(32, 7).toString('base64'),
        AI_SECRETS_KEY_ID: 'k1',
        AI_CONFIG_CACHE_TTL_SEC: 1,
      },
      logger,
      redis,
    });
    const report = await runEvalSuite({ ai, logger }, EVAL_FIXTURES, { mode: 'structure' });
    expect(report.summary.fixtures).toBe(EVAL_FIXTURES.length);
    // The mock names questions that do not exist, so extraction yields no items: structure still holds.
    for (const f of report.fixtures) {
      expect(f.checks.find((c) => c.name === 'scores in range')!.passed, f.id).toBe(true);
    }
    expect(report.passed).toBe(true);
  });
});

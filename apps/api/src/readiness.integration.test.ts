import { createLogger } from '@cbi/config';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from './app.js';
import {
  connectMongo,
  createRedis,
  disconnectMongo,
  mongoose,
  pingMongo,
  pingRedis,
} from '@cbi/db';

/**
 * Requires real MongoDB (replica set) and Redis. Locally: `pnpm infra:up`.
 * In CI these run as service containers. The suite fails loudly rather than
 * skipping when they are not configured.
 */
const MONGODB_URI = process.env.MONGODB_URI;
const REDIS_URL = process.env.REDIS_URL;
if (!MONGODB_URI || !REDIS_URL) {
  throw new Error(
    'Integration tests need MONGODB_URI and REDIS_URL. Start them with `pnpm infra:up` and see .env.example.',
  );
}

const logger = createLogger({ service: 'api-integration', level: 'silent' });
const redis = createRedis(REDIS_URL, logger);

beforeAll(async () => {
  await connectMongo({ uri: MONGODB_URI, autoIndex: true, logger });
  await redis.connect();
});

afterAll(async () => {
  await disconnectMongo();
  await redis.quit();
});

describe('infrastructure connectivity', () => {
  it('pings MongoDB and Redis', async () => {
    await expect(pingMongo()).resolves.toBeUndefined();
    await expect(pingRedis(redis)).resolves.toBeUndefined();
  });

  it('MongoDB supports multi-document transactions (replica set)', async () => {
    const session = await mongoose.startSession();
    const coll = mongoose.connection.collection('phase0_txn_probe');
    try {
      await session.withTransaction(async () => {
        await coll.insertOne({ probe: true, at: new Date() }, { session });
      });
    } finally {
      await session.endSession();
      await coll.drop().catch(() => undefined);
    }
  });

  it('/readyz reports ready against real dependencies', async () => {
    const app = createApp({
      env: {
        APP_ENV: 'test',
        APP_VERSION: 'integration',
        CORS_ALLOWED_ORIGINS: ['http://localhost:5173'],
        TRUST_PROXY_HOPS: 0,
        REQUEST_BODY_LIMIT: '1mb',
        API_DOCS_ENABLED: false,
      },
      logger,
      probes: { mongo: pingMongo, redis: () => pingRedis(redis) },
      isDraining: () => false,
    });
    const res = await request(app).get('/readyz').expect(200);
    expect(res.body.checks.mongo.status).toBe('up');
    expect(res.body.checks.redis.status).toBe('up');
  });
});

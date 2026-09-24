/**
 * TEST SUPPORT ONLY. Real MongoDB + Redis for integration suites. Uses Redis
 * logical DB 15 so tests never touch local development data.
 */
import { createLogger } from '@cbi/config';
import {
  connectMongo,
  createRedis,
  disconnectMongo,
  ensureConsentTexts,
  ensureIndexes,
  mongoose,
  type Redis,
} from '@cbi/db';
import { CSRF_HEADER, OTP_LENGTH, type SessionAudience } from '@cbi/shared-types';
import type { Express } from 'express';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach } from 'vitest';
import { TEST_ORIGIN } from './harness.js';

export function requireServices() {
  const mongoUri = process.env.MONGODB_URI;
  const redisUrl = process.env.REDIS_URL;
  if (!mongoUri || !redisUrl) {
    throw new Error(
      'Integration tests need MONGODB_URI and REDIS_URL. Start them with `pnpm infra:up` and see .env.example.',
    );
  }
  // The suites wipe the database between tests: refuse anything that is not clearly a test DB.
  const dbName = new URL(mongoUri.replace(/^mongodb(\+srv)?:/, 'http:')).pathname.slice(1);
  if (!/test/i.test(dbName)) {
    throw new Error(
      `Refusing to run integration tests against database "${dbName}": its name must contain "test" because the suites delete all data.`,
    );
  }
  const url = new URL(redisUrl);
  url.pathname = '/15';
  return { mongoUri, redisUrl: url.toString() };
}

/** Registers hooks that connect once and wipe all data before each test. */
export function useIntegrationServices() {
  const { mongoUri, redisUrl } = requireServices();
  const logger = createLogger({ service: 'integration', level: 'silent' });
  const redis = createRedis(redisUrl, logger);

  beforeAll(async () => {
    await connectMongo({ uri: mongoUri, autoIndex: false, logger });
    await ensureIndexes();
    await redis.connect();
  });

  beforeEach(async () => {
    const db = mongoose.connection.db!;
    // Native driver: the audit model itself refuses deletes (append-only).
    for (const { name } of await db.listCollections().toArray()) {
      await db.collection(name).deleteMany({});
    }
    await redis.flushdb();
    // Seeded at API start in real deployments.
    await ensureConsentTexts();
  });

  afterAll(async () => {
    await disconnectMongo();
    await redis.quit();
  });

  return { redis: redis as Redis };
}

export function extractCode(text: string): string {
  const match = new RegExp(`\\b(\\d{${OTP_LENGTH}})\\b`).exec(text);
  if (!match) throw new Error('No OTP found in message');
  return match[1]!;
}

const base = (audience: SessionAudience) =>
  audience === 'admin' ? '/api/v1/admin/auth' : '/api/v1/auth';

/**
 * Full email-OTP sign-in through the public API, reading the code from the
 * recording email provider. Returns the agent (which holds the refresh cookie).
 */
export async function signInWithEmail(
  app: Express,
  sent: { to: string; text: string }[],
  email: string,
  audience: SessionAudience = 'candidate',
) {
  const agent = request.agent(app);
  const requested = await agent
    .post(`${base(audience)}/otp/request`)
    .set('Origin', TEST_ORIGIN)
    .send({ channel: 'EMAIL', destination: email })
    .expect(202);
  const message = [...sent].reverse().find((m) => m.to === email.toLowerCase());
  if (!message) throw new Error(`No email sent to ${email}`);
  const verified = await agent
    .post(`${base(audience)}/otp/verify`)
    .set('Origin', TEST_ORIGIN)
    .send({ challengeId: requested.body.data.challengeId, code: extractCode(message.text) })
    .expect(200);
  return {
    agent,
    accessToken: verified.body.data.accessToken as string,
    user: verified.body.data.user,
    response: verified,
  };
}

export function refresh(
  agent: ReturnType<typeof request.agent>,
  audience: SessionAudience = 'candidate',
) {
  return agent
    .post(`${base(audience)}/refresh`)
    .set('Origin', TEST_ORIGIN)
    .set(CSRF_HEADER, '1');
}

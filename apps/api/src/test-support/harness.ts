/**
 * TEST SUPPORT ONLY. Builds a fully wired API with recording email/SMS
 * providers and a locally signed "Google" key set. Excluded from builds.
 */
import { apiEnvSchema, createLogger, loadEnv, type ApiEnv } from '@cbi/config';
import { createRedis, type Redis } from '@cbi/db';
import {
  createMemoryStorage,
  createRecordingEmailProvider,
  createRecordingSmsProvider,
} from '@cbi/provider-adapters/testing';
import type { AdapterRegistry } from '@cbi/ai-core';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { createApp } from '../app.js';
import { buildContainer } from '../container.js';
import type { JobQueues } from '../lib/jobs.js';

export const TEST_GOOGLE_CLIENT_ID = 'test-client.apps.googleusercontent.com';
export const TEST_ORIGIN = 'http://localhost:5173';
export const TEST_AI_MASTER_KEY = Buffer.alloc(32, 9).toString('base64');

export function testEnv(overrides: Record<string, string> = {}): ApiEnv {
  return loadEnv(apiEnvSchema, {
    APP_ENV: 'test',
    LOG_LEVEL: 'silent',
    MONGODB_URI: process.env.MONGODB_URI ?? 'mongodb://127.0.0.1:1/unused?directConnection=true',
    REDIS_URL: process.env.REDIS_URL ?? 'redis://127.0.0.1:1',
    CORS_ALLOWED_ORIGINS: `${TEST_ORIGIN},http://localhost:5174`,
    PUBLIC_CANDIDATE_URL: 'http://localhost:5173',
    PUBLIC_ADMIN_URL: 'http://localhost:5174',
    JWT_ACCESS_SECRET: 'test-jwt-secret-0123456789abcdef0123456789',
    OTP_HMAC_SECRET: 'test-otp-secret-0123456789abcdef0123456789',
    GOOGLE_CLIENT_ID: TEST_GOOGLE_CLIENT_ID,
    EMAIL_PROVIDER: 'smtp',
    EMAIL_FROM: 'test@localhost',
    SMTP_HOST: 'localhost',
    SMS_PROVIDER: 'dev-mailbox',
    OTP_RESEND_COOLDOWN_SEC: '10',
    REQUEST_BODY_LIMIT: '4kb',
    AI_SECRETS_MASTER_KEY: TEST_AI_MASTER_KEY,
    AI_MOCK_MODE: 'true',
    ...overrides,
  });
}

export type RecordedJob =
  | { kind: 'resume'; id: string }
  | { kind: 'jobTarget'; id: string }
  | { kind: 'analyze'; id: string; attempt: number };

/** Records enqueued work instead of sending it to Redis; `fail` simulates a queue outage. */
export function createRecordingJobQueues() {
  const jobs: RecordedJob[] = [];
  const state = { fail: false };
  const record = async (job: RecordedJob) => {
    if (state.fail) throw new Error('queue unavailable');
    jobs.push(job);
  };
  const queues: JobQueues = {
    extractResume: (id) => record({ kind: 'resume', id }),
    extractJobTarget: (id) => record({ kind: 'jobTarget', id }),
    analyzeInterview: (id, attempt) => record({ kind: 'analyze', id, attempt }),
    close: async () => undefined,
  };
  return { queues, jobs, state };
}

/** A stand-in for Google's signing keys: tokens signed here verify like real ones. */
export async function createFakeGoogleIssuer() {
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const jwk = { ...(await exportJWK(publicKey)), kid: 'test-key', alg: 'RS256', use: 'sig' };
  const keySet = createLocalJWKSet({ keys: [jwk] });
  async function sign(
    claims: { sub: string; email: string; email_verified?: boolean; name?: string },
    opts: { audience?: string; issuer?: string } = {},
  ) {
    return new SignJWT({ email_verified: true, ...claims })
      .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
      .setIssuer(opts.issuer ?? 'https://accounts.google.com')
      .setAudience(opts.audience ?? TEST_GOOGLE_CLIENT_ID)
      .setIssuedAt()
      .setExpirationTime('10m')
      .sign(privateKey);
  }
  return { keySet, sign };
}

export async function buildTestApp(
  opts: {
    redis?: Redis;
    env?: Record<string, string>;
    rateLimitRedis?: Redis | null;
    aiAdapters?: AdapterRegistry;
  } = {},
) {
  const env = testEnv(opts.env);
  // TEST_LOG_LEVEL=error surfaces server-side errors while debugging a failing suite.
  const logger = createLogger({
    service: 'api-test',
    level: (process.env.TEST_LOG_LEVEL as 'error' | undefined) ?? 'silent',
  });
  // Unit tests never touch Redis; a lazy client to a closed port is never used.
  const redis = opts.redis ?? createRedis('redis://127.0.0.1:1', logger);
  const email = createRecordingEmailProvider();
  const sms = createRecordingSmsProvider();
  const google = await createFakeGoogleIssuer();
  const storage = createMemoryStorage();
  const jobs = createRecordingJobQueues();
  const container = buildContainer({
    env,
    logger,
    redis,
    rateLimitRedis: opts.rateLimitRedis ?? null,
    overrides: {
      email: email.provider,
      sms: env.SMS_PROVIDER === 'disabled' ? null : sms.provider,
      googleKeySet: google.keySet,
      aiAdapters: opts.aiAdapters,
      storage: storage.storage,
      jobs: jobs.queues,
    },
  });
  const app = createApp({
    container,
    logger,
    probes: { mongo: async () => undefined, redis: async () => undefined },
    isDraining: () => false,
  });
  return { app, container, env, email, sms, google, storage, jobs };
}

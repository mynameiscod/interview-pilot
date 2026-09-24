import { createAccessTokenIssuer } from '@cbi/auth-core';
import type { ApiEnv, Logger } from '@cbi/config';
import type { Redis } from '@cbi/db';
import {
  createDevMailboxSmsProvider,
  createMsg91OtpProvider,
  createSesEmailProvider,
  createSmtpEmailProvider,
  createStorage,
  type EmailProvider,
  type OtpSmsProvider,
  type StorageProvider,
} from '@cbi/provider-adapters';
import type { AdapterRegistry, UsageSink } from '@cbi/ai-core';
import type { JWTVerifyGetKey } from 'jose';
import { createAuditService } from './lib/audit.js';
import { createBullJobQueues, type JobQueues } from './lib/jobs.js';
import { createRateLimiters } from './middleware/rate-limit.js';
import { createAdminUserService } from './modules/admin/admin-users.service.js';
import { createAiAdminService } from './modules/ai/ai-admin.service.js';
import { buildAiRuntime } from '@cbi/ai-runtime';
import { createAccountService } from './modules/auth/account.service.js';
import type { CookieSettings } from './modules/auth/cookies.js';
import { createGoogleVerifier } from './modules/auth/google-verifier.js';
import { createOtpService } from './modules/auth/otp.service.js';
import { createSessionService } from './modules/auth/session.service.js';
import { createUserStateCache } from './modules/auth/user-state.js';
import { createInputsService } from './modules/inputs/inputs.service.js';
import { createInterviewService } from './modules/interviews/interviews.service.js';
import { createLibraryAdminService } from './modules/library/library-admin.service.js';
import { createLiveInterviewService, createRoomEmitter } from './modules/live/live.service.js';

export interface ContainerOptions {
  env: ApiEnv;
  logger: Logger;
  redis: Redis;
  /** Redis for rate-limit counters; null uses in-memory counters (unit tests only). */
  rateLimitRedis: Redis | null;
  /** BullMQ connection (maxRetriesPerRequest: null); unused when `overrides.jobs` is set. */
  queueRedis?: Redis;
  /** Test overrides. Production wiring always comes from `env`. */
  overrides?: {
    email?: EmailProvider;
    sms?: OtpSmsProvider | null;
    googleKeySet?: JWTVerifyGetKey;
    aiAdapters?: AdapterRegistry;
    aiUsage?: UsageSink;
    storage?: StorageProvider;
    jobs?: JobQueues;
  };
}

function buildEmailProvider(env: ApiEnv): EmailProvider {
  if (env.EMAIL_PROVIDER === 'ses') {
    return createSesEmailProvider({
      region: env.SES_REGION!,
      from: env.EMAIL_FROM,
      credentials:
        env.SES_ACCESS_KEY_ID && env.SES_SECRET_ACCESS_KEY
          ? { accessKeyId: env.SES_ACCESS_KEY_ID, secretAccessKey: env.SES_SECRET_ACCESS_KEY }
          : undefined,
    });
  }
  return createSmtpEmailProvider({
    host: env.SMTP_HOST!,
    port: env.SMTP_PORT,
    secure: env.SMTP_SECURE,
    requireTls: env.SMTP_REQUIRE_TLS,
    from: env.EMAIL_FROM,
    auth: env.SMTP_USER && env.SMTP_PASS ? { user: env.SMTP_USER, pass: env.SMTP_PASS } : undefined,
  });
}

function buildSmsProvider(env: ApiEnv, email: EmailProvider): OtpSmsProvider | null {
  switch (env.SMS_PROVIDER) {
    case 'msg91':
      return createMsg91OtpProvider({
        authKey: env.MSG91_AUTH_KEY!,
        templateId: env.MSG91_OTP_TEMPLATE_ID!,
        otpVariable: env.MSG91_OTP_VARIABLE,
      });
    case 'dev-mailbox':
      return createDevMailboxSmsProvider(email);
    case 'disabled':
      return null;
  }
}

function jobQueues(queueRedis: Redis | undefined): JobQueues {
  if (!queueRedis) throw new Error('buildContainer needs queueRedis (or overrides.jobs)');
  return createBullJobQueues(queueRedis);
}

export function buildContainer(opts: ContainerOptions) {
  const { env, logger, redis } = opts;
  const email = opts.overrides?.email ?? buildEmailProvider(env);
  const sms = opts.overrides?.sms !== undefined ? opts.overrides.sms : buildSmsProvider(env, email);

  const tokens = createAccessTokenIssuer({
    secret: env.JWT_ACCESS_SECRET,
    ttlSec: env.JWT_ACCESS_TTL_SEC,
  });
  const audit = createAuditService({ hashSecret: env.OTP_HMAC_SECRET, logger });
  const userState = createUserStateCache(redis);
  const accounts = createAccountService();
  const sessions = createSessionService({
    tokens,
    userState,
    audit,
    hashSecret: env.OTP_HMAC_SECRET,
    refreshTtlMs: {
      candidate: env.REFRESH_TTL_CANDIDATE_DAYS * 24 * 3600 * 1000,
      admin: env.REFRESH_TTL_ADMIN_HOURS * 3600 * 1000,
    },
  });
  const otp = createOtpService({
    redis,
    email,
    sms,
    accounts,
    audit,
    logger,
    hashSecret: env.OTP_HMAC_SECRET,
    ttlSec: env.OTP_TTL_SEC,
    maxAttempts: env.OTP_MAX_ATTEMPTS,
    resendCooldownSec: env.OTP_RESEND_COOLDOWN_SEC,
    maxPerDestinationPerHour: env.OTP_MAX_PER_DESTINATION_PER_HOUR,
  });
  const google = env.GOOGLE_CLIENT_ID
    ? createGoogleVerifier({ clientId: env.GOOGLE_CLIENT_ID, keySet: opts.overrides?.googleKeySet })
    : null;
  const adminUsers = createAdminUserService({
    accounts,
    sessions,
    userState,
    audit,
    email,
    logger,
    adminUrl: env.PUBLIC_ADMIN_URL,
  });
  const ai = buildAiRuntime({
    env,
    logger,
    redis,
    adapters: opts.overrides?.aiAdapters,
    usage: opts.overrides?.aiUsage,
  });
  const aiAdmin = createAiAdminService({ ai, audit, logger });
  const storage = opts.overrides?.storage ?? createStorage(env);
  const jobs = opts.overrides?.jobs ?? jobQueues(opts.queueRedis);
  const inputs = createInputsService({ storage, jobs, audit, logger });
  const interviews = createInterviewService({ jobs, audit, logger });
  const libraryAdmin = createLibraryAdminService({ audit });
  const rooms = createRoomEmitter();
  const live = createLiveInterviewService({ ai, redis, logger, rooms });
  const cookies: CookieSettings = {
    secure: env.APP_ENV !== 'development' && env.APP_ENV !== 'test',
    domain: env.COOKIE_DOMAIN,
  };

  return {
    env,
    logger,
    tokens,
    audit,
    userState,
    accounts,
    sessions,
    otp,
    google,
    adminUsers,
    ai,
    aiAdmin,
    storage,
    jobs,
    inputs,
    interviews,
    libraryAdmin,
    rooms,
    live,
    cookies,
    providers: {
      email: email.name,
      sms: sms?.name ?? null,
      aiMock: ai.mockEnabled,
      storage: storage.name,
    },
    limiters: createRateLimiters(opts.rateLimitRedis),
  };
}

export type Container = ReturnType<typeof buildContainer>;

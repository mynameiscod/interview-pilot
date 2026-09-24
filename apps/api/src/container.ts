import { createHmac } from 'node:crypto';
import { createAccessTokenIssuer } from '@cbi/auth-core';
import type { ApiEnv, Logger } from '@cbi/config';
import type { Redis } from '@cbi/db';
import {
  createDevMailboxSmsProvider,
  createEmailProvider,
  createMsg91OtpProvider,
  createJudge,
  createPaymentGateway,
  createStorage,
  mockGatewayControls,
  type EmailProvider,
  type JudgeAdapter,
  type OtpSmsProvider,
  type PaymentGateway,
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
import { createPaymentsService } from './modules/payments/payments.service.js';
import { createReportsService } from './modules/reports/reports.service.js';
import { createTranscriptStore, createVoiceService } from './modules/voice/voice.service.js';
import { createConsentService } from './modules/consent/consent.service.js';
import { createMediaService } from './modules/media/media.service.js';
import { codingQuestionText, createCodingService } from './modules/coding/coding.service.js';
import { createCampaignService } from './modules/campaigns/campaigns.service.js';
import { createReviewService } from './modules/review/review.service.js';

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
    /** A payment gateway (tests pass a fresh mock) and, for a mock, its controls. */
    payments?: { gateway: PaymentGateway; mock: ReturnType<typeof mockGatewayControls> };
    /** A code judge (tests pass a controllable mock). */
    judge?: JudgeAdapter;
  };
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

type LiveAnswer = ReturnType<typeof createLiveInterviewService>['answer'];

export function buildContainer(opts: ContainerOptions) {
  const { env, logger, redis } = opts;
  // The API always has email (sign-in codes); environment validation guarantees a provider.
  const email = opts.overrides?.email ?? createEmailProvider(env)!;
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
  const consent = createConsentService({ audit, hashSecret: env.OTP_HMAC_SECRET });
  const interviews = createInterviewService({ jobs, audit, logger, consent });
  const libraryAdmin = createLibraryAdminService({ audit });
  const rooms = createRoomEmitter();
  const transcripts = createTranscriptStore(redis);
  const voice = createVoiceService({ ai, redis, logger, rooms, audit, transcripts, consent });
  const media = createMediaService({
    storage,
    audit,
    logger,
    retentionDays: env.MEDIA_RETENTION_DAYS_DEFAULT,
    // A separate key per purpose, derived from the server secret.
    signingSecret: createHmac('sha256', env.OTP_HMAC_SECRET).update('media-playback').digest('hex'),
  });
  const judge = opts.overrides?.judge ?? createJudge(env);
  // `live` is created below; submitting code answers through it.
  let liveRef: { answer: LiveAnswer } | null = null;
  const coding = createCodingService({
    judge,
    audit,
    logger,
    answer: (userId, payload, o) => liveRef!.answer(userId, payload, o),
  });
  const live = createLiveInterviewService({
    ai,
    redis,
    logger,
    rooms,
    audit,
    jobs,
    transcripts,
    consent,
    onQuestion: (s, turn) => voice.warmQuestionAudio(s, turn),
    pickCodingProblem: async (s, target) => {
      const p = await coding.pickProblem(s, target);
      return p ? { _id: p._id, title: p.content.title, text: codingQuestionText(p) } : null;
    },
  });
  liveRef = live;
  const reports = createReportsService({ storage, jobs, audit });
  const campaigns = createCampaignService({
    audit,
    logger,
    storage,
    analyze: (userId, sessionId, ctx) => interviews.analyze(userId, sessionId, ctx),
  });
  const review = createReviewService({ audit, jobs, logger });
  const paymentGateway = opts.overrides?.payments?.gateway ?? createPaymentGateway(env);
  const payments = createPaymentsService({ gateway: paymentGateway, audit, logger });
  // Mock Checkout controls exist only with the mock gateway (refused outside development/test).
  const paymentMock = opts.overrides?.payments
    ? opts.overrides.payments.mock
    : mockGatewayControls(env);
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
    voice,
    consent,
    media,
    coding,
    judge,
    reports,
    campaigns,
    review,
    payments,
    paymentMock,
    cookies,
    providers: {
      email: email.name,
      sms: sms?.name ?? null,
      aiMock: ai.mockEnabled,
      storage: storage.name,
      payments: paymentGateway.name,
      judge: judge.name,
    },
    limiters: createRateLimiters(opts.rateLimitRedis),
  };
}

export type Container = ReturnType<typeof buildContainer>;

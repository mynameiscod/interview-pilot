import { createAccessTokenIssuer } from '@cbi/auth-core';
import type { ApiEnv, Logger } from '@cbi/config';
import type { Redis } from '@cbi/db';
import {
  createDevMailboxSmsProvider,
  createMsg91OtpProvider,
  createSesEmailProvider,
  createSmtpEmailProvider,
  type EmailProvider,
  type OtpSmsProvider,
} from '@cbi/provider-adapters';
import type { JWTVerifyGetKey } from 'jose';
import { createAuditService } from './lib/audit.js';
import { createRateLimiters } from './middleware/rate-limit.js';
import { createAdminUserService } from './modules/admin/admin-users.service.js';
import { createAccountService } from './modules/auth/account.service.js';
import type { CookieSettings } from './modules/auth/cookies.js';
import { createGoogleVerifier } from './modules/auth/google-verifier.js';
import { createOtpService } from './modules/auth/otp.service.js';
import { createSessionService } from './modules/auth/session.service.js';
import { createUserStateCache } from './modules/auth/user-state.js';

export interface ContainerOptions {
  env: ApiEnv;
  logger: Logger;
  redis: Redis;
  /** Redis for rate-limit counters; null uses in-memory counters (unit tests only). */
  rateLimitRedis: Redis | null;
  /** Test overrides. Production wiring always comes from `env`. */
  overrides?: {
    email?: EmailProvider;
    sms?: OtpSmsProvider | null;
    googleKeySet?: JWTVerifyGetKey;
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
    cookies,
    providers: { email: email.name, sms: sms?.name ?? null },
    limiters: createRateLimiters(opts.rateLimitRedis),
  };
}

export type Container = ReturnType<typeof buildContainer>;

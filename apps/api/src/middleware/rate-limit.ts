import { createHash } from 'node:crypto';
import type { Redis } from '@cbi/db';
import type { RequestHandler } from 'express';
import { ipKeyGenerator, rateLimit, type Options } from 'express-rate-limit';
import { RedisStore, type RedisReply } from 'rate-limit-redis';
import { AppError } from '../lib/errors.js';

export type RateLimiterName =
  | 'public'
  | 'auth'
  | 'refresh'
  | 'refreshSession'
  | 'otpRequest'
  | 'otpVerify'
  | 'admin'
  | 'aiTest'
  | 'upload'
  | 'jdUrl'
  | 'analysis'
  | 'payment'
  | 'voice'
  | 'media'
  | 'coding'
  | 'analytics'
  | 'jobCreate'
  | 'dataExport';

/**
 * Separate limits per endpoint class (a single global limit would block
 * legitimate interview traffic). Counters live in Redis so limits hold across
 * API replicas. Only the broad `public` limiter fails open if Redis is down;
 * authentication limiters fail closed.
 */
const LIMITS: Record<RateLimiterName, { windowMs: number; limit: number; failOpen: boolean }> = {
  public: { windowMs: 60_000, limit: 300, failOpen: true },
  auth: { windowMs: 60_000, limit: 30, failOpen: false },
  /**
   * Token refresh, per IP. Much higher than `auth`: a campus or office NAT
   * puts hundreds of students behind one address, and every open tab
   * refreshes about every 10 minutes. `refreshSession` bounds each session.
   */
  refresh: { windowMs: 60_000, limit: 600, failOpen: false },
  /** Token refresh, per session (refresh cookie): a runaway tab cannot starve its neighbours. */
  refreshSession: { windowMs: 60_000, limit: 20, failOpen: false },
  otpRequest: { windowMs: 15 * 60_000, limit: 10, failOpen: false },
  otpVerify: { windowMs: 60_000, limit: 15, failOpen: false },
  admin: { windowMs: 60_000, limit: 300, failOpen: true },
  /** Admin model connectivity tests make real, billed provider calls. */
  aiTest: { windowMs: 60_000, limit: 10, failOpen: false },
  /** Resume and JD uploads (storage writes and parsing work). */
  upload: { windowMs: 10 * 60_000, limit: 20, failOpen: false },
  /** JD URL fetches: outbound requests to user-chosen hosts. */
  jdUrl: { windowMs: 10 * 60_000, limit: 10, failOpen: false },
  /** Role analysis runs several billed AI calls. */
  analysis: { windowMs: 10 * 60_000, limit: 15, failOpen: false },
  /** Quotes, orders and verification (each order opens a gateway order). */
  payment: { windowMs: 10 * 60_000, limit: 40, failOpen: false },
  /** Transcriptions and question audio: billed speech calls (about one of each per question). */
  voice: { windowMs: 10 * 60_000, limit: 150, failOpen: false },
  /** Recording segments: one per 10 s while recording, plus retries after a network drop. */
  media: { windowMs: 10 * 60_000, limit: 300, failOpen: false },
  /** Code runs and submissions (each is a judge execution). */
  coding: { windowMs: 10 * 60_000, limit: 60, failOpen: false },
  /** Analytics batches (losing some events is fine when Redis is down). */
  analytics: { windowMs: 60_000, limit: 60, failOpen: true },
  /** Job descriptions created from pasted text or links (each starts extraction work). */
  jobCreate: { windowMs: 10 * 60_000, limit: 30, failOpen: false },
  /** Data exports: each reads everything the person has; a few per hour is plenty. */
  dataExport: { windowMs: 60 * 60_000, limit: 5, failOpen: false },
};

/**
 * Key for per-session limits on cookie-authenticated endpoints: a hash of the
 * cookies sent to the auth path (in practice, the refresh cookie), else the IP.
 */
export function sessionKey(cookieHeader: string | undefined, ip: string): string {
  return cookieHeader
    ? `session:${createHash('sha256').update(cookieHeader).digest('hex').slice(0, 32)}`
    : ipKeyGenerator(ip);
}

/** Limiters mounted after authentication count per user rather than per IP. */
const PER_USER = new Set<RateLimiterName>([
  'admin',
  'aiTest',
  'upload',
  'jdUrl',
  'analysis',
  'payment',
  'voice',
  'media',
  'coding',
  'jobCreate',
  'dataExport',
]);

/** @param redis null → in-process memory counters (single-process tests only). */
export function createRateLimiters(redis: Redis | null): Record<RateLimiterName, RequestHandler> {
  const make = (name: RateLimiterName): RequestHandler => {
    const { windowMs, limit, failOpen } = LIMITS[name];
    const options: Partial<Options> = {
      windowMs,
      limit,
      standardHeaders: 'draft-8',
      legacyHeaders: false,
      passOnStoreError: failOpen,
      keyGenerator: (req) =>
        name === 'refreshSession'
          ? sessionKey(req.headers.cookie, req.ip ?? '')
          : PER_USER.has(name) && req.auth
            ? `user:${req.auth.userId}`
            : ipKeyGenerator(req.ip ?? ''),
      handler: (_req, _res, next) =>
        next(new AppError(429, 'RATE_LIMITED', 'Too many requests. Please wait and try again.')),
    };
    if (redis) {
      options.store = new RedisStore({
        prefix: `cbi:rl:${name}:`,
        sendCommand: (command: string, ...args: string[]) =>
          redis.call(command, ...args) as Promise<RedisReply>,
      });
    }
    return rateLimit(options);
  };
  return {
    public: make('public'),
    auth: make('auth'),
    refresh: make('refresh'),
    refreshSession: make('refreshSession'),
    otpRequest: make('otpRequest'),
    otpVerify: make('otpVerify'),
    admin: make('admin'),
    aiTest: make('aiTest'),
    upload: make('upload'),
    jdUrl: make('jdUrl'),
    analysis: make('analysis'),
    payment: make('payment'),
    voice: make('voice'),
    media: make('media'),
    coding: make('coding'),
    analytics: make('analytics'),
    jobCreate: make('jobCreate'),
    dataExport: make('dataExport'),
  };
}

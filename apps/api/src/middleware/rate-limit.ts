import type { Redis } from '@cbi/db';
import type { RequestHandler } from 'express';
import { ipKeyGenerator, rateLimit, type Options } from 'express-rate-limit';
import { RedisStore, type RedisReply } from 'rate-limit-redis';
import { AppError } from '../lib/errors.js';

export type RateLimiterName = 'public' | 'auth' | 'otpRequest' | 'otpVerify' | 'admin';

/**
 * Separate limits per endpoint class (a single global limit would block
 * legitimate interview traffic). Counters live in Redis so limits hold across
 * API replicas. Only the broad `public` limiter fails open if Redis is down;
 * authentication limiters fail closed.
 */
const LIMITS: Record<RateLimiterName, { windowMs: number; limit: number; failOpen: boolean }> = {
  public: { windowMs: 60_000, limit: 300, failOpen: true },
  auth: { windowMs: 60_000, limit: 30, failOpen: false },
  otpRequest: { windowMs: 15 * 60_000, limit: 10, failOpen: false },
  otpVerify: { windowMs: 60_000, limit: 15, failOpen: false },
  admin: { windowMs: 60_000, limit: 300, failOpen: true },
};

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
        name === 'admin' && req.auth ? `user:${req.auth.userId}` : ipKeyGenerator(req.ip ?? ''),
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
    otpRequest: make('otpRequest'),
    otpVerify: make('otpVerify'),
    admin: make('admin'),
  };
}

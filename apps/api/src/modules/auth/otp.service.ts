import {
  generateOtp,
  hashOtp,
  keyedHash,
  maskEmail,
  maskMobile,
  normalizeEmail,
  normalizeMobile,
  verifyOtp,
} from '@cbi/auth-core';
import type { Logger } from '@cbi/config';
import type { Redis } from '@cbi/db';
import { mongoose, OtpChallengeModel } from '@cbi/db';
import type { EmailProvider, OtpSmsProvider } from '@cbi/provider-adapters';
import type { OtpChannel, OtpRequestResponse, SessionAudience } from '@cbi/shared-types';
import type { AuditService } from '../../lib/audit.js';
import { AppError } from '../../lib/errors.js';
import type { ClientContext } from '../../lib/request-context.js';
import type { AccountService } from './account.service.js';
import { otpEmail } from './messages.js';

export type OtpPurpose = 'LOGIN' | 'LINK';

export interface OtpServiceOptions {
  redis: Redis;
  email: EmailProvider;
  /** Null when SMS is disabled. */
  sms: OtpSmsProvider | null;
  accounts: AccountService;
  audit: AuditService;
  logger: Logger;
  hashSecret: string;
  ttlSec: number;
  maxAttempts: number;
  resendCooldownSec: number;
  maxPerDestinationPerHour: number;
}

export interface VerifiedOtp {
  channel: OtpChannel;
  destination: string;
  userId: string | null;
}

export function createOtpService(opts: OtpServiceOptions) {
  function normalize(channel: OtpChannel, raw: string): string {
    const value = channel === 'EMAIL' ? normalizeEmail(raw) : normalizeMobile(raw);
    if (!value) {
      throw AppError.validation(
        channel === 'EMAIL' ? 'Enter a valid email address' : 'Enter a valid mobile number',
        { field: 'destination' },
      );
    }
    return value;
  }

  /** Per-destination throttles, independent of IP-based rate limiting. */
  async function enforceSendLimits(channel: OtpChannel, destination: string) {
    const id = keyedHash(opts.hashSecret, `otp:${channel}:${destination}`);
    const cooldownKey = `cbi:otp:cooldown:${id}`;
    const hourKey = `cbi:otp:hour:${id}`;
    const acquired = await opts.redis.set(cooldownKey, '1', 'EX', opts.resendCooldownSec, 'NX');
    if (!acquired) {
      const ttl = await opts.redis.ttl(cooldownKey);
      throw new AppError(429, 'OTP_COOLDOWN', 'Please wait before requesting another code.', {
        retryAfterSec: Math.max(ttl, 1),
      });
    }
    const count = await opts.redis.incr(hourKey);
    if (count === 1) await opts.redis.expire(hourKey, 3600);
    if (count > opts.maxPerDestinationPerHour) {
      throw new AppError(429, 'RATE_LIMITED', 'Too many codes requested. Please try again later.');
    }
    return { releaseCooldown: () => opts.redis.del(cooldownKey) };
  }

  return {
    async request(input: {
      audience: SessionAudience;
      purpose: OtpPurpose;
      channel: OtpChannel;
      rawDestination: string;
      userId?: string;
      ctx: ClientContext;
    }): Promise<OtpRequestResponse> {
      const { audience, purpose, channel, ctx } = input;
      if (channel === 'MOBILE' && !opts.sms) {
        throw new AppError(503, 'FEATURE_DISABLED', 'Mobile sign-in is not available yet.');
      }
      const destination = normalize(channel, input.rawDestination);
      const limits = await enforceSendLimits(channel, destination);

      // Admin codes go only to existing admins. Others get an identical response
      // and a challenge that can never verify, so the endpoint does not reveal
      // which addresses belong to staff.
      const deliverable =
        audience === 'candidate' ||
        (await opts.accounts.findActiveAdminByContact(channel, destination)) !== null;

      const now = Date.now();
      const expiresAt = new Date(now + opts.ttlSec * 1000);
      const challengeId = new mongoose.Types.ObjectId();
      const code = generateOtp();
      await OtpChallengeModel.create({
        _id: challengeId,
        purpose,
        audience,
        channel,
        destination,
        userId: input.userId,
        codeHash: deliverable ? hashOtp(opts.hashSecret, String(challengeId), code) : undefined,
        deliverable,
        maxAttempts: opts.maxAttempts,
        expiresAt,
        purgeAt: new Date(expiresAt.getTime() + 24 * 3600 * 1000),
      });

      if (deliverable) {
        const ttlMinutes = Math.round(opts.ttlSec / 60);
        try {
          if (channel === 'EMAIL') {
            await opts.email.send(otpEmail(destination, code, ttlMinutes, audience));
          } else {
            await opts.sms!.sendOtp({ to: destination, code, ttlMinutes });
          }
        } catch (err) {
          opts.logger.error({ err, channel }, 'otp delivery failed');
          await OtpChallengeModel.updateOne(
            { _id: challengeId },
            { $set: { consumedAt: new Date() } },
          );
          await limits.releaseCooldown();
          throw new AppError(
            503,
            'PROVIDER_UNAVAILABLE',
            'We could not send your code right now. Please try again in a moment.',
          );
        }
      }

      await opts.audit.record(
        {
          actorType: input.userId ? 'USER' : 'ANONYMOUS',
          actorId: input.userId,
          action: 'auth.otp_requested',
          details: { audience, purpose, channel, deliverable },
        },
        ctx,
      );

      return {
        challengeId: String(challengeId),
        sentTo: channel === 'EMAIL' ? maskEmail(destination) : maskMobile(destination),
        expiresAt: expiresAt.toISOString(),
        resendAvailableAt: new Date(now + opts.resendCooldownSec * 1000).toISOString(),
      };
    },

    async verify(input: {
      audience: SessionAudience;
      purpose: OtpPurpose;
      challengeId: string;
      code: string;
      userId?: string;
      ctx: ClientContext;
    }): Promise<VerifiedOtp> {
      const { audience, purpose, ctx } = input;
      const invalid = () => new AppError(400, 'OTP_INVALID', 'That code is not correct.');
      if (!mongoose.isValidObjectId(input.challengeId)) throw invalid();

      const fail = async (reason: string, error: AppError) => {
        await opts.audit.record(
          {
            actorType: input.userId ? 'USER' : 'ANONYMOUS',
            actorId: input.userId,
            action: 'auth.otp_verify_failed',
            outcome: 'FAILURE',
            details: { audience, purpose, reason, challengeId: input.challengeId },
          },
          ctx,
        );
        return error;
      };

      // Count the attempt atomically before checking the code.
      const challenge = await OtpChallengeModel.findOneAndUpdate(
        {
          _id: input.challengeId,
          audience,
          purpose,
          consumedAt: { $exists: false },
          $expr: { $lt: ['$attempts', '$maxAttempts'] },
        },
        { $inc: { attempts: 1 } },
        { returnDocument: 'after' },
      ).lean();

      if (!challenge) {
        const existing = await OtpChallengeModel.findById(input.challengeId).lean();
        if (existing && !existing.consumedAt && existing.attempts >= existing.maxAttempts) {
          throw await fail(
            'too_many_attempts',
            new AppError(
              429,
              'OTP_TOO_MANY_ATTEMPTS',
              'Too many incorrect attempts. Request a new code.',
            ),
          );
        }
        throw await fail('not_found_or_used', invalid());
      }
      if (purpose === 'LINK' && String(challenge.userId) !== input.userId) {
        throw await fail('wrong_user', invalid());
      }
      if (challenge.expiresAt.getTime() <= Date.now()) {
        throw await fail(
          'expired',
          new AppError(400, 'OTP_EXPIRED', 'That code has expired. Request a new one.'),
        );
      }
      const ok =
        challenge.deliverable &&
        challenge.codeHash != null &&
        verifyOtp(opts.hashSecret, String(challenge._id), input.code, challenge.codeHash);
      if (!ok) {
        const remaining = challenge.maxAttempts - challenge.attempts;
        throw await fail(
          'wrong_code',
          new AppError(400, 'OTP_INVALID', 'That code is not correct.', {
            remainingAttempts: remaining,
          }),
        );
      }

      const consumed = await OtpChallengeModel.updateOne(
        { _id: challenge._id, consumedAt: { $exists: false } },
        { $set: { consumedAt: new Date() } },
      );
      if (consumed.modifiedCount !== 1) throw await fail('race', invalid());

      return {
        channel: challenge.channel as OtpChannel,
        destination: challenge.destination,
        userId: challenge.userId ? String(challenge.userId) : null,
      };
    },
  };
}

export type OtpService = ReturnType<typeof createOtpService>;

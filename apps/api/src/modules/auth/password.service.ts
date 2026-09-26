import { createHash } from 'node:crypto';
import {
  hashPassword,
  normalizeEmail,
  passwordProblem,
  verifyAgainstDummy,
  verifyPassword,
} from '@cbi/auth-core';
import { UserModel, type Redis } from '@cbi/db';
import type { ChangePasswordBody } from '@cbi/shared-types';
import type { AuditService } from '../../lib/audit.js';
import { AppError } from '../../lib/errors.js';
import type { ClientContext } from '../../lib/request-context.js';

/** Failed attempts per email before password sign-in pauses, and for how long. */
export const PASSWORD_MAX_FAILURES = 5;
export const PASSWORD_LOCK_SEC = 15 * 60;

const invalid = () =>
  new AppError(401, 'INVALID_CREDENTIALS', 'The email or password is incorrect.');

/**
 * Admin console password sign-in (candidates use OTP or Google). Unknown
 * emails, accounts without a password, non-admins and wrong passwords all get
 * the same answer in the same time. Failures are counted per email in Redis
 * whether or not the account exists, so a lockout reveals nothing either.
 */
export function createPasswordService(deps: {
  redis: Redis;
  audit: AuditService;
  hashSecret: string;
}) {
  const failKey = (email: string) =>
    `cbi:pwfail:${createHash('sha256').update(`${deps.hashSecret}:${email}`).digest('hex')}`;

  async function recordFailure(email: string) {
    const key = failKey(email);
    const n = await deps.redis.incr(key);
    if (n === 1) await deps.redis.expire(key, PASSWORD_LOCK_SEC);
  }

  return {
    async login(rawEmail: string, password: string, ctx: ClientContext) {
      const email = normalizeEmail(rawEmail);
      if (!email) throw invalid();
      const failures = Number((await deps.redis.get(failKey(email))) ?? 0);
      if (failures >= PASSWORD_MAX_FAILURES) {
        const ttl = await deps.redis.ttl(failKey(email));
        throw new AppError(
          429,
          'ACCOUNT_LOCKED',
          `Too many attempts. Try again in ${Math.max(1, Math.ceil(ttl / 60))} minutes, or sign in with an email code.`,
        );
      }
      const user = await UserModel.findOne({ primaryEmail: email }).select('+passwordHash');
      const ok =
        user?.passwordHash && user.adminRoles.length > 0
          ? await verifyPassword(password, user.passwordHash)
          : await verifyAgainstDummy(password);
      if (!ok || !user) {
        await recordFailure(email);
        await deps.audit.record(
          {
            actorType: 'ANONYMOUS',
            action: 'auth.login_failed',
            outcome: 'FAILURE',
            details: { audience: 'admin', method: 'password' },
          },
          ctx,
        );
        throw invalid();
      }
      if (user.status !== 'ACTIVE') {
        throw new AppError(403, 'ACCOUNT_SUSPENDED', 'This account is suspended.');
      }
      await deps.redis.del(failKey(email));
      await UserModel.updateOne({ _id: user._id }, { $set: { lastLoginAt: new Date() } });
      return user;
    },

    async hasPassword(userId: string) {
      const u = await UserModel.findById(userId).select('+passwordHash').lean();
      return Boolean(u?.passwordHash);
    },

    /** Sets or changes the signed-in admin's password (the current one is required to change it). */
    async change(userId: string, body: ChangePasswordBody, ctx: ClientContext) {
      const user = await UserModel.findById(userId).select('+passwordHash');
      if (!user || user.adminRoles.length === 0) throw AppError.forbidden();
      if (user.passwordHash) {
        if (
          !body.currentPassword ||
          !(await verifyPassword(body.currentPassword, user.passwordHash))
        ) {
          throw new AppError(400, 'INVALID_CREDENTIALS', 'The current password is incorrect.');
        }
      }
      const problem = passwordProblem(body.newPassword, user.primaryEmail);
      if (problem) throw AppError.validation(problem);
      await UserModel.updateOne(
        { _id: user._id },
        { $set: { passwordHash: await hashPassword(body.newPassword), passwordSetAt: new Date() } },
      );
      await deps.audit.record(
        {
          actorType: 'ADMIN',
          actorId: userId,
          action: user.passwordHash ? 'auth.password_changed' : 'auth.password_set',
          resourceType: 'user',
          resourceId: userId,
        },
        ctx,
      );
      return { hasPassword: true };
    },
  };
}

export type PasswordService = ReturnType<typeof createPasswordService>;

import { randomBytes } from 'node:crypto';
import type { EncryptedSecret, SecretBox } from '@cbi/ai-core';
import {
  findRecoveryCode,
  generateRecoveryCodes,
  generateTotpSecret,
  hashRecoveryCode,
  hashToken,
  otpauthUri,
  verifyTotp,
} from '@cbi/auth-core';
import { UserModel, type Redis } from '@cbi/db';
import {
  RECOVERY_CODE_COUNT,
  type AdminRole,
  type MfaChallenge,
  type MfaEnrollment,
  type MfaStatus,
} from '@cbi/shared-types';
import type { AuditService } from '../../lib/audit.js';
import { AppError } from '../../lib/errors.js';
import type { ClientContext } from '../../lib/request-context.js';

/** How long the second sign-in step stays open, and how many wrong codes it allows. */
export const MFA_CHALLENGE_TTL_SEC = 5 * 60;
export const MFA_MAX_ATTEMPTS = 5;
const ENROLL_TTL_SEC = 10 * 60;

export type MfaPolicy = 'super_admin' | 'all';

/** Whether an admin must use an authenticator app. */
export function mfaRequiredFor(roles: readonly AdminRole[], policy: MfaPolicy): boolean {
  if (roles.length === 0) return false;
  return policy === 'all' || roles.includes('SUPER_ADMIN');
}

interface ChallengeState {
  userId: string;
  method: string;
  mode: 'VERIFY' | 'ENROLL';
  /** ENROLL only: the new secret, encrypted, until the first code confirms it. */
  pending: EncryptedSecret | null;
  attempts: number;
}

interface StoredMfa {
  secret: EncryptedSecret | null;
  enabledAt: Date | null;
  lastStep: number | null;
  recoveryCodeHashes: string[];
}

const invalidCode = () => new AppError(400, 'MFA_INVALID', 'That code is not correct.');
const expired = () =>
  new AppError(401, 'MFA_EXPIRED', 'This sign-in step has expired. Please sign in again.');

/**
 * Admin two-factor authentication with TOTP (RFC 6238). The secret is
 * encrypted at rest with the platform secret box (AES-256-GCM, bound to the
 * user id); recovery codes are stored as keyed hashes and each works once.
 * Sign-in is two steps: the first factor returns a short-lived, single-use
 * challenge token (held in Redis); the code exchanges it for a session.
 */
export function createMfaService(deps: {
  redis: Redis;
  secrets: SecretBox;
  audit: AuditService;
  hashSecret: string;
  issuer: string;
  policy: MfaPolicy;
}) {
  const context = (userId: string) => `adminMfa:${userId}`;
  const challengeKey = (token: string) => `cbi:mfa:challenge:${hashToken(token)}`;
  const enrollKey = (userId: string) => `cbi:mfa:enroll:${userId}`;

  async function loadMfa(userId: string): Promise<StoredMfa | null> {
    const user = await UserModel.findById(userId).select('+mfa').lean();
    const mfa = (user as { mfa?: StoredMfa } | null)?.mfa;
    return mfa?.enabledAt && mfa.secret ? mfa : null;
  }

  function newSecret(userId: string, account: string) {
    const secret = generateTotpSecret();
    return {
      secret,
      encrypted: deps.secrets.encrypt(secret, context(userId)),
      otpauthUri: otpauthUri({ issuer: deps.issuer, account, secret }),
    };
  }

  function newRecoveryCodes() {
    const codes = generateRecoveryCodes(RECOVERY_CODE_COUNT);
    return { codes, hashes: codes.map((c) => hashRecoveryCode(deps.hashSecret, c)) };
  }

  /**
   * Accepts a code for an enabled factor, at most once per time step (the
   * conditional update makes concurrent replays of one code lose).
   */
  async function acceptTotp(userId: string, mfa: StoredMfa, code: string): Promise<boolean> {
    const secret = deps.secrets.decrypt(mfa.secret!, context(userId));
    const step = verifyTotp(secret, code, { afterStep: mfa.lastStep });
    if (step === null) return false;
    const res = await UserModel.updateOne(
      {
        _id: userId,
        $or: [{ 'mfa.lastStep': null }, { 'mfa.lastStep': { $lt: step } }],
      },
      { $set: { 'mfa.lastStep': step } },
    );
    return res.modifiedCount === 1;
  }

  async function acceptRecoveryCode(userId: string, mfa: StoredMfa, code: string) {
    const index = findRecoveryCode(deps.hashSecret, code, mfa.recoveryCodeHashes);
    if (index < 0) return false;
    // Pulling the exact hash makes each recovery code single-use, even under races.
    const res = await UserModel.updateOne(
      { _id: userId, 'mfa.recoveryCodeHashes': mfa.recoveryCodeHashes[index] },
      { $pull: { 'mfa.recoveryCodeHashes': mfa.recoveryCodeHashes[index] } },
    );
    return res.modifiedCount === 1;
  }

  async function enable(userId: string, encrypted: EncryptedSecret, step: number) {
    const { codes, hashes } = newRecoveryCodes();
    await UserModel.updateOne(
      { _id: userId },
      {
        $set: {
          mfa: {
            secret: encrypted,
            enabledAt: new Date(),
            lastStep: step,
            recoveryCodeHashes: hashes,
          },
        },
      },
    );
    return codes;
  }

  return {
    required: (roles: readonly AdminRole[]) => mfaRequiredFor(roles, deps.policy),

    async enabled(userId: string) {
      return (await loadMfa(userId)) !== null;
    },

    /**
     * After the first factor: null when no second factor is needed, else a
     * challenge (VERIFY, or ENROLL when 2FA is required but not yet set up).
     */
    async beginSignIn(
      user: { id: string; account: string; roles: AdminRole[] },
      method: string,
    ): Promise<MfaChallenge | null> {
      const mfa = await loadMfa(user.id);
      const required = mfaRequiredFor(user.roles, deps.policy);
      if (!mfa && !required) return null;
      const token = randomBytes(32).toString('base64url');
      const enrollment = mfa ? null : newSecret(user.id, user.account);
      const state: ChallengeState = {
        userId: user.id,
        method,
        mode: mfa ? 'VERIFY' : 'ENROLL',
        pending: enrollment?.encrypted ?? null,
        attempts: 0,
      };
      await deps.redis.set(challengeKey(token), JSON.stringify(state), 'EX', MFA_CHALLENGE_TTL_SEC);
      return {
        mfaRequired: true,
        mfaToken: token,
        mode: state.mode,
        enrollment: enrollment
          ? { secret: enrollment.secret, otpauthUri: enrollment.otpauthUri }
          : null,
        expiresAt: new Date(Date.now() + MFA_CHALLENGE_TTL_SEC * 1000).toISOString(),
      };
    },

    /** The second sign-in step. Returns who signed in, and recovery codes after enrolment. */
    async completeSignIn(
      input: { mfaToken: string; code?: string; recoveryCode?: string },
      ctx: ClientContext,
    ): Promise<{ userId: string; method: string; recoveryCodes: string[] | null }> {
      const key = challengeKey(input.mfaToken);
      const raw = await deps.redis.get(key);
      if (!raw) throw expired();
      const state = JSON.parse(raw) as ChallengeState;
      const fail = async () => {
        state.attempts += 1;
        if (state.attempts >= MFA_MAX_ATTEMPTS) await deps.redis.del(key);
        else await deps.redis.set(key, JSON.stringify(state), 'KEEPTTL');
        await deps.audit.record(
          {
            actorType: 'ADMIN',
            actorId: state.userId,
            action: 'auth.mfa_failed',
            outcome: 'FAILURE',
            details: { mode: state.mode, method: input.recoveryCode ? 'recovery_code' : 'totp' },
          },
          ctx,
        );
        return state.attempts >= MFA_MAX_ATTEMPTS ? expired() : invalidCode();
      };

      let recoveryCodes: string[] | null = null;
      if (state.mode === 'ENROLL') {
        if (!input.code || !state.pending) throw await fail();
        const secret = deps.secrets.decrypt(state.pending, context(state.userId));
        const step = verifyTotp(secret, input.code);
        if (step === null) throw await fail();
        // Single use: only the request that deletes the challenge may finish it.
        if ((await deps.redis.del(key)) !== 1) throw expired();
        recoveryCodes = await enable(state.userId, state.pending, step);
        await deps.audit.record(
          {
            actorType: 'ADMIN',
            actorId: state.userId,
            action: 'auth.mfa_enabled',
            details: { at: 'sign_in' },
          },
          ctx,
        );
      } else {
        const mfa = await loadMfa(state.userId);
        if (!mfa) throw expired();
        const ok = input.code
          ? await acceptTotp(state.userId, mfa, input.code)
          : await acceptRecoveryCode(state.userId, mfa, input.recoveryCode ?? '');
        if (!ok) throw await fail();
        if ((await deps.redis.del(key)) !== 1) throw expired();
        if (input.recoveryCode) {
          await deps.audit.record(
            {
              actorType: 'ADMIN',
              actorId: state.userId,
              action: 'auth.mfa_recovery_code_used',
              details: { remaining: mfa.recoveryCodeHashes.length - 1 },
            },
            ctx,
          );
        }
      }
      return { userId: state.userId, method: state.method, recoveryCodes };
    },

    async status(userId: string, roles: readonly AdminRole[]): Promise<MfaStatus> {
      const mfa = await loadMfa(userId);
      return {
        enabled: Boolean(mfa),
        required: mfaRequiredFor(roles, deps.policy),
        enabledAt: mfa?.enabledAt?.toISOString() ?? null,
        recoveryCodesRemaining: mfa?.recoveryCodeHashes.length ?? 0,
      };
    },

    /** Account page: a new secret to add to an authenticator app (confirmed by a code). */
    async startEnrollment(userId: string, account: string): Promise<MfaEnrollment> {
      if (await loadMfa(userId))
        throw AppError.conflict('Two-factor authentication is already on.');
      const enrollment = newSecret(userId, account);
      await deps.redis.set(
        enrollKey(userId),
        JSON.stringify(enrollment.encrypted),
        'EX',
        ENROLL_TTL_SEC,
      );
      return { secret: enrollment.secret, otpauthUri: enrollment.otpauthUri };
    },

    async confirmEnrollment(userId: string, code: string, ctx: ClientContext) {
      const raw = await deps.redis.get(enrollKey(userId));
      if (!raw) throw expired();
      const encrypted = JSON.parse(raw) as EncryptedSecret;
      const step = verifyTotp(deps.secrets.decrypt(encrypted, context(userId)), code);
      if (step === null) throw invalidCode();
      await deps.redis.del(enrollKey(userId));
      const codes = await enable(userId, encrypted, step);
      await deps.audit.record(
        {
          actorType: 'ADMIN',
          actorId: userId,
          action: 'auth.mfa_enabled',
          details: { at: 'account' },
        },
        ctx,
      );
      return { recoveryCodes: codes };
    },

    async regenerateRecoveryCodes(userId: string, code: string, ctx: ClientContext) {
      const mfa = await loadMfa(userId);
      if (!mfa) throw AppError.conflict('Two-factor authentication is not on.');
      if (!(await acceptTotp(userId, mfa, code))) throw invalidCode();
      const { codes, hashes } = newRecoveryCodes();
      await UserModel.updateOne({ _id: userId }, { $set: { 'mfa.recoveryCodeHashes': hashes } });
      await deps.audit.record(
        { actorType: 'ADMIN', actorId: userId, action: 'auth.mfa_recovery_codes_regenerated' },
        ctx,
      );
      return { recoveryCodes: codes };
    },

    async disable(userId: string, roles: readonly AdminRole[], code: string, ctx: ClientContext) {
      if (mfaRequiredFor(roles, deps.policy)) {
        throw AppError.forbidden('Two-factor authentication is required for your role.');
      }
      const mfa = await loadMfa(userId);
      if (!mfa) return;
      if (!(await acceptTotp(userId, mfa, code))) throw invalidCode();
      await UserModel.updateOne({ _id: userId }, { $unset: { mfa: '' } });
      await deps.audit.record(
        { actorType: 'ADMIN', actorId: userId, action: 'auth.mfa_disabled' },
        ctx,
      );
    },
  };
}

export type MfaService = ReturnType<typeof createMfaService>;

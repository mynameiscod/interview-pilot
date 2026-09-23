import { randomUUID } from 'node:crypto';
import type { AccessTokenIssuer } from '@cbi/auth-core';
import { generateRefreshToken, hashToken, keyedHash } from '@cbi/auth-core';
import { RefreshTokenModel, UserModel } from '@cbi/db';
import type { AdminRole, SessionAudience } from '@cbi/shared-types';
import type { ClientSession, Types } from 'mongoose';
import type { AuditService } from '../../lib/audit.js';
import { AppError } from '../../lib/errors.js';
import type { ClientContext } from '../../lib/request-context.js';
import type { UserStateCache } from './user-state.js';

type RevokeReason = 'LOGOUT' | 'LOGOUT_ALL' | 'REUSE_DETECTED' | 'SUSPENDED' | 'ROLE_CHANGE';

export interface IssuedSession {
  userId: string;
  accessToken: string;
  accessTokenExpiresAt: Date;
  refreshToken: string;
  refreshTokenExpiresAt: Date;
}

export interface SessionSubject {
  id: string;
  tokenVersion: number;
  adminRoles: AdminRole[];
}

export interface SessionServiceOptions {
  tokens: AccessTokenIssuer;
  userState: UserStateCache;
  audit: AuditService;
  hashSecret: string;
  refreshTtlMs: Record<SessionAudience, number>;
  /**
   * A just-rotated token presented again within this window (e.g. two tabs
   * refreshing at once, or a response lost in transit) is rejected without
   * revoking the family. Outside it, reuse means theft.
   */
  reuseGraceMs?: number;
}

export function createSessionService(opts: SessionServiceOptions) {
  const reuseGraceMs = opts.reuseGraceMs ?? 10_000;

  async function createRefreshRow(
    subject: SessionSubject,
    audience: SessionAudience,
    familyId: string,
    ctx: ClientContext,
    parentId?: Types.ObjectId,
  ) {
    const refreshToken = generateRefreshToken();
    const refreshTokenExpiresAt = new Date(Date.now() + opts.refreshTtlMs[audience]);
    await RefreshTokenModel.create({
      userId: subject.id,
      familyId,
      tokenHash: hashToken(refreshToken),
      audience,
      parentId,
      expiresAt: refreshTokenExpiresAt,
      userAgent: ctx.userAgent,
      ipHash: keyedHash(opts.hashSecret, `ip:${ctx.ip}`),
    });
    const access = await opts.tokens.sign({
      userId: subject.id,
      audience,
      sessionId: familyId,
      tokenVersion: subject.tokenVersion,
      adminRoles: subject.adminRoles,
    });
    return {
      userId: subject.id,
      accessToken: access.token,
      accessTokenExpiresAt: access.expiresAt,
      refreshToken,
      refreshTokenExpiresAt,
    };
  }

  async function revokeFamily(familyId: string, reason: RevokeReason) {
    await RefreshTokenModel.updateMany(
      { familyId, revokedAt: { $exists: false } },
      { $set: { revokedAt: new Date(), revokedReason: reason } },
    );
  }

  return {
    /** Starts a new session (new refresh-token family) after a successful login. */
    issue(subject: SessionSubject, audience: SessionAudience, ctx: ClientContext) {
      return createRefreshRow(subject, audience, randomUUID(), ctx);
    },

    /** Exchanges a refresh token for a new access token and a new refresh token. */
    async rotate(
      rawToken: string,
      audience: SessionAudience,
      ctx: ClientContext,
    ): Promise<IssuedSession> {
      const tokenHash = hashToken(rawToken);
      const now = new Date();
      // Atomic claim: only one concurrent request can rotate a given token.
      const row = await RefreshTokenModel.findOneAndUpdate(
        {
          tokenHash,
          audience,
          usedAt: { $exists: false },
          revokedAt: { $exists: false },
          expiresAt: { $gt: now },
        },
        { $set: { usedAt: now } },
        { new: true },
      ).lean();

      if (!row) {
        const existing = await RefreshTokenModel.findOne({ tokenHash, audience }).lean();
        if (
          existing?.usedAt &&
          !existing.revokedAt &&
          now.getTime() - existing.usedAt.getTime() > reuseGraceMs
        ) {
          await revokeFamily(existing.familyId, 'REUSE_DETECTED');
          await opts.audit.record(
            {
              actorType: 'USER',
              actorId: String(existing.userId),
              action: 'auth.refresh_token_reuse_detected',
              outcome: 'FAILURE',
              details: { audience, familyId: existing.familyId },
            },
            ctx,
          );
        }
        throw AppError.unauthenticated('Your session has ended. Please sign in again.');
      }

      const userId = String(row.userId);
      const state = await opts.userState.get(userId);
      if (!state || state.status !== 'ACTIVE') {
        await revokeFamily(row.familyId, 'SUSPENDED');
        throw new AppError(403, 'ACCOUNT_SUSPENDED', 'This account is suspended.');
      }
      if (audience === 'admin' && state.adminRoles.length === 0) {
        await revokeFamily(row.familyId, 'ROLE_CHANGE');
        throw AppError.forbidden('Admin access has been removed from this account.');
      }

      return createRefreshRow(
        { id: userId, tokenVersion: state.tokenVersion, adminRoles: state.adminRoles },
        audience,
        row.familyId,
        ctx,
        row._id,
      );
    },

    /** Ends the session the refresh token belongs to (this device only). */
    async revokeByToken(rawToken: string, audience: SessionAudience): Promise<string | null> {
      const row = await RefreshTokenModel.findOne({
        tokenHash: hashToken(rawToken),
        audience,
      }).lean();
      if (!row) return null;
      await revokeFamily(row.familyId, 'LOGOUT');
      return String(row.userId);
    },

    /**
     * Ends every session for the user. Bumping tokenVersion also invalidates
     * access tokens that have not yet expired.
     */
    async revokeAll(
      userId: string,
      reason: RevokeReason,
      opts2: { audience?: SessionAudience; session?: ClientSession } = {},
    ) {
      await RefreshTokenModel.updateMany(
        {
          userId,
          revokedAt: { $exists: false },
          ...(opts2.audience ? { audience: opts2.audience } : {}),
        },
        { $set: { revokedAt: new Date(), revokedReason: reason } },
        opts2.session ? { session: opts2.session } : {},
      );
      if (!opts2.audience) {
        await UserModel.updateOne(
          { _id: userId },
          { $inc: { tokenVersion: 1 } },
          opts2.session ? { session: opts2.session } : {},
        );
      }
      await opts.userState.invalidate(userId);
    },
  };
}

export type SessionService = ReturnType<typeof createSessionService>;

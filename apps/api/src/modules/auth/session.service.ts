import { randomUUID } from 'node:crypto';
import type { AccessTokenIssuer } from '@cbi/auth-core';
import { generateRefreshToken, hashToken, keyedHash } from '@cbi/auth-core';
import { RefreshTokenModel, UserModel } from '@cbi/db';
import type { ActiveSession, AdminRole, SessionAudience } from '@cbi/shared-types';
import type { ClientSession, Types } from 'mongoose';
import type { AuditService } from '../../lib/audit.js';
import { AppError } from '../../lib/errors.js';
import type { ClientContext } from '../../lib/request-context.js';
import type { UserStateCache } from './user-state.js';

type RevokeReason =
  | 'LOGOUT'
  | 'LOGOUT_ALL'
  | 'REUSE_DETECTED'
  | 'SUSPENDED'
  | 'ROLE_CHANGE'
  | 'DEVICE_REVOKED'
  | 'ACCOUNT_DELETION';

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
   * Absolute lifetime of a session (refresh-token family), measured from
   * sign-in. Rotation extends a token's expiry by `refreshTtlMs` but never
   * past this cap, so a stolen-but-active refresh chain cannot live forever.
   */
  maxAgeMs: Record<SessionAudience, number>;
  /**
   * A just-rotated token presented again within this window (e.g. two tabs
   * refreshing at once, or a response lost in transit) is rejected without
   * revoking the family. Outside it, reuse means theft.
   */
  reuseGraceMs?: number;
}

/** Expiry of a newly issued refresh token: the sliding TTL, capped by the family's absolute age. */
export function refreshExpiry(
  now: Date,
  ttlMs: number,
  familyCreatedAt: Date,
  maxAgeMs: number,
): Date {
  return new Date(Math.min(now.getTime() + ttlMs, familyCreatedAt.getTime() + maxAgeMs));
}

export function createSessionService(opts: SessionServiceOptions) {
  const reuseGraceMs = opts.reuseGraceMs ?? 10_000;

  async function createRefreshRow(
    subject: SessionSubject,
    audience: SessionAudience,
    familyId: string,
    ctx: ClientContext,
    parentId?: Types.ObjectId,
    familyCreatedAt: Date = new Date(),
  ) {
    const refreshToken = generateRefreshToken();
    const refreshTokenExpiresAt = refreshExpiry(
      new Date(),
      opts.refreshTtlMs[audience],
      familyCreatedAt,
      opts.maxAgeMs[audience],
    );
    await RefreshTokenModel.create({
      userId: subject.id,
      familyId,
      tokenHash: hashToken(refreshToken),
      audience,
      parentId,
      expiresAt: refreshTokenExpiresAt,
      familyCreatedAt,
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
        { returnDocument: 'after' },
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
      if (audience === 'org' && (!state.org || state.org.orgStatus !== 'ACTIVE')) {
        await revokeFamily(row.familyId, 'ROLE_CHANGE');
        throw AppError.forbidden('Organisation access has been removed from this account.');
      }

      // Rows written before the absolute cap existed start their cap now.
      const familyCreatedAt = row.familyCreatedAt ?? row.createdAt ?? now;
      if (familyCreatedAt.getTime() + opts.maxAgeMs[audience] <= now.getTime()) {
        await revokeFamily(row.familyId, 'LOGOUT');
        throw AppError.unauthenticated('Your session has ended. Please sign in again.');
      }
      return createRefreshRow(
        { id: userId, tokenVersion: state.tokenVersion, adminRoles: state.adminRoles },
        audience,
        row.familyId,
        ctx,
        row._id,
        familyCreatedAt,
      );
    },

    /**
     * The person's signed-in devices for one app: each family's current
     * (unused, unrevoked, unexpired) token.
     */
    async list(
      userId: string,
      audience: SessionAudience,
      currentFamilyId: string,
    ): Promise<ActiveSession[]> {
      const rows = await RefreshTokenModel.find({
        userId,
        audience,
        usedAt: { $exists: false },
        revokedAt: { $exists: false },
        expiresAt: { $gt: new Date() },
      })
        .sort({ createdAt: -1 })
        .limit(50)
        .lean();
      const seen = new Set<string>();
      return rows.flatMap((r) => {
        if (seen.has(r.familyId)) return [];
        seen.add(r.familyId);
        return [
          {
            id: r.familyId,
            userAgent: r.userAgent ?? null,
            signedInAt: (r.familyCreatedAt ?? r.createdAt).toISOString(),
            lastActiveAt: r.createdAt.toISOString(),
            expiresAt: r.expiresAt.toISOString(),
            current: r.familyId === currentFamilyId,
          },
        ];
      });
    },

    /**
     * Signs one of the person's devices out. Its access token (at most a few
     * minutes old) expires on its own; it can no longer refresh.
     */
    async revokeFamilyOf(userId: string, audience: SessionAudience, familyId: string) {
      const res = await RefreshTokenModel.updateMany(
        { userId, audience, familyId, revokedAt: { $exists: false } },
        { $set: { revokedAt: new Date(), revokedReason: 'DEVICE_REVOKED' } },
      );
      return res.modifiedCount > 0;
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

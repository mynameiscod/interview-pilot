import { AdminRole, SessionAudience } from '@cbi/shared-types';
import { errors, jwtVerify, SignJWT } from 'jose';
import { z } from 'zod';

export interface AccessTokenClaims {
  userId: string;
  audience: SessionAudience;
  /** Refresh-token family this access token belongs to (one per signed-in device). */
  sessionId: string;
  /** Must equal the user's current tokenVersion; bumped by logout-all and suspension. */
  tokenVersion: number;
  adminRoles: AdminRole[];
}

export interface AccessTokenIssuerOptions {
  /** HMAC secret, at least 32 bytes. */
  secret: string;
  ttlSec: number;
  issuer?: string;
}

export class AccessTokenError extends Error {
  constructor(public readonly reason: 'expired' | 'invalid') {
    super(`Access token ${reason}`);
    this.name = 'AccessTokenError';
  }
}

const PayloadSchema = z.object({
  sub: z.string().min(1),
  aud: SessionAudience,
  sid: z.string().min(1),
  tv: z.number().int().nonnegative(),
  roles: z.array(AdminRole).default([]),
});

/**
 * Short-lived HS256 access tokens. Audience separates candidate and admin
 * sessions so a candidate token can never call admin endpoints.
 */
export function createAccessTokenIssuer(opts: AccessTokenIssuerOptions) {
  if (Buffer.byteLength(opts.secret) < 32) {
    throw new Error('Access token secret must be at least 32 bytes');
  }
  const key = new TextEncoder().encode(opts.secret);
  const issuer = opts.issuer ?? 'cbi-api';

  async function sign(claims: AccessTokenClaims, now = new Date()) {
    const iat = Math.floor(now.getTime() / 1000);
    const exp = iat + opts.ttlSec;
    const token = await new SignJWT({
      sid: claims.sessionId,
      tv: claims.tokenVersion,
      // Plain copy: callers may pass framework arrays (e.g. Mongoose) that cannot be cloned.
      roles: [...claims.adminRoles],
    })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setSubject(claims.userId)
      .setAudience(claims.audience)
      .setIssuer(issuer)
      .setIssuedAt(iat)
      .setExpirationTime(exp)
      .sign(key);
    return { token, expiresAt: new Date(exp * 1000) };
  }

  async function verify(token: string, audience: SessionAudience): Promise<AccessTokenClaims> {
    try {
      const { payload } = await jwtVerify(token, key, {
        issuer,
        audience,
        algorithms: ['HS256'],
      });
      const parsed = PayloadSchema.parse(payload);
      return {
        userId: parsed.sub,
        audience: parsed.aud,
        sessionId: parsed.sid,
        tokenVersion: parsed.tv,
        adminRoles: parsed.roles,
      };
    } catch (err) {
      throw new AccessTokenError(err instanceof errors.JWTExpired ? 'expired' : 'invalid');
    }
  }

  return { sign, verify, ttlSec: opts.ttlSec };
}

export type AccessTokenIssuer = ReturnType<typeof createAccessTokenIssuer>;

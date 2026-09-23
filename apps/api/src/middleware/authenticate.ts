import type { AccessTokenIssuer } from '@cbi/auth-core';
import { AccessTokenError } from '@cbi/auth-core';
import {
  CSRF_HEADER,
  hasPermission,
  type Permission,
  type SessionAudience,
} from '@cbi/shared-types';
import type { Request, RequestHandler } from 'express';
import { AppError } from '../lib/errors.js';
import type { UserStateCache } from '../modules/auth/user-state.js';
import type { AuthContext } from '../types/express.js';

/**
 * Requires a valid Bearer access token for `audience`, then checks the live
 * user state: token version (logout-all), status (suspension) and, for admin,
 * that admin roles still exist.
 */
export function authenticate(
  audience: SessionAudience,
  deps: { tokens: AccessTokenIssuer; userState: UserStateCache },
): RequestHandler {
  return async (req, _res, next) => {
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) throw AppError.unauthenticated();
    let claims;
    try {
      claims = await deps.tokens.verify(header.slice(7), audience);
    } catch (err) {
      const expired = err instanceof AccessTokenError && err.reason === 'expired';
      throw AppError.unauthenticated(
        expired ? 'Your session has expired.' : 'Please sign in to continue',
      );
    }
    const state = await deps.userState.get(claims.userId);
    if (!state || state.tokenVersion !== claims.tokenVersion) {
      throw AppError.unauthenticated('Your session has ended. Please sign in again.');
    }
    if (state.status !== 'ACTIVE') {
      throw new AppError(403, 'ACCOUNT_SUSPENDED', 'This account is suspended.');
    }
    if (audience === 'admin' && state.adminRoles.length === 0) {
      throw AppError.forbidden('This account does not have admin access.');
    }
    req.auth = {
      userId: claims.userId,
      audience,
      sessionId: claims.sessionId,
      adminRoles: state.adminRoles,
    };
    next();
  };
}

/** Narrowing helper for handlers mounted behind `authenticate`. */
export function requireAuth(req: Request): AuthContext {
  if (!req.auth) throw AppError.unauthenticated();
  return req.auth;
}

export function requirePermission(permission: Permission): RequestHandler {
  return (req, _res, next) => {
    const auth = requireAuth(req);
    if (auth.audience !== 'admin' || !hasPermission(auth.adminRoles, permission)) {
      throw AppError.forbidden();
    }
    next();
  };
}

/**
 * Cookie-authenticated endpoints (refresh, logout) require a custom header.
 * Browsers only send it from JavaScript, which triggers a CORS preflight that
 * the origin guard rejects for foreign sites.
 */
export const requireCsrfHeader: RequestHandler = (req, _res, next) => {
  if (req.get(CSRF_HEADER) !== '1') {
    throw new AppError(403, 'CSRF_REJECTED', 'Request rejected.');
  }
  next();
};

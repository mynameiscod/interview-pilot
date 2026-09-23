import { normalizeEmail } from '@cbi/auth-core';
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';
import { AppError } from '../../lib/errors.js';

export interface GoogleIdentityClaims {
  sub: string;
  /** Normalized, and always verified by Google (unverified emails are rejected). */
  email: string;
  name?: string;
}

export type GoogleVerifier = (idToken: string) => Promise<GoogleIdentityClaims>;

const GOOGLE_ISSUERS = ['https://accounts.google.com', 'accounts.google.com'];
const GOOGLE_JWKS_URL = new URL('https://www.googleapis.com/oauth2/v3/certs');

/**
 * Verifies a Google Identity Services ID token: signature against Google's
 * published keys (cached by jose), issuer, audience (our client id), expiry,
 * and that Google has verified the email address.
 */
export function createGoogleVerifier(opts: {
  clientId: string;
  /** Injected in tests; defaults to Google's JWKS endpoint. */
  keySet?: JWTVerifyGetKey;
}): GoogleVerifier {
  const keySet = opts.keySet ?? createRemoteJWKSet(GOOGLE_JWKS_URL);
  return async (idToken) => {
    let payload: Record<string, unknown>;
    try {
      ({ payload } = await jwtVerify(idToken, keySet, {
        issuer: GOOGLE_ISSUERS,
        audience: opts.clientId,
        algorithms: ['RS256'],
        clockTolerance: 30,
      }));
    } catch {
      throw AppError.unauthenticated('Google sign-in could not be verified. Please try again.');
    }
    const email = typeof payload.email === 'string' ? normalizeEmail(payload.email) : null;
    if (typeof payload.sub !== 'string' || !email || payload.email_verified !== true) {
      throw AppError.unauthenticated('Your Google account email is not verified.');
    }
    return {
      sub: payload.sub,
      email,
      name: typeof payload.name === 'string' ? payload.name : undefined,
    };
  };
}

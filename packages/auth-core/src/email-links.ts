import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Signed links in emails that act without signing in (unsubscribe). A token
 * names the user, the purpose and when it was issued, and carries an
 * HMAC-SHA256 over them. The key is derived from a server secret the API and
 * the worker share, separated by a label so it signs nothing else.
 */

export type EmailLinkPurpose = 'unsubscribe';

/** Links older than this are refused (a newer email carries a fresh one). */
export const EMAIL_LINK_MAX_AGE_MS = 400 * 24 * 3600 * 1000;

export function emailLinkKey(secret: string | Buffer): Buffer {
  return createHmac('sha256', secret).update('cbi:email-links:v1').digest();
}

const sign = (key: Buffer, body: string) =>
  createHmac('sha256', key).update(body).digest('base64url');

export function signEmailLink(
  key: Buffer,
  input: { userId: string; purpose: EmailLinkPurpose; issuedAt?: Date },
): string {
  const issuedAt = Math.floor((input.issuedAt ?? new Date()).getTime() / 1000);
  const body = Buffer.from(
    JSON.stringify({ u: input.userId, p: input.purpose, t: issuedAt }),
  ).toString('base64url');
  return `${body}.${sign(key, body)}`;
}

/** The user a valid, unexpired token for `purpose` names; null for anything else. */
export function verifyEmailLink(
  key: Buffer,
  token: string,
  purpose: EmailLinkPurpose,
  now = new Date(),
): { userId: string; issuedAt: Date } | null {
  const [body, signature, extra] = token.split('.');
  if (!body || !signature || extra !== undefined) return null;
  const expected = Buffer.from(sign(key, body));
  const given = Buffer.from(signature);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  try {
    const claims = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as {
      u?: unknown;
      p?: unknown;
      t?: unknown;
    };
    if (typeof claims.u !== 'string' || claims.p !== purpose || typeof claims.t !== 'number') {
      return null;
    }
    const issuedAt = new Date(claims.t * 1000);
    const age = now.getTime() - issuedAt.getTime();
    // A little clock skew between the worker that signed it and the API is fine.
    if (age > EMAIL_LINK_MAX_AGE_MS || age < -5 * 60_000) return null;
    return { userId: claims.u, issuedAt };
  } catch {
    return null;
  }
}

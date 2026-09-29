import { describe, expect, it } from 'vitest';
import {
  EMAIL_LINK_MAX_AGE_MS,
  emailLinkKey,
  signEmailLink,
  verifyEmailLink,
} from './email-links.js';

const key = emailLinkKey('server-secret-for-tests');
const userId = '64b7f0c2a1b2c3d4e5f60718';
const issuedAt = new Date('2026-09-29T10:00:00Z');

describe('email links', () => {
  it('round-trips the user for its purpose', () => {
    const token = signEmailLink(key, { userId, purpose: 'unsubscribe', issuedAt });
    expect(verifyEmailLink(key, token, 'unsubscribe', issuedAt)).toEqual({ userId, issuedAt });
  });

  it('refuses tampered, foreign-key and malformed tokens', () => {
    const token = signEmailLink(key, { userId, purpose: 'unsubscribe', issuedAt });
    const [body, sig] = token.split('.');
    const forged = Buffer.from(
      JSON.stringify({ u: '000000000000000000000000', p: 'unsubscribe', t: 1 }),
    ).toString('base64url');
    expect(verifyEmailLink(key, `${forged}.${sig}`, 'unsubscribe', issuedAt)).toBeNull();
    expect(verifyEmailLink(key, `${body}.${sig}x`, 'unsubscribe', issuedAt)).toBeNull();
    expect(verifyEmailLink(emailLinkKey('other'), token, 'unsubscribe', issuedAt)).toBeNull();
    expect(verifyEmailLink(key, 'nonsense', 'unsubscribe', issuedAt)).toBeNull();
    expect(verifyEmailLink(key, `${token}.extra`, 'unsubscribe', issuedAt)).toBeNull();
  });

  it('expires old links', () => {
    const token = signEmailLink(key, { userId, purpose: 'unsubscribe', issuedAt });
    const later = new Date(issuedAt.getTime() + EMAIL_LINK_MAX_AGE_MS + 1000);
    expect(verifyEmailLink(key, token, 'unsubscribe', later)).toBeNull();
  });

  it('derives different keys from different secrets', () => {
    expect(emailLinkKey('a').equals(emailLinkKey('b'))).toBe(false);
  });
});

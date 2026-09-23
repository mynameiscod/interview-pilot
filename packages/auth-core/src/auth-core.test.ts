import { describe, expect, it } from 'vitest';
import { AccessTokenError, createAccessTokenIssuer } from './access-token.js';
import { maskEmail, maskMobile, normalizeEmail, normalizeMobile } from './identity.js';
import {
  generateOtp,
  generateRefreshToken,
  hashOtp,
  hashToken,
  keyedHash,
  verifyOtp,
} from './secrets.js';

const SECRET = 'test-secret-that-is-at-least-32-bytes-long!!';

describe('access tokens', () => {
  const issuer = createAccessTokenIssuer({ secret: SECRET, ttlSec: 600 });
  const claims = {
    userId: 'u1',
    audience: 'candidate' as const,
    sessionId: 'fam1',
    tokenVersion: 3,
    adminRoles: [],
  };

  it('round-trips claims', async () => {
    const { token, expiresAt } = await issuer.sign(claims);
    expect(expiresAt.getTime()).toBeGreaterThan(Date.now());
    await expect(issuer.verify(token, 'candidate')).resolves.toEqual(claims);
  });

  it('rejects a token presented to the other audience', async () => {
    const { token } = await issuer.sign(claims);
    await expect(issuer.verify(token, 'admin')).rejects.toMatchObject({ reason: 'invalid' });
  });

  it('reports expiry distinctly', async () => {
    const { token } = await issuer.sign(claims, new Date(Date.now() - 3600_000));
    await expect(issuer.verify(token, 'candidate')).rejects.toMatchObject({ reason: 'expired' });
  });

  it('rejects tokens signed with another secret', async () => {
    const other = createAccessTokenIssuer({ secret: `${SECRET}-other`, ttlSec: 600 });
    const { token } = await other.sign(claims);
    await expect(issuer.verify(token, 'candidate')).rejects.toBeInstanceOf(AccessTokenError);
  });

  it('rejects tampered tokens', async () => {
    const { token } = await issuer.sign(claims);
    const [h, p, s] = token.split('.');
    const forged = JSON.parse(Buffer.from(p!, 'base64url').toString());
    forged.roles = ['SUPER_ADMIN'];
    const tampered = `${h}.${Buffer.from(JSON.stringify(forged)).toString('base64url')}.${s}`;
    await expect(issuer.verify(tampered, 'candidate')).rejects.toMatchObject({ reason: 'invalid' });
  });

  it('refuses short secrets', () => {
    expect(() => createAccessTokenIssuer({ secret: 'short', ttlSec: 60 })).toThrow(/32 bytes/);
  });
});

describe('OTP and token secrets', () => {
  it('generates 6-digit numeric codes', () => {
    for (let i = 0; i < 200; i++) expect(generateOtp()).toMatch(/^\d{6}$/);
  });

  it('verifies only the right code for the right challenge', () => {
    const hash = hashOtp(SECRET, 'ch1', '123456');
    expect(verifyOtp(SECRET, 'ch1', '123456', hash)).toBe(true);
    expect(verifyOtp(SECRET, 'ch1', '123457', hash)).toBe(false);
    expect(verifyOtp(SECRET, 'ch2', '123456', hash)).toBe(false);
    expect(verifyOtp('another-secret', 'ch1', '123456', hash)).toBe(false);
  });

  it('never stores the OTP in clear', () => {
    expect(hashOtp(SECRET, 'ch1', '123456')).not.toContain('123456');
  });

  it('generates unique high-entropy refresh tokens and stable hashes', () => {
    const a = generateRefreshToken();
    const b = generateRefreshToken();
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThanOrEqual(43);
    expect(hashToken(a)).toBe(hashToken(a));
    expect(hashToken(a)).not.toBe(a);
    expect(keyedHash(SECRET, 'x')).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('identity normalization', () => {
  it('normalizes emails', () => {
    expect(normalizeEmail('  Asha.K@Gmail.COM ')).toBe('asha.k@gmail.com');
    expect(normalizeEmail('not-an-email')).toBeNull();
  });

  it('normalizes Indian and international mobiles to E.164', () => {
    expect(normalizeMobile('98765 43210')).toBe('+919876543210');
    expect(normalizeMobile('+91 98765-43210')).toBe('+919876543210');
    expect(normalizeMobile('+1 415 555 2671')).toBe('+14155552671');
    expect(normalizeMobile('12345')).toBeNull();
  });

  it('masks identities for display', () => {
    expect(maskEmail('asha.k@gmail.com')).toBe('a***k@gmail.com');
    expect(maskEmail('ab@x.io')).toBe('a***@x.io');
    expect(maskMobile('+919876543210')).toBe('+91 ******3210');
  });
});

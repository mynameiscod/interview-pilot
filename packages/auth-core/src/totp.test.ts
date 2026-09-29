import { describe, expect, it } from 'vitest';
import {
  base32Decode,
  base32Encode,
  findRecoveryCode,
  generateRecoveryCodes,
  generateTotpSecret,
  hashRecoveryCode,
  hotp,
  otpauthUri,
  totpCode,
  totpStep,
  verifyTotp,
} from './totp.js';

// RFC 6238 Appendix B test secret (ASCII "12345678901234567890").
const RFC_SECRET = base32Encode(Buffer.from('12345678901234567890'));

describe('TOTP (RFC 6238)', () => {
  it('matches the RFC 4226 HOTP vectors', () => {
    const secret = Buffer.from('12345678901234567890');
    expect(hotp(secret, 0)).toBe('755224');
    expect(hotp(secret, 1)).toBe('287082');
    expect(hotp(secret, 9)).toBe('520489');
  });

  it('matches the RFC 6238 SHA-1 vectors (8 digits)', () => {
    expect(totpCode(RFC_SECRET, 59_000, 8)).toBe('94287082');
    expect(totpCode(RFC_SECRET, 1_111_111_109_000, 8)).toBe('07081804');
    expect(totpCode(RFC_SECRET, 1_234_567_890_000, 8)).toBe('89005924');
    expect(totpCode(RFC_SECRET, 20_000_000_000_000, 8)).toBe('65353130');
  });

  it('round-trips base32', () => {
    const bytes = Buffer.from([0, 1, 2, 250, 251, 252, 253, 254, 255, 9]);
    expect(base32Decode(base32Encode(bytes))).toEqual(bytes);
    expect(generateTotpSecret()).toMatch(/^[A-Z2-7]{32}$/);
  });

  it('accepts one step of clock drift but not two', () => {
    const at = 1_700_000_000_000;
    const secret = generateTotpSecret();
    expect(verifyTotp(secret, totpCode(secret, at), { atMs: at })).toBe(totpStep(at));
    expect(verifyTotp(secret, totpCode(secret, at - 30_000), { atMs: at })).not.toBeNull();
    expect(verifyTotp(secret, totpCode(secret, at + 30_000), { atMs: at })).not.toBeNull();
    expect(verifyTotp(secret, totpCode(secret, at - 90_000), { atMs: at })).toBeNull();
    expect(verifyTotp(secret, 'abcdef', { atMs: at })).toBeNull();
  });

  it('refuses a code from a step already used (replay)', () => {
    const at = 1_700_000_000_000;
    const secret = generateTotpSecret();
    const code = totpCode(secret, at);
    const step = verifyTotp(secret, code, { atMs: at });
    expect(step).not.toBeNull();
    expect(verifyTotp(secret, code, { atMs: at, afterStep: step })).toBeNull();
  });

  it('builds an otpauth URI for authenticator apps', () => {
    const uri = otpauthUri({ issuer: 'CareerPilot', account: 'ops@example.com', secret: 'ABC' });
    expect(uri).toMatch(/^otpauth:\/\/totp\/CareerPilot%3Aops%40example\.com\?/);
    expect(uri).toContain('secret=ABC');
    expect(uri).toContain('issuer=CareerPilot');
    expect(uri).toContain('period=30');
  });
});

describe('recovery codes', () => {
  it('are unique, readable and matched after normalisation', () => {
    const codes = generateRecoveryCodes(10);
    expect(new Set(codes).size).toBe(10);
    for (const code of codes) expect(code).toMatch(/^[a-z2-9]{4}-[a-z2-9]{4}-[a-z2-9]{2}$/);
    const hashes = codes.map((c) => hashRecoveryCode('server-secret', c));
    expect(findRecoveryCode('server-secret', codes[3]!.toUpperCase(), hashes)).toBe(3);
    expect(findRecoveryCode('server-secret', codes[3]!.replace(/-/g, ' '), hashes)).toBe(3);
    expect(findRecoveryCode('other-secret', codes[3]!, hashes)).toBe(-1);
    expect(findRecoveryCode('server-secret', 'zzzz-zzzz-zz', hashes)).toBe(-1);
  });
});

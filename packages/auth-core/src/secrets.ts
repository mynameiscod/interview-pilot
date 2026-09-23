import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { OTP_LENGTH } from '@cbi/shared-types';

/** Uniformly random numeric OTP (no modulo bias; leading zeros allowed). */
export function generateOtp(length = OTP_LENGTH): string {
  let code = '';
  for (let i = 0; i < length; i++) code += randomInt(0, 10).toString();
  return code;
}

/**
 * OTPs are stored only as HMACs bound to their challenge id, so a leaked
 * database row cannot be replayed against another challenge and the 10^6
 * space cannot be brute-forced offline without the server secret.
 */
export function hashOtp(secret: string, challengeId: string, code: string): string {
  return createHmac('sha256', secret).update(`${challengeId}:${code}`).digest('hex');
}

export function verifyOtp(
  secret: string,
  challengeId: string,
  code: string,
  expectedHash: string,
): boolean {
  const actual = Buffer.from(hashOtp(secret, challengeId, code), 'hex');
  const expected = Buffer.from(expectedHash, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** Opaque refresh token: 256 bits of randomness, URL-safe. Only its hash is stored. */
export function generateRefreshToken(): string {
  return randomBytes(32).toString('base64url');
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Keyed hash for values we must look up but should not store in clear (e.g. OTP destinations). */
export function keyedHash(secret: string, value: string): string {
  return createHmac('sha256', secret).update(value).digest('hex');
}

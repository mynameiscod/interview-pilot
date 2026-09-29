import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';

/**
 * Time-based one-time passwords (RFC 6238, HMAC-SHA1, 30-second steps,
 * 6 digits) as used by Google Authenticator, Microsoft Authenticator, 1Password
 * and others. Implemented on node:crypto so no dependency handles the secret.
 */

export const TOTP_STEP_SEC = 30;
const DIGITS = 6;
const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(bytes: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(input: string): Buffer {
  const clean = input.toUpperCase().replace(/[\s=-]/g, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of clean) {
    const index = BASE32.indexOf(char);
    if (index < 0) throw new Error('invalid base32');
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** A new 160-bit secret, base32-encoded (the form authenticator apps expect). */
export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

/** The time step (counter) for a moment. */
export const totpStep = (atMs: number) => Math.floor(atMs / 1000 / TOTP_STEP_SEC);

/** HOTP (RFC 4226) for a counter; TOTP uses the time step as the counter. */
export function hotp(secret: Buffer, counter: number, digits = DIGITS): string {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac('sha1', secret).update(message).digest();
  const offset = mac[mac.length - 1]! & 0x0f;
  const binary = (mac.readUInt32BE(offset) & 0x7fffffff) % 10 ** digits;
  return binary.toString().padStart(digits, '0');
}

export function totpCode(base32Secret: string, atMs = Date.now(), digits = DIGITS): string {
  return hotp(base32Decode(base32Secret), totpStep(atMs), digits);
}

/**
 * Checks a code against the current step and `window` steps either side
 * (clock drift). Returns the matching step so callers can refuse replays of
 * the same or an earlier step (`afterStep`), or null.
 */
export function verifyTotp(
  base32Secret: string,
  code: string,
  opts: { atMs?: number; window?: number; afterStep?: number | null } = {},
): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const secret = base32Decode(base32Secret);
  const now = totpStep(opts.atMs ?? Date.now());
  const window = opts.window ?? 1;
  const given = Buffer.from(code);
  let matched: number | null = null;
  // Check every candidate step (constant work regardless of which matches).
  for (let step = now - window; step <= now + window; step++) {
    const expected = Buffer.from(hotp(secret, step));
    if (timingSafeEqual(expected, given) && matched === null) matched = step;
  }
  if (matched === null) return null;
  if (opts.afterStep !== undefined && opts.afterStep !== null && matched <= opts.afterStep) {
    return null;
  }
  return matched;
}

/** otpauth:// URI for QR codes and manual entry in authenticator apps. */
export function otpauthUri(opts: { issuer: string; account: string; secret: string }): string {
  const label = encodeURIComponent(`${opts.issuer}:${opts.account}`);
  const params = new URLSearchParams({
    secret: opts.secret,
    issuer: opts.issuer,
    algorithm: 'SHA1',
    digits: String(DIGITS),
    period: String(TOTP_STEP_SEC),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

const RECOVERY_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';

/** Single-use recovery codes like `k7mq-x2pd-9t`, easy to read aloud and type. */
export function generateRecoveryCodes(count = 10): string[] {
  return Array.from({ length: count }, () => {
    let raw = '';
    for (let i = 0; i < 10; i++) raw += RECOVERY_ALPHABET[randomInt(RECOVERY_ALPHABET.length)];
    return `${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8)}`;
  });
}

/** Recovery codes are stored only as keyed hashes; input is normalised (case, dashes, spaces). */
export function hashRecoveryCode(secret: string, code: string): string {
  const normalised = code.toLowerCase().replace(/[^a-z0-9]/g, '');
  return createHmac('sha256', secret).update(`recovery:${normalised}`).digest('hex');
}

/** Index of the matching stored hash, or -1. */
export function findRecoveryCode(secret: string, code: string, hashes: readonly string[]): number {
  const given = Buffer.from(hashRecoveryCode(secret, code), 'hex');
  let found = -1;
  hashes.forEach((stored, index) => {
    const expected = Buffer.from(stored, 'hex');
    if (expected.length === given.length && timingSafeEqual(expected, given) && found < 0) {
      found = index;
    }
  });
  return found;
}

/** Short fingerprint for audit details (never the secret itself). */
export const secretFingerprint = (secret: string) =>
  createHash('sha256').update(secret).digest('hex').slice(0, 8);

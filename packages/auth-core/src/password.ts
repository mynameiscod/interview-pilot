import { randomBytes, scrypt as scryptCb, timingSafeEqual, type ScryptOptions } from 'node:crypto';

/**
 * Admin passwords: scrypt (memory-hard, built into Node) with a random 16-byte
 * salt. Stored as `scrypt$N$r$p$saltB64$hashB64`, so the cost can be raised
 * later without breaking existing hashes.
 */

const N = 2 ** 15;
const R = 8;
const P = 1;
const KEY_BYTES = 32;
// scrypt needs 128 * N * r bytes; allow headroom above Node's 32 MB default.
const MAXMEM = 64 * 1024 * 1024;

export const ADMIN_PASSWORD_MIN_LENGTH = 12;

function scrypt(password: string, salt: Buffer, opts: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    scryptCb(password, salt, KEY_BYTES, opts, (err, key) => (err ? reject(err) : resolve(key))),
  );
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(password.normalize('NFKC'), salt, { N, r: R, p: P, maxmem: MAXMEM });
  return ['scrypt', N, R, P, salt.toString('base64'), key.toString('base64')].join('$');
}

/** Constant-time check; false for any malformed stored value. */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, n, r, p, saltB64, hashB64] = parts as [string, string, string, string, string, string];
  const expected = Buffer.from(hashB64, 'base64');
  if (expected.length !== KEY_BYTES) return false;
  const key = await scrypt(password.normalize('NFKC'), Buffer.from(saltB64, 'base64'), {
    N: Number(n),
    r: Number(r),
    p: Number(p),
    maxmem: MAXMEM,
  });
  return timingSafeEqual(key, expected);
}

/** A fixed hash to verify against when the account does not exist (same timing either way). */
let dummy: Promise<string> | null = null;
export async function verifyAgainstDummy(password: string): Promise<false> {
  dummy ??= hashPassword('not-a-real-password-for-timing');
  await verifyPassword(password, await dummy);
  return false;
}

/** Why a new admin password is not acceptable (null when it is). */
export function passwordProblem(password: string, email?: string | null): string | null {
  if (password.length < ADMIN_PASSWORD_MIN_LENGTH) {
    return `Use at least ${ADMIN_PASSWORD_MIN_LENGTH} characters.`;
  }
  if (password.length > 200) return 'Use at most 200 characters.';
  if (new Set(password).size < 5) return 'Use a less repetitive password.';
  const local = email?.split('@')[0]?.toLowerCase();
  if (local && local.length >= 4 && password.toLowerCase().includes(local)) {
    return 'Do not include your email address.';
  }
  return null;
}

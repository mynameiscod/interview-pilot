import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/** Stored form of a provider credential. Only `last4` is ever returned by the API. */
export interface EncryptedSecret {
  /** base64 */
  ciphertext: string;
  /** base64, 96-bit random nonce */
  iv: string;
  /** base64, 128-bit GCM auth tag */
  tag: string;
  /** Which master key encrypted it (enables rotation). */
  keyId: string;
  last4: string;
}

export class SecretDecryptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SecretDecryptionError';
  }
}

export interface SecretBoxOptions {
  currentKeyId: string;
  /** keyId → 32-byte key. Must contain `currentKeyId`. */
  keys: Record<string, Buffer>;
}

export interface SecretBox {
  readonly currentKeyId: string;
  /** `context` is bound as GCM additional data (e.g. `aiProvider:openai`). */
  encrypt(plaintext: string, context: string): EncryptedSecret;
  decrypt(secret: EncryptedSecret, context: string): string;
  /** True when the secret was encrypted with an older key and should be re-encrypted. */
  needsRotation(secret: EncryptedSecret): boolean;
}

const KEY_BYTES = 32;
const IV_BYTES = 12;

/** Decodes a base64 master key and checks it is exactly 32 bytes. */
export function parseMasterKey(base64: string): Buffer {
  const key = Buffer.from(base64, 'base64');
  if (key.length !== KEY_BYTES || key.toString('base64') !== base64.replace(/\s/g, '')) {
    throw new Error('AI secrets master key must be exactly 32 bytes, base64-encoded');
  }
  return key;
}

/**
 * AES-256-GCM with a fresh 96-bit random IV per encryption. The context
 * string is authenticated, so a ciphertext copied onto another provider's
 * record fails to decrypt. Plaintext is never cached here.
 */
export function createSecretBox(opts: SecretBoxOptions): SecretBox {
  for (const [keyId, key] of Object.entries(opts.keys)) {
    if (key.length !== KEY_BYTES) throw new Error(`AI secrets key ${keyId} must be 32 bytes`);
  }
  const current = opts.keys[opts.currentKeyId];
  if (!current) throw new Error(`AI secrets key ${opts.currentKeyId} is not configured`);

  return {
    currentKeyId: opts.currentKeyId,
    encrypt(plaintext, context) {
      const iv = randomBytes(IV_BYTES);
      const cipher = createCipheriv('aes-256-gcm', current, iv);
      cipher.setAAD(Buffer.from(context, 'utf8'));
      const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
      return {
        ciphertext: ciphertext.toString('base64'),
        iv: iv.toString('base64'),
        tag: cipher.getAuthTag().toString('base64'),
        keyId: opts.currentKeyId,
        last4: plaintext.slice(-4),
      };
    },
    decrypt(secret, context) {
      const key = opts.keys[secret.keyId];
      if (!key) throw new SecretDecryptionError(`unknown key id ${secret.keyId}`);
      try {
        const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(secret.iv, 'base64'));
        decipher.setAAD(Buffer.from(context, 'utf8'));
        decipher.setAuthTag(Buffer.from(secret.tag, 'base64'));
        return Buffer.concat([
          decipher.update(Buffer.from(secret.ciphertext, 'base64')),
          decipher.final(),
        ]).toString('utf8');
      } catch {
        // Never include ciphertext or key material in the message.
        throw new SecretDecryptionError('secret could not be decrypted (wrong key or tampered)');
      }
    },
    needsRotation(secret) {
      return secret.keyId !== opts.currentKeyId;
    },
  };
}

/** Parses `k0:base64,k1:base64` (previous keys kept for decryption during rotation). */
export function parseKeyList(raw: string | undefined): Record<string, Buffer> {
  const keys: Record<string, Buffer> = {};
  for (const item of (raw ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)) {
    const sep = item.indexOf(':');
    if (sep <= 0) throw new Error('AI_SECRETS_PREVIOUS_KEYS entries must look like keyId:base64');
    keys[item.slice(0, sep)] = parseMasterKey(item.slice(sep + 1));
  }
  return keys;
}

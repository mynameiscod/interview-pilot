import type { Readable } from 'node:stream';
import { ProviderError } from '../errors.js';

/**
 * Private object storage. Keys are generated server-side (never from user
 * input) and look like `resumes/<userId>/<id>.pdf`. Documents are small
 * (≤ 25 MB), so buffers are used for them. Large generated files (campaign
 * export packages) use the streaming pair `putFile` / `getStream`, and
 * recordings are played back through `getRange`, so a large object is never
 * held in memory whole.
 */
export interface StorageProvider {
  readonly name: string;
  put(key: string, body: Buffer, contentType: string): Promise<void>;
  /** Throws StorageNotFoundError when the object does not exist. */
  get(key: string): Promise<Buffer>;
  /** Uploads a file from local disk, streaming it. */
  putFile(key: string, filePath: string, contentType: string): Promise<void>;
  /** Streams an object. Throws StorageNotFoundError when it does not exist. */
  getStream(key: string): Promise<Readable>;
  /**
   * Bytes `start` … `end` (inclusive; shorter at the end of the object).
   * Optional: `readRange` falls back to `get` for providers without it.
   */
  getRange?(key: string, start: number, end: number): Promise<Buffer>;
  /** Idempotent: deleting a missing object succeeds. */
  delete(key: string): Promise<void>;
}

export class StorageNotFoundError extends ProviderError {
  constructor(provider: string) {
    super(provider, 'object not found', false);
    this.name = 'StorageNotFoundError';
  }
}

const KEY = /^[a-z0-9][a-z0-9/_.-]{0,500}$/i;

/** Rejects anything that could escape the storage root or zone. */
export function assertStorageKey(key: string): void {
  if (
    !KEY.test(key) ||
    key.split('/').some((part) => part === '' || part === '.' || part === '..')
  ) {
    throw new Error('invalid storage key');
  }
}

/** A byte range of an object, from the provider's range read when it has one. */
export async function readRange(
  storage: Pick<StorageProvider, 'get' | 'getRange'>,
  key: string,
  start: number,
  end: number,
): Promise<Buffer> {
  if (storage.getRange) return storage.getRange(key, start, end);
  return (await storage.get(key)).subarray(start, end + 1);
}

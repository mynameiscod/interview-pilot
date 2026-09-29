import type { Readable } from 'node:stream';
import { ProviderError } from '../errors.js';

/**
 * Private object storage. Keys are generated server-side (never from user
 * input) and look like `resumes/<userId>/<id>.pdf`. Documents are small
 * (≤ 25 MB), so buffers are used for them. Large generated files (campaign
 * export packages) use the streaming pair `putFile` / `getStream`, which never
 * hold the whole object in memory.
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

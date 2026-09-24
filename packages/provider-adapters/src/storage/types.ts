import { ProviderError } from '../errors.js';

/**
 * Private object storage. Keys are generated server-side (never from user
 * input) and look like `resumes/<userId>/<id>.pdf`. Documents are small
 * (≤ 25 MB), so buffers are used; media streaming arrives in Phase 8.
 */
export interface StorageProvider {
  readonly name: string;
  put(key: string, body: Buffer, contentType: string): Promise<void>;
  /** Throws StorageNotFoundError when the object does not exist. */
  get(key: string): Promise<Buffer>;
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

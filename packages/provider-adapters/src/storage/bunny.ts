import { createHash } from 'node:crypto';
import { ProviderError } from '../errors.js';
import { assertStorageKey, StorageNotFoundError, type StorageProvider } from './types.js';

export interface BunnyStorageOptions {
  zone: string;
  /** Storage API password of the zone (not the account API key). */
  accessKey: string;
  /** Region endpoint host, e.g. `storage.bunnycdn.com` or `sg.storage.bunnycdn.com`. */
  regionHost: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/**
 * Bunny Storage HTTP API adapter (private zone). Uploads send a SHA-256
 * `Checksum` so Bunny rejects corrupted bodies. There is no official Node
 * SDK, so this uses fetch directly.
 */
export function createBunnyStorage(opts: BunnyStorageOptions): StorageProvider {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const url = (key: string) => {
    assertStorageKey(key);
    return `https://${opts.regionHost}/${encodeURIComponent(opts.zone)}/${key
      .split('/')
      .map(encodeURIComponent)
      .join('/')}`;
  };

  async function call(method: string, key: string, init: RequestInit = {}): Promise<Response> {
    try {
      return await fetchImpl(url(key), {
        ...init,
        method,
        headers: { AccessKey: opts.accessKey, ...(init.headers as Record<string, string>) },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      if (err instanceof Error && err.message === 'invalid storage key') throw err;
      throw new ProviderError('bunny-storage', `${method} failed (network/timeout)`, true, {
        cause: err,
      });
    }
  }

  const fail = (method: string, res: Response) =>
    new ProviderError(
      'bunny-storage',
      `${method} rejected (HTTP ${res.status})`,
      res.status >= 500 || res.status === 429,
    );

  return {
    name: 'bunny',
    async put(key, body, contentType) {
      const res = await call('PUT', key, {
        body: new Uint8Array(body),
        headers: {
          'Content-Type': contentType,
          Checksum: createHash('sha256').update(body).digest('hex').toUpperCase(),
        },
      });
      if (!res.ok) throw fail('PUT', res);
    },
    async get(key) {
      const res = await call('GET', key);
      if (res.status === 404) throw new StorageNotFoundError('bunny-storage');
      if (!res.ok) throw fail('GET', res);
      return Buffer.from(await res.arrayBuffer());
    },
    async delete(key) {
      const res = await call('DELETE', key);
      if (!res.ok && res.status !== 404) throw fail('DELETE', res);
    },
  };
}

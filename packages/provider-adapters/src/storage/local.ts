import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { assertStorageKey, StorageNotFoundError, type StorageProvider } from './types.js';

/**
 * DEVELOPMENT ONLY: stores objects under a local directory. Environment
 * validation refuses STORAGE_PROVIDER=local in staging and production.
 */
export function createLocalStorage(rootDir: string): StorageProvider {
  const root = resolve(rootDir);
  const pathOf = (key: string) => {
    assertStorageKey(key);
    const path = resolve(join(root, key));
    // Defence in depth on top of the key check.
    if (!path.startsWith(root + sep)) throw new Error('invalid storage key');
    return path;
  };

  return {
    name: 'local',
    async put(key, body) {
      const path = pathOf(key);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, body);
    },
    async get(key) {
      try {
        return await readFile(pathOf(key));
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT')
          throw new StorageNotFoundError('local');
        throw err;
      }
    },
    async delete(key) {
      await rm(pathOf(key), { force: true });
    },
  };
}

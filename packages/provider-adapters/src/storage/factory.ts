import { createBunnyStorage } from './bunny.js';
import { createLocalStorage } from './local.js';
import type { StorageProvider } from './types.js';

/** The storage settings shared by the API and the worker (validated by @cbi/config). */
export interface StorageSettings {
  STORAGE_PROVIDER: 'bunny' | 'local' | 'none';
  LOCAL_STORAGE_DIR: string;
  BUNNY_STORAGE_ZONE?: string;
  BUNNY_STORAGE_REGION_HOST: string;
  BUNNY_STORAGE_ACCESS_KEY?: string;
}

/** Null for `none` (configured by an admin instead). */
export function createStorage(settings: StorageSettings): StorageProvider | null {
  if (settings.STORAGE_PROVIDER === 'none') return null;
  if (settings.STORAGE_PROVIDER === 'bunny') {
    return createBunnyStorage({
      zone: settings.BUNNY_STORAGE_ZONE!,
      accessKey: settings.BUNNY_STORAGE_ACCESS_KEY!,
      regionHost: settings.BUNNY_STORAGE_REGION_HOST,
    });
  }
  return createLocalStorage(settings.LOCAL_STORAGE_DIR);
}

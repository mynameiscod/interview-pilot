import type { AiConfigSource, AiLogger, AiRuntimeConfig } from './types.js';

/**
 * In-process cache of the AI runtime configuration. Loads are single-flight;
 * if a reload fails the last good configuration keeps serving (logged), so a
 * brief MongoDB blip does not take every AI feature down.
 */
export function createCachedConfigSource(opts: {
  load: () => Promise<AiRuntimeConfig>;
  ttlMs: number;
  logger: AiLogger;
  now?: () => number;
}): AiConfigSource {
  const now = opts.now ?? Date.now;
  let cached: { value: AiRuntimeConfig; expiresAt: number } | null = null;
  let inflight: Promise<AiRuntimeConfig> | null = null;
  let generation = 0;

  async function reload(): Promise<AiRuntimeConfig> {
    const startedGeneration = generation;
    try {
      const value = await opts.load();
      // An invalidation during the load means this result may be stale already.
      if (startedGeneration === generation) cached = { value, expiresAt: now() + opts.ttlMs };
      return value;
    } catch (err) {
      if (cached) {
        opts.logger.error({ err }, 'ai config reload failed; serving last good configuration');
        cached = { value: cached.value, expiresAt: now() + Math.min(opts.ttlMs, 5000) };
        return cached.value;
      }
      throw err;
    }
  }

  return {
    async get() {
      if (cached && cached.expiresAt > now()) return cached.value;
      if (!inflight) {
        const load: Promise<AiRuntimeConfig> = reload().finally(() => {
          if (inflight === load) inflight = null;
        });
        inflight = load;
      }
      return inflight;
    },
    invalidate() {
      generation += 1;
      inflight = null;
      if (cached) cached = { value: cached.value, expiresAt: 0 };
    },
  };
}

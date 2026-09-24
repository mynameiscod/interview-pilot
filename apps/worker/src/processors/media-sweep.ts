import type { Logger } from '@cbi/config';
import { sweepMedia, type MediaStorage } from '@cbi/db';

/**
 * Closes recordings the browser never finalized (closed tab, crash) once
 * uploads can no longer arrive, and deletes recordings past retention.
 * Storage errors leave the record for the next run.
 */
export async function runMediaSweep(opts: { storage: MediaStorage; logger: Logger; now?: Date }) {
  const result = await sweepMedia(opts.storage, {
    now: opts.now,
    onError: (err, assetId) =>
      opts.logger.warn({ err, assetId }, 'media maintenance failed for a recording'),
  });
  if (result.finalized + result.deleted + result.errors > 0) {
    opts.logger.info(result, 'media maintenance');
  }
  return result;
}

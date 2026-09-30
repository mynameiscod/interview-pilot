import type { Logger } from '@cbi/config';
import { sweepExpiredIdentityCaptures, sweepMedia, type MediaStorage } from '@cbi/db';

/**
 * Closes recordings the browser never finalized (closed tab, crash) once
 * uploads can no longer arrive, and deletes recordings and identity-capture
 * photos past retention. Storage errors leave the record for the next run.
 */
export async function runMediaSweep(opts: { storage: MediaStorage; logger: Logger; now?: Date }) {
  const result = await sweepMedia(opts.storage, {
    now: opts.now,
    onError: (err, assetId) =>
      opts.logger.warn({ err, assetId }, 'media maintenance failed for a recording'),
  });
  const identity = await sweepExpiredIdentityCaptures(opts.storage, opts.now).catch(
    (err: unknown) => {
      opts.logger.warn({ err }, 'identity photo retention failed');
      return 0;
    },
  );
  if (result.finalized + result.deleted + result.errors + identity > 0) {
    opts.logger.info({ ...result, identityCapturesDeleted: identity }, 'media maintenance');
  }
  return { ...result, identityCapturesDeleted: identity };
}

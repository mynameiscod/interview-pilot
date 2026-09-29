import type { IdentityImageKind } from '@cbi/shared-types';
import type { Types } from 'mongoose';
import type { MediaStorage } from './media.js';
import { IdentityCaptureModel } from './models/org.js';

/**
 * Identity-capture images (selfie, ID photo, interview frame) live next to
 * recordings in object storage and follow the same retention: the worker's
 * media sweep deletes them after `retentionExpiresAt`, and account erasure
 * deletes them at once.
 */

export const identityImageKey = (
  capture: { userId: Types.ObjectId | string; sessionId: Types.ObjectId | string },
  kind: IdentityImageKind,
  mimeType: 'image/jpeg' | 'image/png',
) =>
  `identity/${String(capture.userId)}/${String(capture.sessionId)}/${kind.toLowerCase()}.${
    mimeType === 'image/png' ? 'png' : 'jpg'
  }`;

/** Deletes images past retention (storage first; a failure leaves the record for the next run). */
export async function sweepExpiredIdentityCaptures(
  storage: Pick<MediaStorage, 'delete'>,
  now = new Date(),
  limit = 100,
): Promise<number> {
  const due = await IdentityCaptureModel.find(
    { retentionExpiresAt: { $lte: now }, deletedAt: null },
    { images: 1 },
  )
    .limit(limit)
    .lean();
  let swept = 0;
  for (const capture of due) {
    for (const image of Object.values(capture.images ?? {})) {
      if (image) await storage.delete(image.storageKey);
    }
    await IdentityCaptureModel.updateOne(
      { _id: capture._id },
      { $set: { deletedAt: now, images: {} } },
    );
    swept++;
  }
  return swept;
}

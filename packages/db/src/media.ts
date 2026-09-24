import { MEDIA_LIMITS } from '@cbi/shared-types';
import type { Types } from 'mongoose';
import { MediaAssetModel, type MediaAssetRecord } from './models/media.js';
import { InterviewSessionModel } from './models/interview-session.js';

/**
 * Recording lifecycle shared by the API (finalize, purge) and the worker
 * (sweep, retention). Storage is structural so db has no adapter dependency.
 */
export interface MediaStorage {
  put(key: string, body: Buffer, contentType: string): Promise<void>;
  delete(key: string): Promise<void>;
}

type Id = Types.ObjectId | string;

/** Indexes 0 … expected-1 that were never stored. */
export function missingSegments(asset: Pick<MediaAssetRecord, 'segments' | 'expectedSegments'>) {
  const expected =
    asset.expectedSegments ??
    (asset.segments.length ? Math.max(...asset.segments.map((s) => s.idx)) + 1 : 0);
  const have = new Set(asset.segments.map((s) => s.idx));
  const missing: number[] = [];
  for (let i = 0; i < expected; i++) if (!have.has(i)) missing.push(i);
  return missing;
}

/** Where a recording's objects live: `media/<user>/<session>/<asset>/…`. */
export const mediaPrefix = (a: Pick<MediaAssetRecord, '_id' | 'userId' | 'sessionId'>) =>
  `media/${String(a.userId)}/${String(a.sessionId)}/${String(a._id)}`;

/**
 * Closes a recording: works out which segments are missing, writes a
 * manifest next to the segments and marks it COMPLETE, PARTIAL (gaps) or
 * FAILED (nothing stored). Idempotent; a later finalize with a count
 * re-evaluates. Never throws for storage problems in the manifest write:
 * the database record is the source of truth.
 */
export async function finalizeMediaAsset(
  assetId: Id,
  storage: MediaStorage,
  opts: { expectedSegments?: number | null; durationMs?: number | null; now?: Date } = {},
): Promise<MediaAssetRecord | null> {
  const now = opts.now ?? new Date();
  const asset = await MediaAssetModel.findById(assetId).lean<MediaAssetRecord>();
  if (!asset || asset.deletion.status === 'DELETED') return asset;
  const expectedSegments =
    opts.expectedSegments ??
    asset.expectedSegments ??
    (asset.segments.length ? Math.max(...asset.segments.map((s) => s.idx)) + 1 : 0);
  const withExpected = { ...asset, expectedSegments };
  const missing = missingSegments(withExpected);
  const status =
    asset.segments.length === 0 ? 'FAILED' : missing.length > 0 ? 'PARTIAL' : 'COMPLETE';
  const manifestKey = `${mediaPrefix(asset)}/manifest.json`;
  const manifest = {
    assetId: String(asset._id),
    sessionId: String(asset.sessionId),
    mimeType: asset.mimeType,
    status,
    expectedSegments,
    missingSegments: missing,
    durationMs: opts.durationMs ?? asset.durationMs,
    segments: [...asset.segments]
      .sort((a, b) => a.idx - b.idx)
      .map((s) => ({ idx: s.idx, key: s.storageKey, bytes: s.bytes, sha256: s.sha256 })),
    finalizedAt: now.toISOString(),
  };
  let wroteManifest = true;
  if (asset.segments.length > 0) {
    await storage
      .put(manifestKey, Buffer.from(JSON.stringify(manifest, null, 2)), 'application/json')
      .catch(() => {
        wroteManifest = false;
      });
  }
  return MediaAssetModel.findOneAndUpdate(
    { _id: asset._id, 'deletion.status': 'NONE' },
    {
      $set: {
        status,
        expectedSegments,
        ...(opts.durationMs != null ? { durationMs: opts.durationMs } : {}),
        manifestKey: asset.segments.length > 0 && wroteManifest ? manifestKey : asset.manifestKey,
        finalizedAt: now,
      },
    },
    { returnDocument: 'after' },
  ).lean<MediaAssetRecord>();
}

/**
 * Deletes a recording's stored objects and marks it DELETED (retention or
 * a purge). The record stays, without segment keys, as evidence of deletion.
 * Returns false when it was already deleted.
 */
export async function deleteMediaAsset(
  assetId: Id,
  storage: MediaStorage,
  opts: { reason: string; by: string; now?: Date },
): Promise<boolean> {
  const asset = await MediaAssetModel.findById(assetId).lean<MediaAssetRecord>();
  if (!asset || asset.deletion.status === 'DELETED') return false;
  const keys = [
    ...asset.segments.map((s) => s.storageKey),
    ...(asset.manifestKey ? [asset.manifestKey] : []),
  ];
  // Storage deletes are idempotent; a failure leaves the record untouched so the next run retries.
  for (const key of keys) await storage.delete(key);
  const res = await MediaAssetModel.updateOne(
    { _id: asset._id, 'deletion.status': 'NONE' },
    {
      $set: {
        segments: [],
        manifestKey: null,
        deletion: {
          status: 'DELETED',
          at: opts.now ?? new Date(),
          reason: opts.reason,
          by: opts.by,
        },
      },
    },
  );
  return res.modifiedCount === 1;
}

export interface MediaSweepResult {
  finalized: number;
  deleted: number;
  errors: number;
}

/**
 * The worker's media maintenance: finalizes recordings the browser never
 * closed (crash, closed tab) once uploads can no longer arrive, and deletes
 * recordings past their retention date.
 */
export async function sweepMedia(
  storage: MediaStorage,
  opts: { now?: Date; batchSize?: number; onError?: (err: unknown, assetId: string) => void } = {},
): Promise<MediaSweepResult> {
  const now = opts.now ?? new Date();
  const limit = opts.batchSize ?? 100;
  const result: MediaSweepResult = { finalized: 0, deleted: 0, errors: 0 };
  const cutoff = new Date(now.getTime() - MEDIA_LIMITS.uploadGraceMs);

  const open = await MediaAssetModel.find(
    { status: 'RECORDING', updatedAt: { $lt: cutoff } },
    { _id: 1, sessionId: 1 },
  )
    .limit(limit)
    .lean();
  for (const a of open) {
    // Still live (a very long pause): leave it recording.
    const s = await InterviewSessionModel.findById(a.sessionId, { live: 1 }).lean();
    if (s?.live) continue;
    try {
      await finalizeMediaAsset(a._id, storage, { now });
      result.finalized++;
    } catch (err) {
      result.errors++;
      opts.onError?.(err, String(a._id));
    }
  }

  const expired = await MediaAssetModel.find(
    { retentionExpiresAt: { $lte: now }, 'deletion.status': 'NONE' },
    { _id: 1 },
  )
    .limit(limit)
    .lean();
  for (const a of expired) {
    try {
      if (
        await deleteMediaAsset(a._id, storage, {
          reason: 'Retention period ended',
          by: 'system',
          now,
        })
      )
        result.deleted++;
    } catch (err) {
      result.errors++;
      opts.onError?.(err, String(a._id));
    }
  }
  return result;
}

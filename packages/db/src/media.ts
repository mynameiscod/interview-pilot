import { MEDIA_LIMITS } from '@cbi/shared-types';
import type { Types } from 'mongoose';
import { MediaAssetModel, type MediaAssetRecord, type MediaSegmentRecord } from './models/media.js';
import { InterviewSessionModel } from './models/interview-session.js';

/**
 * Recording lifecycle shared by the API (finalize, purge) and the worker
 * (sweep, retention, joined file). Storage is structural so db has no
 * adapter dependency.
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

/** The joined recording the worker builds (same container as the segments). */
export const mediaFileKey = (
  a: Pick<MediaAssetRecord, '_id' | 'userId' | 'sessionId' | 'mimeType'>,
) => `${mediaPrefix(a)}/recording.${a.mimeType === 'video/mp4' ? 'mp4' : 'webm'}`;

export interface MediaPart {
  part: number;
  /** In index order; the first carries the container header. */
  segments: MediaSegmentRecord[];
  bytes: number;
}

/**
 * The recorder instances (parts) that can be played: each is its own
 * container, so a part whose first segment (the header) never arrived is
 * skipped. Gaps later in a part are kept; players skip the missing clusters.
 */
export function mediaParts(asset: Pick<MediaAssetRecord, 'segments'>): MediaPart[] {
  const byPart = new Map<number, MediaSegmentRecord[]>();
  for (const seg of asset.segments) {
    const part = seg.part ?? 0;
    byPart.set(part, [...(byPart.get(part) ?? []), seg]);
  }
  return [...byPart.entries()]
    .sort(([a], [b]) => a - b)
    .map(([part, segs]) => {
      const segments = [...segs].sort((a, b) => a.idx - b.idx);
      return { part, segments, bytes: segments.reduce((n, s) => n + s.bytes, 0) };
    })
    .filter(({ segments }) => segments[0]!.header ?? segments[0]!.idx === 0);
}

/**
 * Closes a recording: works out which segments are missing, writes a
 * manifest next to the segments and marks it COMPLETE, PARTIAL (gaps) or
 * FAILED (nothing stored), and queues the joined file for the worker.
 * Idempotent; a later finalize with a count re-evaluates. Never throws for
 * storage problems in the manifest write: the database record is the
 * source of truth.
 */
export async function finalizeMediaAsset(
  assetId: Id,
  storage: MediaStorage,
  opts: { expectedSegments?: number | null; durationMs?: number | null; now?: Date } = {},
): Promise<MediaAssetRecord | null> {
  const now = opts.now ?? new Date();
  const asset = await MediaAssetModel.findById(assetId).lean<MediaAssetRecord>();
  if (!asset || asset.deletion.status !== 'NONE') return asset;
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
      .map((s) => ({
        idx: s.idx,
        part: s.part ?? 0,
        key: s.storageKey,
        bytes: s.bytes,
        sha256: s.sha256,
      })),
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
        // (Re)build the joined file; a stale one keeps its key until it is replaced.
        ...(asset.segments.length > 0
          ? {
              'playbackFile.status': 'PENDING',
              'playbackFile.at': now,
              'playbackFile.attempts': 0,
              'playbackFile.error': null,
            }
          : {}),
      },
    },
    { returnDocument: 'after' },
  ).lean<MediaAssetRecord>();
}

/** Late uploads and file builds that started before a delete are over well within this. */
export const MEDIA_DELETE_SWEEP_DELAY_MS = MEDIA_LIMITS.uploadGraceMs;
/** A delete still DELETING after this stopped half-way (storage failure, crash): the sweep resumes it. */
const STALE_DELETE_MS = 5 * 60_000;

/**
 * Deletes a recording's stored objects and marks it DELETED (retention or
 * a purge). The record stays, without segment keys, as evidence of deletion.
 * Returns false when it was already deleted.
 *
 * Order matters: the asset is marked DELETING first, so segment uploads
 * (which only attach to a NONE asset) are refused from then on; the keys are
 * read after that, deleted, and kept on the record so the sweep deletes them
 * once more after `sweepAfter` (an upload or file build that was already
 * writing when the delete began). A storage failure leaves it DELETING and
 * the sweep retries.
 */
export async function deleteMediaAsset(
  assetId: Id,
  storage: MediaStorage,
  opts: { reason: string; by: string; now?: Date },
): Promise<boolean> {
  const now = opts.now ?? new Date();
  const asset = await MediaAssetModel.findOneAndUpdate(
    { _id: assetId, 'deletion.status': { $in: ['NONE', 'DELETING'] } },
    {
      $set: {
        'deletion.status': 'DELETING',
        'deletion.at': now,
        'deletion.reason': opts.reason,
        'deletion.by': opts.by,
      },
    },
    { returnDocument: 'after' },
  ).lean<MediaAssetRecord>();
  if (!asset) return false;
  const keys = [
    ...new Set([
      ...asset.segments.map((s) => s.storageKey),
      ...(asset.manifestKey ? [asset.manifestKey] : []),
      ...(asset.playbackFile?.key ? [asset.playbackFile.key] : []),
      // A build may be writing the joined file right now.
      mediaFileKey(asset),
      ...(asset.deletion.keys ?? []),
    ]),
  ];
  // Storage deletes are idempotent; a failure leaves the asset DELETING so a later run retries.
  for (const key of keys) await storage.delete(key);
  const res = await MediaAssetModel.updateOne(
    { _id: asset._id, 'deletion.status': 'DELETING' },
    {
      $set: {
        segments: [],
        manifestKey: null,
        playbackFile: { status: 'NONE', key: null, bytes: null, at: now, attempts: 0, error: null },
        deletion: {
          status: 'DELETED',
          at: now,
          reason: opts.reason,
          by: opts.by,
          keys,
          sweepAfter: new Date(now.getTime() + MEDIA_DELETE_SWEEP_DELAY_MS),
        },
      },
    },
  );
  return res.modifiedCount === 1;
}

/**
 * An object was written for a recording that is being (or was) deleted:
 * remember its key so the post-delete sweep removes it even when the
 * writer's own cleanup fails.
 */
export async function noteOrphanedMediaKey(assetId: Id, key: string, now = new Date()) {
  await MediaAssetModel.updateOne(
    { _id: assetId, 'deletion.status': { $in: ['DELETING', 'DELETED'] } },
    {
      $addToSet: { 'deletion.keys': key },
      $set: { 'deletion.sweepAfter': new Date(now.getTime() + MEDIA_DELETE_SWEEP_DELAY_MS) },
    },
  );
}

// ---- Joined playback file (worker) ---------------------------------------------------------

/** A build not finished within this is assumed crashed and claimed again. */
export const MEDIA_FILE_LEASE_MS = 30 * 60_000;
/** Builds are tried this many times before the file is marked FAILED. */
export const MEDIA_FILE_MAX_ATTEMPTS = 3;

/**
 * Claims one recording whose joined file needs (re)building. The claim time
 * identifies the build: a late segment re-finalizing meanwhile resets the
 * status, and the stale build then cannot mark it READY.
 */
export async function claimMediaFileBuild(now = new Date()) {
  return MediaAssetModel.findOneAndUpdate(
    {
      'deletion.status': 'NONE',
      status: { $in: ['COMPLETE', 'PARTIAL'] },
      $or: [
        { 'playbackFile.status': 'PENDING' },
        {
          'playbackFile.status': 'PROCESSING',
          'playbackFile.at': { $lt: new Date(now.getTime() - MEDIA_FILE_LEASE_MS) },
        },
      ],
    },
    {
      $set: { 'playbackFile.status': 'PROCESSING', 'playbackFile.at': now },
      $inc: { 'playbackFile.attempts': 1 },
    },
    { sort: { 'playbackFile.at': 1 }, returnDocument: 'after' },
  ).lean<MediaAssetRecord>();
}

export type MediaFileOutcome =
  | { status: 'READY'; key: string; bytes: number }
  | { status: 'FAILED' | 'UNAVAILABLE'; error: string };

/**
 * Records a build's outcome, only while the claim still stands. A failure
 * goes back to PENDING until the attempts run out. Returns false when the
 * claim was lost (re-finalized or deleted meanwhile).
 */
export async function completeMediaFileBuild(
  claimed: Pick<MediaAssetRecord, '_id' | 'playbackFile'>,
  outcome: MediaFileOutcome,
  now = new Date(),
): Promise<boolean> {
  const retry =
    outcome.status === 'FAILED' && claimed.playbackFile.attempts < MEDIA_FILE_MAX_ATTEMPTS;
  const res = await MediaAssetModel.updateOne(
    {
      _id: claimed._id,
      'deletion.status': 'NONE',
      'playbackFile.status': 'PROCESSING',
      'playbackFile.at': claimed.playbackFile.at,
    },
    {
      $set:
        outcome.status === 'READY'
          ? {
              'playbackFile.status': 'READY',
              'playbackFile.key': outcome.key,
              'playbackFile.bytes': outcome.bytes,
              'playbackFile.at': now,
              'playbackFile.error': null,
            }
          : {
              'playbackFile.status': retry ? 'PENDING' : outcome.status,
              'playbackFile.at': now,
              'playbackFile.error': outcome.error.slice(0, 500),
            },
    },
  );
  return res.modifiedCount === 1;
}

export interface MediaSweepResult {
  finalized: number;
  deleted: number;
  /** Deleted recordings whose keys were deleted once more (late writers). */
  swept: number;
  errors: number;
}

/**
 * The worker's media maintenance: finalizes recordings the browser never
 * closed (crash, closed tab) once uploads can no longer arrive, deletes
 * recordings past their retention date (and resumes deletes that stopped
 * half-way), and deletes the keys of deleted recordings once more.
 */
export async function sweepMedia(
  storage: MediaStorage,
  opts: { now?: Date; batchSize?: number; onError?: (err: unknown, assetId: string) => void } = {},
): Promise<MediaSweepResult> {
  const now = opts.now ?? new Date();
  const limit = opts.batchSize ?? 100;
  const result: MediaSweepResult = { finalized: 0, deleted: 0, swept: 0, errors: 0 };
  const cutoff = new Date(now.getTime() - MEDIA_LIMITS.uploadGraceMs);

  const open = await MediaAssetModel.find(
    { status: 'RECORDING', updatedAt: { $lt: cutoff }, 'deletion.status': 'NONE' },
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
    {
      $or: [
        { retentionExpiresAt: { $lte: now }, 'deletion.status': 'NONE' },
        {
          'deletion.status': 'DELETING',
          'deletion.at': { $lt: new Date(now.getTime() - STALE_DELETE_MS) },
        },
      ],
    },
    { _id: 1, deletion: 1 },
  )
    .limit(limit)
    .lean<Pick<MediaAssetRecord, '_id' | 'deletion'>[]>();
  for (const a of expired) {
    const resumed = a.deletion.status === 'DELETING';
    try {
      if (
        await deleteMediaAsset(a._id, storage, {
          reason: resumed ? (a.deletion.reason ?? 'Deleted') : 'Retention period ended',
          by: resumed ? (a.deletion.by ?? 'system') : 'system',
          now,
        })
      )
        result.deleted++;
    } catch (err) {
      result.errors++;
      opts.onError?.(err, String(a._id));
    }
  }

  // Objects written while a delete ran (an upload or build already in flight) are deleted now.
  const deleted = await MediaAssetModel.find(
    { 'deletion.status': 'DELETED', 'deletion.sweepAfter': { $ne: null, $lte: now } },
    { _id: 1, deletion: 1 },
  )
    .limit(limit)
    .lean<Pick<MediaAssetRecord, '_id' | 'deletion'>[]>();
  for (const a of deleted) {
    try {
      for (const key of a.deletion.keys ?? []) await storage.delete(key);
      await MediaAssetModel.updateOne(
        { _id: a._id, 'deletion.sweepAfter': a.deletion.sweepAfter },
        { $set: { 'deletion.sweepAfter': null } },
      );
      result.swept++;
    } catch (err) {
      result.errors++;
      opts.onError?.(err, String(a._id));
    }
  }
  return result;
}

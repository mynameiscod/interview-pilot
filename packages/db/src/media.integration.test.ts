import { createLogger } from '@cbi/config';
import { MEDIA_LIMITS } from '@cbi/shared-types';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  claimMediaFileBuild,
  completeMediaFileBuild,
  deleteMediaAsset,
  finalizeMediaAsset,
  MEDIA_DELETE_SWEEP_DELAY_MS,
  MEDIA_FILE_MAX_ATTEMPTS,
  mediaParts,
  noteOrphanedMediaKey,
  sweepMedia,
  type MediaStorage,
} from './media.js';
import { InterviewSessionModel } from './models/interview-session.js';
import { MediaAssetModel } from './models/media.js';
import { connectMongo, disconnectMongo, mongoose } from './mongo.js';
import { ensureIndexes } from './indexes.js';

const MONGODB_URI = process.env.MONGODB_URI;
if (
  !MONGODB_URI ||
  !/test/i.test(new URL(MONGODB_URI.replace(/^mongodb(\+srv)?:/, 'http:')).pathname)
) {
  throw new Error(
    'Integration tests need MONGODB_URI pointing at a database whose name contains "test".',
  );
}

beforeAll(async () => {
  await connectMongo({
    uri: MONGODB_URI,
    autoIndex: false,
    logger: createLogger({ service: 'test', level: 'silent' }),
  });
  await ensureIndexes();
});
beforeEach(async () => {
  const db = mongoose.connection.db!;
  for (const { name } of await db.listCollections().toArray())
    await db.collection(name).deleteMany({});
});
afterAll(disconnectMongo);

// Real time: records get real createdAt/updatedAt stamps.
const NOW = new Date();
const ago = (ms: number) => new Date(NOW.getTime() - ms);

function memoryStorage(opts: { failDeletes?: boolean } = {}) {
  const objects = new Map<string, Buffer>();
  const storage: MediaStorage = {
    async put(key, body) {
      objects.set(key, body);
    },
    async delete(key) {
      if (opts.failDeletes) throw new Error('storage down');
      objects.delete(key);
    },
  };
  return { storage, objects };
}

async function asset(opts: {
  live?: boolean;
  segments?: number[];
  updatedAt?: Date;
  retentionExpiresAt?: Date;
  objects?: Map<string, Buffer>;
}) {
  const userId = new mongoose.Types.ObjectId();
  const session = await InterviewSessionModel.create({
    userId,
    jobTargetId: new mongoose.Types.ObjectId(),
    templateId: new mongoose.Types.ObjectId(),
    state: opts.live ? 'ACTIVE' : 'PROCESSING',
    live: Boolean(opts.live),
  });
  const segments = (opts.segments ?? []).map((idx) => {
    const key = `media/${String(userId)}/${String(session._id)}/a/seg-${idx}.webm`;
    opts.objects?.set(key, Buffer.from(`seg-${idx}`));
    return { idx, storageKey: key, bytes: 5, sha256: `sha-${idx}`, uploadedAt: NOW };
  });
  const a = await MediaAssetModel.create({
    sessionId: session._id,
    userId,
    kind: 'CANDIDATE_VIDEO',
    mimeType: 'video/webm',
    segments,
    bytes: segments.length * 5,
    retentionExpiresAt: opts.retentionExpiresAt ?? new Date(NOW.getTime() + 90 * 86_400_000),
  });
  if (opts.updatedAt) {
    await MediaAssetModel.collection.updateOne(
      { _id: a._id },
      { $set: { updatedAt: opts.updatedAt } },
    );
  }
  return a._id;
}

describe('recording finalization', () => {
  it('marks gaps as PARTIAL, nothing as FAILED and writes a manifest', async () => {
    const { storage, objects } = memoryStorage();
    const partial = await asset({ segments: [0, 1, 3] });
    const done = (await finalizeMediaAsset(partial, storage, { expectedSegments: 5, now: NOW }))!;
    expect(done).toMatchObject({ status: 'PARTIAL', expectedSegments: 5 });
    const manifest = JSON.parse(objects.get(done.manifestKey!)!.toString());
    expect(manifest.missingSegments).toEqual([2, 4]);

    const empty = await asset({ segments: [] });
    expect((await finalizeMediaAsset(empty, storage, { expectedSegments: 4 }))!.status).toBe(
      'FAILED',
    );
    const whole = await asset({ segments: [0, 1] });
    expect((await finalizeMediaAsset(whole, storage))!.status).toBe('COMPLETE');
  });
});

describe('media sweep', () => {
  it('closes abandoned recordings once uploads can no longer arrive, and deletes expired ones', async () => {
    const { storage, objects } = memoryStorage();
    const abandoned = await asset({
      segments: [0, 2],
      updatedAt: ago(MEDIA_LIMITS.uploadGraceMs + 60_000),
      objects,
    });
    const recent = await asset({ segments: [0], updatedAt: ago(60_000), objects });
    const stillLive = await asset({
      live: true,
      segments: [0],
      updatedAt: ago(MEDIA_LIMITS.uploadGraceMs + 60_000),
      objects,
    });
    const expired = await asset({ segments: [0, 1], retentionExpiresAt: ago(1000), objects });

    const result = await sweepMedia(storage, { now: NOW });
    expect(result).toEqual({ finalized: 1, deleted: 1, swept: 0, errors: 0 });
    expect((await MediaAssetModel.findById(abandoned).lean())!.status).toBe('PARTIAL');
    expect((await MediaAssetModel.findById(recent).lean())!.status).toBe('RECORDING');
    expect((await MediaAssetModel.findById(stillLive).lean())!.status).toBe('RECORDING');
    const gone = (await MediaAssetModel.findById(expired).lean())!;
    expect(gone.deletion).toMatchObject({
      status: 'DELETED',
      reason: 'Retention period ended',
      by: 'system',
    });
    expect(gone.segments).toEqual([]);
    expect([...objects.keys()].some((k) => k.includes(String(gone.sessionId)))).toBe(false);

    // Running again changes nothing.
    expect(await sweepMedia(storage, { now: NOW })).toEqual({
      finalized: 0,
      deleted: 0,
      swept: 0,
      errors: 0,
    });
  });

  it('keeps an expired recording for the next run when storage deletes fail', async () => {
    const { storage } = memoryStorage({ failDeletes: true });
    const expired = await asset({ segments: [0], retentionExpiresAt: ago(1000) });
    const errors: string[] = [];
    const result = await sweepMedia(storage, { now: NOW, onError: (_e, id) => errors.push(id) });
    expect(result).toMatchObject({ deleted: 0, errors: 1 });
    expect(errors).toEqual([String(expired)]);
    // Half-deleted: no longer playable or uploadable, and retried by a later run.
    expect((await MediaAssetModel.findById(expired).lean())!.deletion.status).toBe('DELETING');
    const healthy = memoryStorage();
    const later = await sweepMedia(healthy.storage, { now: new Date(NOW.getTime() + 10 * 60_000) });
    expect(later).toMatchObject({ deleted: 1, errors: 0 });
    expect((await MediaAssetModel.findById(expired).lean())!.deletion.status).toBe('DELETED');
  });
});

describe('deleting a recording', () => {
  it('refuses segments once the delete begins and sweeps keys written during it', async () => {
    const { storage, objects } = memoryStorage();
    const id = await asset({ segments: [0, 1], objects });
    let pushedDuringDelete = true;
    const racing: MediaStorage = {
      put: storage.put,
      async delete(key) {
        // A segment upload finishing while the delete runs: its push must be refused.
        if (pushedDuringDelete) {
          pushedDuringDelete = false;
          const pushed = await MediaAssetModel.updateOne(
            { _id: id, 'deletion.status': 'NONE' },
            {
              $push: {
                segments: { idx: 2, storageKey: 'late', bytes: 1, sha256: 'x', uploadedAt: NOW },
              },
            },
          );
          expect(pushed.modifiedCount).toBe(0);
          // The uploader could not delete its object: it records the key for the sweep.
          objects.set('media/late/seg-2.webm', Buffer.from('late'));
          await noteOrphanedMediaKey(id, 'media/late/seg-2.webm', NOW);
        }
        return storage.delete(key);
      },
    };
    expect(await deleteMediaAsset(id, racing, { reason: 'Test', by: 'system', now: NOW })).toBe(
      true,
    );
    const gone = (await MediaAssetModel.findById(id).lean())!;
    expect(gone.deletion.status).toBe('DELETED');
    expect(gone.segments).toEqual([]);
    expect(gone.deletion.keys).toContain('media/late/seg-2.webm');
    expect(objects.has('media/late/seg-2.webm')).toBe(true);

    // After the delay the sweep deletes every recorded key once more.
    const later = new Date(NOW.getTime() + MEDIA_DELETE_SWEEP_DELAY_MS + 1000);
    expect(await sweepMedia(storage, { now: later })).toMatchObject({ swept: 1, errors: 0 });
    expect([...objects.keys()]).toEqual([]);
    expect((await MediaAssetModel.findById(id).lean())!.deletion.sweepAfter).toBeNull();
    expect(await deleteMediaAsset(id, storage, { reason: 'Again', by: 'system' })).toBe(false);
  });
});

describe('joined playback file', () => {
  it('groups segments by recorder part and skips parts whose header never arrived', () => {
    const seg = (idx: number, part: number, header: boolean) => ({
      idx,
      part,
      header,
      storageKey: `k${idx}`,
      bytes: 10,
      sha256: 'x',
      uploadedAt: NOW,
    });
    const parts = mediaParts({
      segments: [seg(3, 1, true), seg(0, 0, true), seg(1, 0, false), seg(5, 2, false)],
    });
    expect(parts.map((p) => [p.part, p.segments.map((s) => s.idx), p.bytes])).toEqual([
      [0, [0, 1], 20],
      [1, [3], 10],
    ]);
    // Older records have neither field: one part, the header in segment 0.
    const legacy = mediaParts({
      segments: [{ idx: 0, storageKey: 'a', bytes: 1, sha256: 'x', uploadedAt: NOW }],
    });
    expect(legacy).toHaveLength(1);
  });

  it('is claimed once, completed only while the claim stands, and retried before failing', async () => {
    const { storage } = memoryStorage();
    const id = await asset({ segments: [0, 1] });
    await finalizeMediaAsset(id, storage, { now: NOW });
    const claimed = (await claimMediaFileBuild(NOW))!;
    expect(claimed.playbackFile).toMatchObject({ status: 'PROCESSING', attempts: 1 });
    expect(await claimMediaFileBuild(NOW)).toBeNull();

    // A late segment re-finalizes meanwhile: the stale build cannot mark it READY.
    await finalizeMediaAsset(id, storage, { now: new Date(NOW.getTime() + 1) });
    expect(await completeMediaFileBuild(claimed, { status: 'READY', key: 'k', bytes: 1 })).toBe(
      false,
    );

    let current = (await claimMediaFileBuild(new Date(NOW.getTime() + 2)))!;
    for (let attempt = 1; attempt < MEDIA_FILE_MAX_ATTEMPTS; attempt++) {
      expect(await completeMediaFileBuild(current, { status: 'FAILED', error: 'bad' })).toBe(true);
      expect((await MediaAssetModel.findById(id).lean())!.playbackFile.status).toBe('PENDING');
      current = (await claimMediaFileBuild(new Date(NOW.getTime() + 10 + attempt)))!;
    }
    await completeMediaFileBuild(current, { status: 'FAILED', error: 'bad' });
    expect((await MediaAssetModel.findById(id).lean())!.playbackFile).toMatchObject({
      status: 'FAILED',
      error: 'bad',
    });
  });
});

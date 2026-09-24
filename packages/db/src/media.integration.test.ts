import { createLogger } from '@cbi/config';
import { MEDIA_LIMITS } from '@cbi/shared-types';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { finalizeMediaAsset, sweepMedia, type MediaStorage } from './media.js';
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
    expect(result).toEqual({ finalized: 1, deleted: 1, errors: 0 });
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
    expect((await MediaAssetModel.findById(expired).lean())!.deletion.status).toBe('NONE');
  });
});

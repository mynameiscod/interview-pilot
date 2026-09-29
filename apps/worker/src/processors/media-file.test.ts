import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createLogger } from '@cbi/config';
import { mongoose, type MediaAssetRecord } from '@cbi/db';
import { createMemoryStorage } from '@cbi/provider-adapters/testing';
import { describe, expect, it, vi } from 'vitest';
import {
  buildMediaFile,
  createFfmpegRunner,
  FfmpegMissingError,
  joinArgs,
  type FfmpegRunner,
} from './media-file.js';

const logger = createLogger({ service: 'test', level: 'silent' });
const NOW = new Date('2026-09-29T10:00:00.000Z');

/** A finalized recording whose segments are in `objects`. */
function recording(
  segments: { idx: number; part: number; header: boolean; body: string }[],
  objects: Map<string, { body: Buffer; contentType: string }>,
  mimeType: MediaAssetRecord['mimeType'] = 'video/webm',
): MediaAssetRecord {
  const _id = new mongoose.Types.ObjectId();
  const userId = new mongoose.Types.ObjectId();
  const sessionId = new mongoose.Types.ObjectId();
  return {
    _id,
    userId,
    sessionId,
    kind: 'CANDIDATE_VIDEO',
    mimeType,
    status: 'PARTIAL',
    segments: segments.map((s) => {
      const storageKey = `media/${String(userId)}/${String(sessionId)}/${String(_id)}/seg-${s.idx}`;
      objects.set(storageKey, { body: Buffer.from(s.body), contentType: mimeType });
      return { ...s, storageKey, bytes: s.body.length, sha256: 'x', uploadedAt: NOW };
    }),
    bytes: 0,
    expectedSegments: 6,
    durationMs: null,
    consentId: null,
    manifestKey: null,
    finalizedAt: NOW,
    playbackFile: {
      status: 'PROCESSING',
      key: null,
      bytes: null,
      at: NOW,
      attempts: 1,
      error: null,
    },
    retentionExpiresAt: NOW,
    deletion: { status: 'NONE', at: null, reason: null, by: null, keys: [], sweepAfter: null },
    createdAt: NOW,
    updatedAt: NOW,
  };
}

/** A stand-in ffmpeg: records what it was given and writes the joined parts as the output. */
function fakeFfmpeg(fail: (args: string[]) => Error | null = () => null) {
  const calls: { args: string[]; list: string }[] = [];
  const run: FfmpegRunner = vi.fn(async (args, cwd) => {
    const list = await readFile(join(cwd, args[args.indexOf('-i') + 1]!), 'utf8');
    calls.push({ args, list });
    const err = fail(args);
    if (err) throw err;
    const names = [...list.matchAll(/file '([^']+)'/g)].map((m) => m[1]!);
    const parts = await Promise.all(names.map((n) => readFile(join(cwd, n))));
    await writeFile(join(cwd, args.at(-1)!), Buffer.concat(parts));
  });
  return { run, calls };
}

describe('joined recording file', () => {
  it('reassembles each recorder part, skips a part without its header and stores one file', async () => {
    const { storage, objects } = createMemoryStorage();
    const asset = recording(
      [
        { idx: 0, part: 0, header: true, body: 'H0' },
        { idx: 1, part: 0, header: false, body: 'a' },
        // Segment 2 was lost; part 0 keeps playing past the gap.
        { idx: 3, part: 0, header: false, body: 'b' },
        // Part 1's first segment (its header) never arrived: it cannot be decoded.
        { idx: 5, part: 1, header: false, body: 'x' },
        { idx: 4, part: 2, header: true, body: 'H2' },
      ],
      objects,
    );
    const ffmpeg = fakeFfmpeg();
    const outcome = await buildMediaFile(asset, { storage, ffmpeg: ffmpeg.run, logger });

    expect(ffmpeg.calls).toHaveLength(1);
    expect(ffmpeg.calls[0]!.list).toBe("file 'part-0.webm'\nfile 'part-2.webm'\n");
    expect(ffmpeg.calls[0]!.args).toEqual(
      expect.arrayContaining(['-f', 'concat', '-c', 'copy', 'recording.webm']),
    );
    const key = `media/${String(asset.userId)}/${String(asset.sessionId)}/${String(asset._id)}/recording.webm`;
    expect(outcome).toEqual({ status: 'READY', key, bytes: 6 });
    expect(objects.get(key)!.body.toString()).toBe('H0abH2');
  });

  it('re-encodes when the parts cannot be joined as they are', async () => {
    const { storage, objects } = createMemoryStorage();
    const asset = recording(
      [
        { idx: 0, part: 0, header: true, body: 'H0' },
        { idx: 1, part: 1, header: true, body: 'H1' },
      ],
      objects,
      'video/mp4',
    );
    const ffmpeg = fakeFfmpeg((args) =>
      args.includes('copy') ? new Error('Non-monotonic DTS; codec parameters differ') : null,
    );
    const outcome = await buildMediaFile(asset, { storage, ffmpeg: ffmpeg.run, logger });
    expect(outcome).toMatchObject({ status: 'READY', bytes: 4 });
    expect(ffmpeg.calls).toHaveLength(2);
    expect(ffmpeg.calls[1]!.args).toEqual(
      expect.arrayContaining(['libx264', '-movflags', '+faststart', 'recording.mp4']),
    );
  });

  it('reports ffmpeg missing as UNAVAILABLE and other failures as FAILED', async () => {
    const { storage, objects } = createMemoryStorage();
    const asset = recording([{ idx: 0, part: 0, header: true, body: 'H0' }], objects);
    const missing = fakeFfmpeg(() => new FfmpegMissingError(new Error('ENOENT')));
    expect(await buildMediaFile(asset, { storage, ffmpeg: missing.run, logger })).toMatchObject({
      status: 'UNAVAILABLE',
    });
    expect(missing.calls).toHaveLength(1);
    const broken = fakeFfmpeg(() => new Error('Invalid data found when processing input'));
    expect(await buildMediaFile(asset, { storage, ffmpeg: broken.run, logger })).toMatchObject({
      status: 'FAILED',
      error: 'Invalid data found when processing input',
    });
    // Nothing playable at all.
    const headless = recording([{ idx: 3, part: 1, header: false, body: 'x' }], objects);
    expect(await buildMediaFile(headless, { storage, ffmpeg: broken.run, logger })).toEqual({
      status: 'FAILED',
      error: 'no playable part',
    });
  });

  it('detects a machine without ffmpeg', async () => {
    const run = createFfmpegRunner({ path: 'cbi-no-such-ffmpeg-binary' });
    await expect(run(['-version'], process.cwd())).rejects.toBeInstanceOf(FfmpegMissingError);
  });

  it('asks for a seekable container', () => {
    expect(joinArgs('l.txt', 'o.mp4', 'video/mp4', 'copy')).toEqual(
      expect.arrayContaining(['-movflags', '+faststart']),
    );
    expect(joinArgs('l.txt', 'o.webm', 'video/webm', 'encode')).toEqual(
      expect.arrayContaining(['libvpx', 'libopus']),
    );
    expect(joinArgs('l.txt', 'o.webm', 'video/webm', 'copy')).not.toContain('-movflags');
  });
});

import { createLogger } from '@cbi/config';
import {
  IntegrityEventModel,
  InterviewSessionModel,
  MediaAssetModel,
  mongoose,
  type MediaAssetRecord,
} from '@cbi/db';
import { createMemoryStorage } from '@cbi/provider-adapters/testing';
import { MAX_INTEGRITY_EVENTS, PlaybackUrl } from '@cbi/shared-types';
import express, { type ErrorRequestHandler } from 'express';

import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AuditService } from '../../lib/audit.js';
import { AppError } from '../../lib/errors.js';
import { createMediaService, segmentMime, sniffVideoHeader } from './media.service.js';
import { parseRange, readPieces } from './range.js';

const NOW = new Date('2026-09-29T10:00:00.000Z');
const logger = createLogger({ service: 'test', level: 'silent' });
const WEBM = Buffer.from([0x1a, 0x45, 0xdf, 0xa3]);

afterEach(() => vi.restoreAllMocks());

/** A mongoose query stand-in: `.lean()` resolves to the value. */
const query = <T>(value: T) => ({ lean: async () => value }) as never;

function service(storage = createMemoryStorage()) {
  const media = createMediaService({
    storage: storage.storage,
    audit: { record: vi.fn() } as unknown as AuditService,
    logger,
    retentionDays: 90,
    signingSecret: 'test-signing-secret',
    now: () => NOW,
  });
  return { media, storage };
}

function assetWith(
  segments: { idx: number; part?: number; header?: boolean; body: Buffer }[],
  objects: Map<string, { body: Buffer; contentType: string }>,
  extra: Partial<MediaAssetRecord> = {},
): MediaAssetRecord {
  const id = new mongoose.Types.ObjectId();
  return {
    _id: id,
    sessionId: new mongoose.Types.ObjectId(),
    userId: new mongoose.Types.ObjectId(),
    kind: 'CANDIDATE_VIDEO',
    mimeType: 'video/webm',
    status: 'COMPLETE',
    segments: segments.map((s) => {
      const storageKey = `media/u/s/${String(id)}/seg-${s.idx}.webm`;
      objects.set(storageKey, { body: s.body, contentType: 'video/webm' });
      return {
        idx: s.idx,
        part: s.part,
        header: s.header,
        storageKey,
        bytes: s.body.length,
        sha256: 'x',
        uploadedAt: NOW,
      };
    }),
    bytes: segments.reduce((n, s) => n + s.body.length, 0),
    expectedSegments: segments.length,
    durationMs: null,
    consentId: null,
    manifestKey: null,
    finalizedAt: NOW,
    playbackFile: { status: 'PENDING', key: null, bytes: null, at: NOW, attempts: 0, error: null },
    retentionExpiresAt: new Date(NOW.getTime() + 86_400_000),
    deletion: { status: 'NONE', at: null, reason: null, by: null, keys: [], sweepAfter: null },
    createdAt: NOW,
    updatedAt: NOW,
    ...extra,
  };
}

/** The signed playback route on a bare app (the real router only adds the params). */
function playbackApp(media: ReturnType<typeof service>['media']) {
  const app = express();
  app.get('/api/v1/media/play/:assetId', async (req, res) => {
    await media.stream(
      String(req.params.assetId),
      {
        exp: String(req.query.exp ?? ''),
        sig: String(req.query.sig ?? ''),
        part: req.query.part === undefined ? undefined : String(req.query.part),
      },
      { method: req.method, range: req.get('range') },
      res,
    );
  });
  const onError: ErrorRequestHandler = (err, _req, res, _next) => {
    res.status(err instanceof AppError ? err.status : 500).end();
  };
  app.use(onError);
  return app;
}

const binary = (req: request.Test) =>
  req.buffer(true).parse((res, cb) => {
    const chunks: Buffer[] = [];
    res.on('data', (c: Buffer) => chunks.push(c));
    res.on('end', () => cb(null, Buffer.concat(chunks)));
  });

describe('byte ranges', () => {
  it('parses a single range and answers what cannot be served', () => {
    expect(parseRange(undefined, 100)).toBeNull();
    expect(parseRange('bytes=0-', 100)).toEqual({ start: 0, end: 99 });
    expect(parseRange('bytes=10-19', 100)).toEqual({ start: 10, end: 19 });
    expect(parseRange('bytes=90-500', 100)).toEqual({ start: 90, end: 99 });
    expect(parseRange('bytes=-10', 100)).toEqual({ start: 90, end: 99 });
    expect(parseRange('bytes=-500', 100)).toEqual({ start: 0, end: 99 });
    expect(parseRange('bytes=100-', 100)).toBe('unsatisfiable');
    expect(parseRange('bytes=-0', 100)).toBe('unsatisfiable');
    // Several ranges, reversed or malformed: served whole.
    expect(parseRange('bytes=0-1,5-6', 100)).toBeNull();
    expect(parseRange('bytes=9-2', 100)).toBeNull();
    expect(parseRange('items=0-1', 100)).toBeNull();
  });

  it('reads only the pieces a range touches, window by window', async () => {
    const { storage, objects } = createMemoryStorage();
    const getRange = vi.spyOn(storage, 'getRange');
    for (const [k, v] of Object.entries({ a: 'abcd', b: 'efgh', c: 'ijkl' }))
      objects.set(k, { body: Buffer.from(v), contentType: 'x' });
    const pieces = ['a', 'b', 'c'].map((key) => ({ key, bytes: 4 }));
    const out: string[] = [];
    for await (const chunk of readPieces(storage, pieces, { start: 3, end: 8 }, 3))
      out.push(chunk.toString());
    expect(out.join('')).toBe('defghi');
    expect(getRange.mock.calls.map((c) => c[0])).toEqual(['a', 'b', 'b', 'c']);
  });
});

describe('segment containers', () => {
  it('recognises the start of a container and checks it against the declared type', () => {
    expect(sniffVideoHeader(Buffer.concat([WEBM, Buffer.from('rest')]))).toBe('video/webm');
    expect(sniffVideoHeader(Buffer.from('\0\0\0\x18ftypmp42'))).toBe('video/mp4');
    expect(sniffVideoHeader(Buffer.from('cluster bytes'))).toBeNull();
    expect(segmentMime('video/webm;codecs=vp9', null)).toBe('video/webm');
    expect(segmentMime('video/mp4', WEBM)).toBeNull();
    expect(segmentMime('text/plain', null)).toBeNull();
  });
});

describe('signed playback', () => {
  it('plays each recorder part with ranges until the joined file is ready', async () => {
    const { media, storage } = service();
    // Two recorder instances: each part starts with its own header. Part 2 lost its first segment.
    const a = assetWith(
      [
        { idx: 0, part: 0, header: true, body: Buffer.concat([WEBM, Buffer.from('p0-a')]) },
        { idx: 1, part: 0, header: false, body: Buffer.from('p0-b') },
        { idx: 2, part: 1, header: true, body: Buffer.concat([WEBM, Buffer.from('p1-a')]) },
        { idx: 4, part: 2, header: false, body: Buffer.from('p2-b') },
      ],
      storage.objects,
    );
    vi.spyOn(MediaAssetModel, 'findById').mockReturnValue(query(a));
    const link = PlaybackUrl.parse(media.playbackUrl(a));
    expect(link.source).toBe('PARTS');
    expect(link.parts).toHaveLength(2);
    expect(link.url).toBe(link.parts[0]);
    // Links now last 30 minutes (the player refreshes them after that).
    expect(Date.parse(link.expiresAt) - NOW.getTime()).toBe(30 * 60_000);
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] });

    const app = playbackApp(media);
    const whole = await binary(request(app).get(link.parts[0]!)).expect(200);
    expect(whole.headers['accept-ranges']).toBe('bytes');
    expect(
      Buffer.compare(whole.body as Buffer, Buffer.concat([WEBM, Buffer.from('p0-ap0-b')])),
    ).toBe(0);
    const ranged = await binary(request(app).get(link.parts[0]!).set('Range', 'bytes=6-9')).expect(
      206,
    );
    expect(ranged.headers['content-range']).toBe('bytes 6-9/12');
    expect((ranged.body as Buffer).toString()).toBe('-ap0');
    await request(app).get(link.parts[1]!).set('Range', 'bytes=50-').expect(416);
    // The signature covers the part: another part number is refused.
    await request(app).get(link.parts[1]!.replace('part=1', 'part=0')).expect(403);
    vi.useRealTimers();
  });

  it('serves the joined file with ranges once it is ready, and fails cleanly on storage errors', async () => {
    const { media, storage } = service();
    const file = Buffer.from('0123456789abcdef');
    const a = assetWith([{ idx: 0, header: true, body: WEBM }], storage.objects, {
      playbackFile: {
        status: 'READY',
        key: 'media/u/s/a/recording.webm',
        bytes: file.length,
        at: NOW,
        attempts: 1,
        error: null,
      },
    });
    storage.objects.set('media/u/s/a/recording.webm', { body: file, contentType: 'video/webm' });
    vi.spyOn(MediaAssetModel, 'findById').mockReturnValue(query(a));
    const link = media.playbackUrl(a);
    expect(link).toMatchObject({ source: 'FILE', parts: [link.url] });
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
    const app = playbackApp(media);

    const tail = await binary(request(app).get(link.url).set('Range', 'bytes=-4')).expect(206);
    expect(tail.headers['content-range']).toBe('bytes 12-15/16');
    expect((tail.body as Buffer).toString()).toBe('cdef');

    // Storage down before anything was sent: a clean 503.
    const getRange = vi.spyOn(storage.storage, 'getRange');
    getRange.mockRejectedValueOnce(new Error('storage down'));
    await request(app).get(link.url).expect(503);
    vi.useRealTimers();
  });

  it('breaks the response when storage fails after the headers went out', async () => {
    const { media, storage } = service();
    const a = assetWith(
      [
        { idx: 0, header: true, body: Buffer.concat([WEBM, Buffer.from('first')]) },
        { idx: 1, body: Buffer.from('second') },
      ],
      storage.objects,
    );
    vi.spyOn(MediaAssetModel, 'findById').mockReturnValue(query(a));
    const warn = vi.spyOn(logger, 'warn');
    const link = media.playbackUrl(a);
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
    const getRange = vi.spyOn(storage.storage, 'getRange');
    getRange.mockImplementationOnce(async () => Buffer.concat([WEBM, Buffer.from('first')]));
    getRange.mockRejectedValueOnce(new Error('storage down'));
    const failed = await request(playbackApp(media))
      .get(link.url)
      .then(
        () => null,
        (err: unknown) => err,
      );
    // The client sees a truncated response, never a "complete" short file.
    expect(failed).toBeInstanceOf(Error);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ assetId: String(a._id) }),
      'recording playback failed mid-stream',
    );
    vi.useRealTimers();
  });
});

describe('segment uploads racing a delete', () => {
  it('removes the stored object and refuses the segment when the recording was deleted meanwhile', async () => {
    const { media, storage } = service();
    const userId = String(new mongoose.Types.ObjectId());
    const session = {
      _id: new mongoose.Types.ObjectId(),
      userId,
      state: 'ACTIVE',
      recording: { enabled: true },
      consents: [],
    };
    const before = assetWith([], storage.objects);
    vi.spyOn(InterviewSessionModel, 'findOne').mockReturnValue(query(session));
    vi.spyOn(MediaAssetModel, 'findOneAndUpdate')
      .mockReturnValueOnce(query(before)) // the upsert: still NONE
      .mockReturnValueOnce(query(null)); // the push: refused, a delete began meanwhile
    vi.spyOn(MediaAssetModel, 'findById').mockReturnValue(
      query({ ...before, deletion: { ...before.deletion, status: 'DELETING' } }),
    );
    const del = vi.spyOn(storage.storage, 'delete');
    const err = await media
      .uploadSegment(userId, String(session._id), 0, WEBM, 'video/webm', 0)
      .catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 409, code: 'INVALID_STATE' });
    expect(del).toHaveBeenCalledTimes(1);
    expect([...storage.objects.keys()]).toEqual([]);
  });
});

describe('integrity observations', () => {
  it('reserves a slot with one capped increment instead of counting events', async () => {
    const { media } = service();
    const userId = String(new mongoose.Types.ObjectId());
    const sessionId = new mongoose.Types.ObjectId();
    vi.spyOn(InterviewSessionModel, 'findOne').mockReturnValue(
      query({ _id: sessionId, live: true, consents: [{ type: 'INTEGRITY', accepted: true }] }),
    );
    const count = vi.spyOn(IntegrityEventModel, 'countDocuments');
    const reserve = vi
      .spyOn(InterviewSessionModel, 'updateOne')
      .mockResolvedValueOnce({ modifiedCount: 1 } as never)
      .mockResolvedValueOnce({ modifiedCount: 0 } as never);
    const create = vi.spyOn(IntegrityEventModel, 'create').mockResolvedValue([] as never);
    const payload = {
      sessionId: String(sessionId),
      type: 'TAB_HIDDEN' as const,
      at: NOW.toISOString(),
    };

    expect(await media.recordIntegrity(userId, payload)).toBe(true);
    // Full: nothing more is stored.
    expect(await media.recordIntegrity(userId, payload)).toBe(false);
    expect(create).toHaveBeenCalledTimes(1);
    expect(count).not.toHaveBeenCalled();
    expect(reserve.mock.calls[0]![0]).toEqual({
      _id: sessionId,
      integrityEventCount: { $not: { $gte: MAX_INTEGRITY_EVENTS } },
    });
    expect(reserve.mock.calls[0]![1]).toEqual({ $inc: { integrityEventCount: 1 } });
  });
});

import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { Logger } from '@cbi/config';
import {
  deleteMediaAsset,
  finalizeMediaAsset,
  IntegrityEventModel,
  InterviewSessionModel,
  MediaAssetModel,
  mediaPrefix,
  missingSegments,
  UserModel,
  type InterviewSessionRecord,
  type MediaAssetRecord,
} from '@cbi/db';
import type { StorageProvider } from '@cbi/provider-adapters';
import {
  MAX_INTEGRITY_EVENTS,
  MEDIA_LIMITS,
  type AdminIntegrityEvent,
  type AdminMediaAsset,
  type AdminMediaQuery,
  type FinalizeMediaBody,
  type IntegrityEventPayload,
  type MediaAssetSummary,
  type MediaMime,
  type PlaybackUrl,
  type SegmentUploadResult,
} from '@cbi/shared-types';
import type { Response } from 'express';
import type { AuditService } from '../../lib/audit.js';
import { AppError } from '../../lib/errors.js';
import { iso, objectId } from '../../lib/ids.js';
import type { ClientContext } from '../../lib/request-context.js';

type Session = InterviewSessionRecord;

/** States in which segments may arrive: live, or finished within the upload grace period. */
const RECORDING_STATES = new Set(['ACTIVE', 'ROUND_TRANSITION', 'RECONNECTING', 'PAUSED']);
const ENDED_STATES = new Set(['COMPLETING', 'PROCESSING', 'REPORT_READY', 'EXPIRED', 'FAILED']);

export const mediaSummary = (a: MediaAssetRecord): MediaAssetSummary => ({
  id: String(a._id),
  sessionId: String(a.sessionId),
  kind: a.kind,
  mimeType: a.mimeType,
  status: a.status,
  segmentCount: a.segments.length,
  expectedSegments: a.expectedSegments,
  missingSegments: a.deletion.status === 'DELETED' ? [] : missingSegments(a),
  bytes: a.bytes,
  durationMs: a.durationMs,
  retentionExpiresAt: iso(a.retentionExpiresAt),
  deletion: {
    status: a.deletion.status,
    at: a.deletion.at ? iso(a.deletion.at) : null,
    reason: a.deletion.reason,
  },
  createdAt: iso(a.createdAt),
});

/** The container, from the declared type and (for the first segment) the bytes. */
export function segmentMime(
  contentType: string | undefined,
  first: Buffer | null,
): MediaMime | null {
  const declared = (contentType ?? '').split(';')[0]!.trim().toLowerCase();
  if (declared !== 'video/webm' && declared !== 'video/mp4') return null;
  if (first) {
    const webm = first.length >= 4 && first.readUInt32BE(0) === 0x1a45dfa3;
    const mp4 = first.length >= 8 && first.subarray(4, 8).toString('latin1') === 'ftyp';
    if (declared === 'video/webm' ? !webm : !mp4) return null;
  }
  return declared;
}

interface Deps {
  storage: StorageProvider;
  audit: AuditService;
  logger: Logger;
  retentionDays: number;
  /** Secret for signed playback links. */
  signingSecret: string;
  now?: () => Date;
}

export function createMediaService(deps: Deps) {
  const { storage, audit, logger } = deps;
  const now = deps.now ?? (() => new Date());

  async function own(userId: string, sessionId: string) {
    const s = await InterviewSessionModel.findOne({
      _id: objectId(sessionId, 'Interview'),
      userId,
    }).lean<Session>();
    if (!s) throw AppError.notFound('Interview not found');
    return s;
  }

  function assertCanRecord(s: Session) {
    if (!s.recording?.enabled) {
      throw new AppError(409, 'INVALID_STATE', 'This interview is not being recorded.');
    }
    const at = now().getTime();
    const endedAt = s.endedAt ? new Date(s.endedAt).getTime() : null;
    const withinGrace =
      ENDED_STATES.has(s.state) && endedAt !== null && at - endedAt <= MEDIA_LIMITS.uploadGraceMs;
    if (!RECORDING_STATES.has(s.state) && !withinGrace) {
      throw new AppError(409, 'INVALID_STATE', 'Recording uploads are closed for this interview.');
    }
  }

  const signature = (assetId: string, exp: number) =>
    createHmac('sha256', deps.signingSecret)
      .update(`media-play:${assetId}:${exp}`)
      .digest('base64url');

  function playbackUrl(a: MediaAssetRecord): PlaybackUrl {
    const exp = Math.floor(now().getTime() / 1000) + MEDIA_LIMITS.playbackTtlSec;
    const id = String(a._id);
    return {
      url: `/api/v1/media/play/${id}?exp=${exp}&sig=${signature(id, exp)}`,
      expiresAt: new Date(exp * 1000).toISOString(),
      mimeType: a.mimeType,
    };
  }

  function playable(a: MediaAssetRecord | null): a is MediaAssetRecord {
    return Boolean(a && a.deletion.status === 'NONE' && a.segments.length > 0);
  }

  async function decorate(rows: MediaAssetRecord[]): Promise<AdminMediaAsset[]> {
    const [users, sessions] = await Promise.all([
      UserModel.find({ _id: { $in: rows.map((r) => r.userId) } }, { primaryEmail: 1 }).lean(),
      InterviewSessionModel.find(
        { _id: { $in: rows.map((r) => r.sessionId) } },
        { 'analysis.detectedRole.title': 1 },
      ).lean<Pick<Session, '_id' | 'analysis'>[]>(),
    ]);
    const email = new Map(
      users.map((u) => [
        String(u._id),
        (u as { primaryEmail?: string | null }).primaryEmail ?? null,
      ]),
    );
    const title = new Map(
      sessions.map((s) => [String(s._id), s.analysis?.detectedRole.title ?? null]),
    );
    return rows.map((r) => ({
      ...mediaSummary(r),
      userId: String(r.userId),
      userEmail: email.get(String(r.userId)) ?? null,
      interviewTitle: title.get(String(r.sessionId)) ?? null,
    }));
  }

  return {
    playbackUrl,

    /**
     * Stores one recorded segment. Idempotent by index: a retry with the same
     * bytes is acknowledged as a duplicate. A storage failure answers 503 so
     * the browser keeps the segment and retries; it never affects the interview.
     */
    async uploadSegment(
      userId: string,
      sessionId: string,
      idx: number,
      body: Buffer,
      contentType: string | undefined,
    ): Promise<SegmentUploadResult> {
      if (!Number.isInteger(idx) || idx < 0 || idx >= MEDIA_LIMITS.maxSegments) {
        throw AppError.validation('Invalid segment index.');
      }
      if (!segmentMime(contentType, null)) {
        throw new AppError(
          415,
          'UNSUPPORTED_MEDIA_TYPE',
          'This recording format is not supported.',
        );
      }
      if (body.length === 0) throw AppError.validation('Empty segment.');
      const s = await own(userId, sessionId);
      assertCanRecord(s);
      const mime = segmentMime(contentType, idx === 0 ? body : null);
      if (!mime) {
        throw new AppError(
          415,
          'UNSUPPORTED_MEDIA_TYPE',
          'This recording format is not supported.',
        );
      }
      const sha256 = createHash('sha256').update(body).digest('hex');
      const recordingConsent = (s.consents ?? []).find((c) => c.type === 'RECORDING' && c.accepted);
      let asset = await MediaAssetModel.findOneAndUpdate(
        { sessionId: s._id, kind: 'CANDIDATE_VIDEO' },
        {
          $setOnInsert: {
            sessionId: s._id,
            userId: s.userId,
            kind: 'CANDIDATE_VIDEO',
            mimeType: mime,
            status: 'RECORDING',
            retentionExpiresAt: new Date(now().getTime() + deps.retentionDays * 86_400_000),
            consentId: recordingConsent?.consentTextId ?? null,
          },
        },
        { upsert: true, returnDocument: 'after' },
      ).lean<MediaAssetRecord>();
      if (!asset || asset.deletion.status === 'DELETED') {
        throw new AppError(409, 'INVALID_STATE', 'This recording was deleted.');
      }
      if (asset.mimeType !== mime) {
        throw new AppError(409, 'CONFLICT', 'Segments must all use the same format.');
      }
      const existing = asset.segments.find((x) => x.idx === idx);
      if (existing) {
        if (existing.sha256 !== sha256)
          throw new AppError(
            409,
            'CONFLICT',
            'A different segment with this index was already stored.',
          );
        return {
          index: idx,
          bytes: existing.bytes,
          duplicate: true,
          received: asset.segments.length,
        };
      }
      if (asset.bytes + body.length > MEDIA_LIMITS.maxAssetBytes) {
        throw new AppError(413, 'PAYLOAD_TOO_LARGE', 'The recording is too large.');
      }
      const ext = mime === 'video/mp4' ? 'mp4' : 'webm';
      const storageKey = `${mediaPrefix(asset)}/seg-${String(idx).padStart(5, '0')}.${ext}`;
      try {
        await storage.put(storageKey, body, mime);
      } catch (err) {
        logger.warn({ err, sessionId, idx }, 'recording segment upload failed');
        throw new AppError(
          503,
          'PROVIDER_UNAVAILABLE',
          'The segment could not be stored. Retry later.',
        );
      }
      const updated = await MediaAssetModel.findOneAndUpdate(
        { _id: asset._id, 'segments.idx': { $ne: idx }, 'deletion.status': 'NONE' },
        {
          $push: {
            segments: { idx, storageKey, bytes: body.length, sha256, uploadedAt: now() },
          },
          $inc: { bytes: body.length },
        },
        { returnDocument: 'after' },
      ).lean<MediaAssetRecord>();
      if (!updated) {
        // A concurrent retry stored it first.
        asset = (await MediaAssetModel.findById(asset._id).lean<MediaAssetRecord>())!;
        return { index: idx, bytes: body.length, duplicate: true, received: asset.segments.length };
      }
      // A late segment for an already-finalized recording: re-evaluate (it may now be complete).
      if (updated.status !== 'RECORDING')
        await finalizeMediaAsset(updated._id, storage, { now: now() });
      return {
        index: idx,
        bytes: body.length,
        duplicate: false,
        received: updated.segments.length,
      };
    },

    /** The browser's recording ended: close the asset (COMPLETE, PARTIAL or FAILED). */
    async finalize(userId: string, sessionId: string, body: FinalizeMediaBody) {
      const s = await own(userId, sessionId);
      if (!s.recording?.enabled) {
        throw new AppError(409, 'INVALID_STATE', 'This interview is not being recorded.');
      }
      let asset = await MediaAssetModel.findOne({
        sessionId: s._id,
        kind: 'CANDIDATE_VIDEO',
      }).lean();
      if (!asset) {
        if (body.segmentCount === 0) return null;
        // Every upload failed: keep a record so the failure is visible (the interview is unaffected).
        asset = await MediaAssetModel.findOneAndUpdate(
          { sessionId: s._id, kind: 'CANDIDATE_VIDEO' },
          {
            $setOnInsert: {
              sessionId: s._id,
              userId: s.userId,
              kind: 'CANDIDATE_VIDEO',
              mimeType: 'video/webm',
              status: 'RECORDING',
              retentionExpiresAt: new Date(now().getTime() + deps.retentionDays * 86_400_000),
            },
          },
          { upsert: true, returnDocument: 'after' },
        ).lean();
        if (!asset) return null;
      }
      const done = await finalizeMediaAsset(asset._id, storage, {
        expectedSegments: body.segmentCount,
        durationMs: body.durationMs,
        now: now(),
      });
      return done ? mediaSummary(done) : null;
    },

    async mine(userId: string, sessionId: string) {
      const s = await own(userId, sessionId);
      const a = await MediaAssetModel.findOne({ sessionId: s._id, kind: 'CANDIDATE_VIDEO' }).lean();
      return a ? mediaSummary(a) : null;
    },

    async myPlayback(userId: string, sessionId: string) {
      const s = await own(userId, sessionId);
      const a = await MediaAssetModel.findOne({ sessionId: s._id, kind: 'CANDIDATE_VIDEO' }).lean();
      if (!playable(a)) throw AppError.notFound('Recording not found');
      return playbackUrl(a);
    },

    /** The candidate deletes their own recording (any time). */
    async deleteMine(userId: string, sessionId: string, ctx: ClientContext) {
      const s = await own(userId, sessionId);
      const a = await MediaAssetModel.findOne({ sessionId: s._id, kind: 'CANDIDATE_VIDEO' }).lean();
      if (!a) throw AppError.notFound('Recording not found');
      const deleted = await deleteMediaAsset(a._id, storage, {
        reason: 'Deleted by the candidate',
        by: `user:${userId}`,
        now: now(),
      }).catch((err: unknown) => {
        logger.error({ err, assetId: String(a._id) }, 'recording delete failed');
        throw new AppError(
          503,
          'PROVIDER_UNAVAILABLE',
          'The recording could not be deleted. Try again.',
        );
      });
      if (deleted) {
        await audit.record(
          {
            actorType: 'USER',
            actorId: userId,
            action: 'media.deleted',
            resourceType: 'mediaAsset',
            resourceId: String(a._id),
            details: { sessionId },
          },
          ctx,
        );
      }
      return mediaSummary((await MediaAssetModel.findById(a._id).lean())!);
    },

    /** Streams the recording (segments in order) for a valid signed link. */
    async stream(assetId: string, exp: string, sig: string, res: Response) {
      const expNum = Number(exp);
      const expected = Buffer.from(signature(assetId, expNum));
      const given = Buffer.from(String(sig));
      if (
        !Number.isInteger(expNum) ||
        expNum * 1000 < now().getTime() ||
        expected.length !== given.length ||
        !timingSafeEqual(expected, given)
      ) {
        throw AppError.forbidden('This playback link is invalid or has expired.');
      }
      const a = await MediaAssetModel.findById(objectId(assetId, 'Recording')).lean();
      if (!playable(a)) throw AppError.notFound('Recording not found');
      res.set({
        'Content-Type': a.mimeType,
        'Cache-Control': 'private, no-store',
        'Content-Disposition': 'inline',
        'X-Content-Type-Options': 'nosniff',
      });
      // MediaRecorder segments are one continuous stream: in order, they form a playable file.
      for (const seg of [...a.segments].sort((x, y) => x.idx - y.idx)) {
        const chunk = await storage.get(seg.storageKey);
        if (!res.write(chunk)) await new Promise<void>((resolve) => res.once('drain', resolve));
      }
      res.end();
    },

    // ---- Integrity observations --------------------------------------------------------------

    /** Stores one observation when the interview tracks them and the candidate acknowledged it. */
    async recordIntegrity(userId: string, payload: IntegrityEventPayload): Promise<boolean> {
      const s = await InterviewSessionModel.findOne(
        { _id: objectId(payload.sessionId, 'Interview'), userId },
        { state: 1, templateId: 1, consents: 1, live: 1 },
      ).lean<Session>();
      if (!s || !s.live) return false;
      if (!(s.consents ?? []).some((c) => c.type === 'INTEGRITY' && c.accepted)) return false;
      const count = await IntegrityEventModel.countDocuments({ sessionId: s._id });
      if (count >= MAX_INTEGRITY_EVENTS) return false;
      await IntegrityEventModel.create({
        sessionId: s._id,
        userId,
        type: payload.type,
        at: now(),
        clientAt: new Date(payload.at),
        value: payload.value ?? null,
      });
      return true;
    },

    // ---- Admin -------------------------------------------------------------------------------

    async adminList(query: AdminMediaQuery) {
      const filter: Record<string, unknown> = {};
      if (query.status) filter.status = query.status;
      if (query.deletion) filter['deletion.status'] = query.deletion;
      if (query.q) {
        const q = query.q;
        const ids = /^[0-9a-f]{24}$/i.test(q) ? [{ sessionId: q }, { userId: q }, { _id: q }] : [];
        const users = q.includes('@')
          ? await UserModel.find({ primaryEmail: q.toLowerCase() }, { _id: 1 }).lean()
          : [];
        filter.$or = [...ids, { userId: { $in: users.map((u) => u._id) } }];
      }
      const rows = await MediaAssetModel.find(filter)
        .sort({ createdAt: -1 })
        .limit(query.limit)
        .lean<MediaAssetRecord[]>();
      return decorate(rows);
    },

    async adminGet(assetId: string) {
      const a = await MediaAssetModel.findById(
        objectId(assetId, 'Recording'),
      ).lean<MediaAssetRecord>();
      if (!a) throw AppError.notFound('Recording not found');
      return (await decorate([a]))[0]!;
    },

    /** A signed link for an admin; every issue is audited. */
    async adminPlayback(assetId: string, actorId: string, ctx: ClientContext) {
      const a = await MediaAssetModel.findById(
        objectId(assetId, 'Recording'),
      ).lean<MediaAssetRecord>();
      if (!playable(a)) throw AppError.notFound('Recording not found');
      await audit.record(
        {
          actorType: 'ADMIN',
          actorId,
          action: 'media.playback',
          resourceType: 'mediaAsset',
          resourceId: assetId,
          details: { sessionId: String(a.sessionId), userId: String(a.userId) },
        },
        ctx,
      );
      return playbackUrl(a);
    },

    async adminPurge(assetId: string, reason: string, actorId: string, ctx: ClientContext) {
      const a = await MediaAssetModel.findById(
        objectId(assetId, 'Recording'),
      ).lean<MediaAssetRecord>();
      if (!a) throw AppError.notFound('Recording not found');
      if (a.deletion.status === 'DELETED') {
        throw new AppError(409, 'INVALID_STATE', 'This recording was already deleted.');
      }
      // Audit first: a purge that cannot be audited must not happen.
      await audit.record(
        {
          actorType: 'ADMIN',
          actorId,
          action: 'media.purged',
          resourceType: 'mediaAsset',
          resourceId: assetId,
          details: { reason, sessionId: String(a.sessionId), segments: a.segments.length },
        },
        ctx,
      );
      await deleteMediaAsset(a._id, storage, { reason, by: `admin:${actorId}`, now: now() }).catch(
        (err: unknown) => {
          logger.error({ err, assetId }, 'recording purge failed');
          throw new AppError(
            503,
            'PROVIDER_UNAVAILABLE',
            'The recording could not be deleted. Try again.',
          );
        },
      );
      return (
        await decorate([(await MediaAssetModel.findById(a._id).lean<MediaAssetRecord>())!])
      )[0]!;
    },

    async adminIntegrity(sessionId: string): Promise<AdminIntegrityEvent[]> {
      const s = await InterviewSessionModel.findById(objectId(sessionId, 'Interview'), {
        startedAt: 1,
      }).lean<Session>();
      if (!s) throw AppError.notFound('Interview not found');
      const start = s.startedAt ? new Date(s.startedAt).getTime() : null;
      const rows = await IntegrityEventModel.find({ sessionId: s._id }).sort({ at: 1 }).lean();
      return rows.map((e) => ({
        type: e.type,
        at: iso(e.at),
        offsetSec: start === null ? 0 : Math.max(0, Math.round((e.at.getTime() - start) / 1000)),
        value: e.value,
      }));
    },
  };
}

export type MediaService = ReturnType<typeof createMediaService>;

import type { Readable } from 'node:stream';
import {
  CampaignModel,
  identityImageKey,
  IdentityCaptureModel,
  InterviewSessionModel,
  type CampaignApplicationRecord,
  type IdentityCaptureRecord,
  type InterviewSessionRecord,
} from '@cbi/db';
import { StorageNotFoundError, type StorageProvider } from '@cbi/provider-adapters';
import {
  IDENTITY_IMAGE_MAX_BYTES,
  type IdentityCaptureStatus,
  type IdentityImageKind,
  type IdentityReview,
  type IdentityReviewBody,
} from '@cbi/shared-types';
import type { AuditService } from '../../lib/audit.js';
import { AppError } from '../../lib/errors.js';
import { iso, objectId } from '../../lib/ids.js';
import type { ClientContext } from '../../lib/request-context.js';

/**
 * Lightweight identity check for organisations' campaigns. With the
 * candidate's IDENTITY_CAPTURE consent, the browser captures a selfie and a
 * photo of an ID before the interview (and, in video interviews, one frame
 * from the camera during it). Reviewers compare them by eye and mark the
 * capture verified or a mismatch. There is deliberately no automated face
 * matching (see docs/architecture/org-portal.md#identity-check).
 */

const PRE_START = new Set(['READY', 'DEVICE_CHECK', 'CONSENT_REQUIRED', 'READY_TO_START']);
const LIVE = new Set(['ACTIVE', 'ROUND_TRANSITION', 'RECONNECTING', 'PAUSED']);

const IMAGE_TYPES = {
  'image/jpeg': (b: Buffer) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  'image/png': (b: Buffer) =>
    b.length > 8 &&
    b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
} as const;
type ImageType = keyof typeof IMAGE_TYPES;

/** Checks the declared type against the file's magic bytes (never trust the header alone). */
export function imageType(contentType: string | undefined, body: Buffer): ImageType | null {
  const type = (contentType ?? '').split(';')[0]!.trim().toLowerCase();
  if (!(type in IMAGE_TYPES)) return null;
  return IMAGE_TYPES[type as ImageType](body) ? (type as ImageType) : null;
}

export function captureStatus(
  capture: Pick<IdentityCaptureRecord, 'images'> | null,
): IdentityCaptureStatus {
  const selfie = Boolean(capture?.images.SELFIE);
  const idDocument = Boolean(capture?.images.ID_DOCUMENT);
  return { required: true, selfie, idDocument, complete: selfie && idDocument };
}

const KIND_PATH: Record<IdentityImageKind, string> = {
  SELFIE: 'selfie',
  ID_DOCUMENT: 'id-document',
  INTERVIEW_FRAME: 'interview-frame',
};

export function kindFromPath(value: string): IdentityImageKind {
  const kind = (Object.keys(KIND_PATH) as IdentityImageKind[]).find((k) => KIND_PATH[k] === value);
  if (!kind) throw AppError.notFound('Image not found');
  return kind;
}

export function createIdentityService(deps: {
  storage: StorageProvider;
  audit: AuditService;
  retentionDays: number;
  now?: () => Date;
}) {
  const now = deps.now ?? (() => new Date());

  async function campaignOf(s: Pick<InterviewSessionRecord, 'campaignId'>) {
    if (!s.campaignId) return null;
    return CampaignModel.findById(s.campaignId, { idCapture: 1, orgId: 1 }).lean();
  }

  return {
    /** The candidate's capture status; null when the interview does not ask for one. */
    async statusFor(s: InterviewSessionRecord): Promise<IdentityCaptureStatus | null> {
      const campaign = await campaignOf(s);
      if (!campaign?.idCapture) return null;
      const capture = await IdentityCaptureModel.findOne(
        { sessionId: s._id, deletedAt: null },
        { images: 1 },
      ).lean<IdentityCaptureRecord>();
      return captureStatus(capture);
    },

    /**
     * Stores one image. Selfie and ID before the interview starts; the
     * interview frame once, while it runs (video only). Needs the accepted
     * IDENTITY_CAPTURE consent.
     */
    async upload(
      userId: string,
      sessionId: string,
      kind: IdentityImageKind,
      body: Buffer,
      contentType: string | undefined,
      ctx: ClientContext,
    ): Promise<IdentityCaptureStatus> {
      const s = await InterviewSessionModel.findOne({
        _id: objectId(sessionId, 'Interview'),
        userId,
      }).lean<InterviewSessionRecord>();
      if (!s) throw AppError.notFound('Interview not found');
      const campaign = await campaignOf(s);
      if (!campaign?.idCapture) throw AppError.notFound('Identity capture is not used here');
      const consent = (s.consents ?? []).find((c) => c.type === 'IDENTITY_CAPTURE');
      if (!consent?.accepted) {
        throw new AppError(409, 'INVALID_STATE', 'Agree to the identity capture notice first.');
      }
      if (kind === 'INTERVIEW_FRAME') {
        if (!LIVE.has(s.state) || s.mode !== 'VIDEO') {
          throw new AppError(
            409,
            'INVALID_STATE',
            'The interview frame is taken during a video interview.',
          );
        }
      } else if (!PRE_START.has(s.state)) {
        throw new AppError(409, 'INVALID_STATE', 'Photos are taken before the interview starts.');
      }
      if (body.length === 0 || body.length > IDENTITY_IMAGE_MAX_BYTES) {
        throw new AppError(413, 'PAYLOAD_TOO_LARGE', 'The photo must be smaller than 2 MB.');
      }
      const mimeType = imageType(contentType, body);
      if (!mimeType) {
        throw new AppError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Upload a JPEG or PNG photo.');
      }
      const existing = await IdentityCaptureModel.findOne({ sessionId: s._id }).lean();
      // One frame per interview: later ones are ignored (the first is what reviewers compare).
      if (kind === 'INTERVIEW_FRAME' && existing?.images.INTERVIEW_FRAME) {
        return captureStatus(existing);
      }
      const at = now();
      const storageKey = identityImageKey({ userId, sessionId: s._id }, kind, mimeType);
      await deps.storage.put(storageKey, body, mimeType);
      const updated = await IdentityCaptureModel.findOneAndUpdate(
        { sessionId: s._id },
        {
          $set: {
            [`images.${kind}`]: { storageKey, mimeType, bytes: body.length, at },
            // A new photo after a review asks for a new review.
            ...(kind !== 'INTERVIEW_FRAME' ? { decision: null } : {}),
            deletedAt: null,
            retentionExpiresAt: new Date(at.getTime() + deps.retentionDays * 24 * 3600_000),
          },
          $setOnInsert: {
            userId: s.userId,
            campaignId: s.campaignId,
            orgId: campaign.orgId ?? null,
            consentTextId: consent.consentTextId,
            ...(kind === 'INTERVIEW_FRAME' ? { decision: null } : {}),
          },
        },
        // Defaults would clash with the nested image path being set.
        { upsert: true, returnDocument: 'after', setDefaultsOnInsert: false },
      ).lean<IdentityCaptureRecord>();
      await deps.audit.record(
        {
          actorType: 'USER',
          actorId: userId,
          action: 'identity.captured',
          resourceType: 'interviewSession',
          resourceId: sessionId,
          details: { kind, bytes: body.length },
        },
        ctx,
      );
      return captureStatus(updated);
    },

    // ---- Reviewers (the caller has already checked the application belongs to the organisation)

    async review(
      application: Pick<CampaignApplicationRecord, '_id' | 'sessionId' | 'campaignId'>,
    ): Promise<IdentityReview | null> {
      const capture = await IdentityCaptureModel.findOne({
        sessionId: application.sessionId,
      }).lean<IdentityCaptureRecord>();
      if (!capture) return null;
      const base = `/org/campaigns/${String(application.campaignId)}/candidates/${String(application._id)}/identity`;
      const path = (kind: IdentityImageKind) =>
        capture.images[kind] && !capture.deletedAt ? `${base}/${KIND_PATH[kind]}` : null;
      const status = capture.decision
        ? capture.decision.decision
        : capture.images.SELFIE && capture.images.ID_DOCUMENT && !capture.deletedAt
          ? 'CAPTURED'
          : 'NONE';
      return {
        status,
        imagePaths: {
          selfie: path('SELFIE'),
          idDocument: path('ID_DOCUMENT'),
          interviewFrame: path('INTERVIEW_FRAME'),
        },
        capturedAt: capture.images.SELFIE ? iso(capture.images.SELFIE.at) : null,
        retentionExpiresAt: capture.deletedAt ? null : iso(capture.retentionExpiresAt),
        decision: capture.decision
          ? {
              decision: capture.decision.decision,
              note: capture.decision.note,
              by: String(capture.decision.by),
              at: iso(capture.decision.at),
            }
          : null,
      };
    },

    /** Streams one image to a reviewer; every view is audited (it is personal data). */
    async openImage(
      application: Pick<CampaignApplicationRecord, '_id' | 'sessionId' | 'campaignId'>,
      kind: IdentityImageKind,
      actor: { userId: string; orgId: string },
      ctx: ClientContext,
    ): Promise<{ stream: Readable; mimeType: string }> {
      const capture = await IdentityCaptureModel.findOne({
        sessionId: application.sessionId,
        deletedAt: null,
      }).lean<IdentityCaptureRecord>();
      const image = capture?.images[kind];
      if (!image) throw AppError.notFound('Image not found');
      let stream: Readable;
      try {
        stream = await deps.storage.getStream(image.storageKey);
      } catch (err) {
        if (err instanceof StorageNotFoundError) throw AppError.notFound('Image not found');
        throw err;
      }
      await deps.audit.record(
        {
          actorType: 'ORG_MEMBER',
          actorId: actor.userId,
          action: 'org.identity_viewed',
          resourceType: 'campaignApplication',
          resourceId: String(application._id),
          details: { orgId: actor.orgId, kind },
        },
        ctx,
      );
      return { stream, mimeType: image.mimeType };
    },

    async decide(
      application: Pick<CampaignApplicationRecord, '_id' | 'sessionId'>,
      body: IdentityReviewBody,
      actor: { userId: string; orgId: string },
      ctx: ClientContext,
    ) {
      const updated = await IdentityCaptureModel.findOneAndUpdate(
        {
          sessionId: application.sessionId,
          deletedAt: null,
          'images.SELFIE': { $exists: true },
          'images.ID_DOCUMENT': { $exists: true },
        },
        {
          $set: {
            decision: {
              decision: body.decision,
              note: body.note,
              by: objectId(actor.userId, 'User'),
              at: now(),
            },
          },
        },
        { returnDocument: 'after' },
      ).lean();
      if (!updated)
        throw new AppError(409, 'INVALID_STATE', 'There is no complete capture to review.');
      await deps.audit.record(
        {
          actorType: 'ORG_MEMBER',
          actorId: actor.userId,
          action: 'org.identity_reviewed',
          resourceType: 'campaignApplication',
          resourceId: String(application._id),
          details: { orgId: actor.orgId, decision: body.decision },
        },
        ctx,
      );
    },
  };
}

export type IdentityService = ReturnType<typeof createIdentityService>;

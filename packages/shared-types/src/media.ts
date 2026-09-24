import { z } from 'zod';

/**
 * Recordings and integrity observations (Phase 8).
 *
 * Video interviews can be recorded (template policy + the candidate's
 * RECORDING consent). The browser's MediaRecorder emits a segment every
 * `timesliceMs`; each is uploaded through the API to private storage,
 * idempotently by index. A failed or missing segment makes the recording
 * PARTIAL; it never fails the interview.
 */

export const MEDIA_LIMITS = {
  timesliceMs: 10_000,
  segmentMaxBytes: 8 * 1024 * 1024,
  maxSegments: 600,
  maxAssetBytes: 1024 * 1024 * 1024,
  /** Segments queued in the browser may still arrive this long after the interview ends. */
  uploadGraceMs: 30 * 60_000,
  /** Signed playback links expire after this long. */
  playbackTtlSec: 300,
} as const;

/** Containers MediaRecorder produces for video (Chrome/Firefox WebM, Safari MP4). */
export const MediaMime = z.enum(['video/webm', 'video/mp4']);
export type MediaMime = z.infer<typeof MediaMime>;

export const MediaKind = z.enum(['CANDIDATE_VIDEO']);
export type MediaKind = z.infer<typeof MediaKind>;

export const MediaStatus = z.enum([
  /** Segments are arriving. */
  'RECORDING',
  /** All expected segments were stored. */
  'COMPLETE',
  /** Some segments never arrived; the stored ones are kept. */
  'PARTIAL',
  /** Nothing usable was stored. */
  'FAILED',
]);
export type MediaStatus = z.infer<typeof MediaStatus>;

export const MediaDeletionStatus = z.enum(['NONE', 'DELETED']);
export type MediaDeletionStatus = z.infer<typeof MediaDeletionStatus>;

export const SegmentUploadResult = z.object({
  index: z.number().int(),
  bytes: z.number().int(),
  /** The same segment was already stored (a retry). */
  duplicate: z.boolean(),
  received: z.number().int(),
});
export type SegmentUploadResult = z.infer<typeof SegmentUploadResult>;

export const FinalizeMediaBody = z.object({
  /** Segments the browser produced (indexes 0 … n-1). */
  segmentCount: z.number().int().min(0).max(MEDIA_LIMITS.maxSegments),
  durationMs: z
    .number()
    .int()
    .min(0)
    .max(6 * 3600_000),
});
export type FinalizeMediaBody = z.infer<typeof FinalizeMediaBody>;

export const MediaAssetSummary = z.object({
  id: z.string(),
  sessionId: z.string(),
  kind: MediaKind,
  mimeType: MediaMime,
  status: MediaStatus,
  segmentCount: z.number().int(),
  expectedSegments: z.number().int().nullable(),
  missingSegments: z.array(z.number().int()),
  bytes: z.number().int(),
  durationMs: z.number().int().nullable(),
  retentionExpiresAt: z.iso.datetime(),
  deletion: z.object({
    status: MediaDeletionStatus,
    at: z.iso.datetime().nullable(),
    reason: z.string().nullable(),
  }),
  createdAt: z.iso.datetime(),
});
export type MediaAssetSummary = z.infer<typeof MediaAssetSummary>;

export const AdminMediaAsset = MediaAssetSummary.extend({
  userId: z.string(),
  userEmail: z.string().nullable(),
  interviewTitle: z.string().nullable(),
});
export type AdminMediaAsset = z.infer<typeof AdminMediaAsset>;

export const AdminMediaQuery = z.object({
  status: MediaStatus.optional(),
  deletion: MediaDeletionStatus.optional(),
  /** Session id, user id or exact email. */
  q: z.string().trim().max(120).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type AdminMediaQuery = z.infer<typeof AdminMediaQuery>;

/** A short-lived link a `<video>` element can use directly (no auth header). */
export const PlaybackUrl = z.object({
  url: z.string(),
  expiresAt: z.iso.datetime(),
  mimeType: MediaMime,
});
export type PlaybackUrl = z.infer<typeof PlaybackUrl>;

export const PurgeMediaBody = z.object({ reason: z.string().trim().min(3).max(300) });
export type PurgeMediaBody = z.infer<typeof PurgeMediaBody>;

// ---- Integrity observations -------------------------------------------------------------

/**
 * Browser events noted during an interview when the template tracks them and
 * the candidate acknowledged it. They are observations with innocent
 * explanations (a notification, a second screen) and are never scored or
 * used to label a candidate.
 */
export const IntegrityEventType = z.enum([
  'TAB_HIDDEN',
  'TAB_VISIBLE',
  'WINDOW_BLUR',
  'WINDOW_FOCUS',
  'FULLSCREEN_EXIT',
  'PASTE',
  'CAMERA_LOST',
  'MICROPHONE_LOST',
]);
export type IntegrityEventType = z.infer<typeof IntegrityEventType>;

/** `integrity:event` (client → server). */
export const IntegrityEventPayload = z.object({
  sessionId: z.string().min(1).max(64),
  type: IntegrityEventType,
  /** Client clock; the server also records its own receive time. */
  at: z.iso.datetime(),
  /** TAB_VISIBLE / WINDOW_FOCUS: how long the page was away; PASTE: characters pasted. */
  value: z
    .number()
    .int()
    .min(0)
    .max(24 * 3600_000)
    .optional(),
});
export type IntegrityEventPayload = z.infer<typeof IntegrityEventPayload>;

/** Most events stored per interview; more are counted but not kept. */
export const MAX_INTEGRITY_EVENTS = 500;

export const IntegritySummary = z.object({
  counts: z.partialRecord(IntegrityEventType, z.number().int()),
  /** Total time the interview page was hidden or unfocused. */
  awaySec: z.number().int(),
  /** Up to 50 events, seconds from the interview start. */
  timeline: z.array(z.object({ type: IntegrityEventType, offsetSec: z.number().int() })),
  /** Neutral wording shown with the observations. */
  note: z.string(),
});
export type IntegritySummary = z.infer<typeof IntegritySummary>;

export const INTEGRITY_NOTE =
  'These are browser events noted during the session. Most have ordinary explanations, such as a notification or a second screen. They are not part of the score.';

export const AdminIntegrityEvent = z.object({
  type: IntegrityEventType,
  at: z.iso.datetime(),
  offsetSec: z.number().int(),
  value: z.number().int().nullable(),
});
export type AdminIntegrityEvent = z.infer<typeof AdminIntegrityEvent>;

const RETURN_EVENTS = new Set<IntegrityEventType>(['TAB_VISIBLE', 'WINDOW_FOCUS']);

/**
 * Report summary of a session's observations. Away time uses the larger of
 * the tab-hidden and window-unfocused totals (switching tabs usually fires
 * both). The timeline lists when things happened, not the returns.
 */
export function summarizeIntegrity(
  events: readonly { type: IntegrityEventType; at: Date | string; value: number | null }[],
  startedAt: Date | string | null,
): IntegritySummary {
  const start = startedAt ? new Date(startedAt).getTime() : null;
  const counts: Partial<Record<IntegrityEventType, number>> = {};
  let hiddenMs = 0;
  let unfocusedMs = 0;
  for (const e of events) {
    counts[e.type] = (counts[e.type] ?? 0) + 1;
    if (e.type === 'TAB_VISIBLE') hiddenMs += e.value ?? 0;
    if (e.type === 'WINDOW_FOCUS') unfocusedMs += e.value ?? 0;
  }
  const timeline = events
    .filter((e) => !RETURN_EVENTS.has(e.type))
    .slice(0, 50)
    .map((e) => ({
      type: e.type,
      offsetSec:
        start === null ? 0 : Math.max(0, Math.round((new Date(e.at).getTime() - start) / 1000)),
    }));
  return {
    counts,
    awaySec: Math.round(Math.max(hiddenMs, unfocusedMs) / 1000),
    timeline,
    note: INTEGRITY_NOTE,
  };
}

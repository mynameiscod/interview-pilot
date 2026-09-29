import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import type {
  CandidateCompletedPayload,
  StageChangedPayload,
  WebhookEvent,
} from '@cbi/shared-types';
import type { ClientSession, Types } from 'mongoose';
import { CampaignApplicationModel, CampaignModel } from './models/campaign.js';
import { InterviewScoreModel } from './models/evaluation.js';
import { InterviewSessionModel } from './models/interview-session.js';
import {
  CampaignInviteModel,
  OrgWebhookModel,
  WebhookDeliveryModel,
  type WebhookDeliveryRecord,
} from './models/org.js';
import { UserProfileModel } from './models/user-profile.js';
import { UserModel } from './models/user.js';

/**
 * Organisation webhooks, delivered from an outbox: the API and the worker
 * write one `webhookDeliveries` record per subscribed webhook, and the
 * worker's dispatcher sends them, signing each attempt and retrying with
 * backoff. The body is fixed when the event happens, so every retry sends
 * the same bytes.
 */

/** Attempts before a delivery is given up (FAILED). */
export const WEBHOOK_MAX_ATTEMPTS = 8;

/** Delay before retry n (1-based): 30 s, 2 min, 10 min, 30 min, 1 h, 3 h, then 6 h. */
const BACKOFF_MS = [30_000, 120_000, 600_000, 1_800_000, 3_600_000, 10_800_000, 21_600_000];

export function webhookBackoffMs(attempt: number): number {
  return BACKOFF_MS[Math.min(Math.max(attempt, 1), BACKOFF_MS.length) - 1]!;
}

/** Signatures older than this are refused by receivers following our docs. */
export const WEBHOOK_TOLERANCE_SEC = 300;

/** Hex HMAC-SHA256 of `<timestamp>.<body>`. */
export function signWebhookBody(secret: string, timestamp: number, body: string): string {
  return createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
}

/** The `X-CB-Signature` header value: `t=<unix seconds>,v1=<signature>`. */
export function webhookSignatureHeader(secret: string, body: string, now = new Date()): string {
  const t = Math.floor(now.getTime() / 1000);
  return `t=${t},v1=${signWebhookBody(secret, t, body)}`;
}

/** Receiver-side check (documented for integrators; used by our tests). */
export function verifyWebhookSignature(
  secret: string,
  header: string,
  body: string,
  now = new Date(),
  toleranceSec = WEBHOOK_TOLERANCE_SEC,
): boolean {
  const parts = Object.fromEntries(
    header.split(',').map((p) => {
      const i = p.indexOf('=');
      return [p.slice(0, i).trim(), p.slice(i + 1).trim()];
    }),
  );
  const t = Number(parts.t);
  if (!Number.isInteger(t) || !parts.v1) return false;
  if (Math.abs(Math.floor(now.getTime() / 1000) - t) > toleranceSec) return false;
  const expected = Buffer.from(signWebhookBody(secret, t, body), 'hex');
  const given = Buffer.from(parts.v1, 'hex');
  return expected.length === given.length && timingSafeEqual(expected, given);
}

/** The envelope every webhook body uses. */
export function webhookBody(event: WebhookEvent | 'ping', data: unknown, now = new Date()) {
  return JSON.stringify({ id: randomUUID(), event, createdAt: now.toISOString(), data });
}

/**
 * Queues an event for every active webhook of the organisation subscribed to
 * it. Returns how many deliveries were created.
 */
export async function enqueueOrgEvent(
  orgId: Types.ObjectId | string,
  event: WebhookEvent,
  data: CandidateCompletedPayload | StageChangedPayload,
  opts: { session?: ClientSession; now?: Date } = {},
): Promise<number> {
  const now = opts.now ?? new Date();
  const hooks = await OrgWebhookModel.find(
    { orgId, active: true, events: event },
    { _id: 1 },
    { session: opts.session },
  ).lean();
  if (hooks.length === 0) return 0;
  const body = webhookBody(event, data, now);
  await WebhookDeliveryModel.create(
    hooks.map((h) => ({
      orgId,
      webhookId: h._id,
      event,
      body,
      status: 'PENDING',
      attempts: 0,
      nextAttemptAt: now,
    })),
    { session: opts.session, ordered: true },
  );
  return hooks.length;
}

/**
 * Claims up to `limit` due deliveries for one dispatcher run. The lease
 * (`lockedUntil`) keeps two workers from sending the same delivery; a
 * crashed worker's lease runs out and the delivery is claimed again.
 */
export async function claimDueDeliveries(
  now: Date,
  limit: number,
  leaseMs = 120_000,
): Promise<WebhookDeliveryRecord[]> {
  const claimed: WebhookDeliveryRecord[] = [];
  for (let i = 0; i < limit; i++) {
    const d = await WebhookDeliveryModel.findOneAndUpdate(
      {
        status: 'PENDING',
        nextAttemptAt: { $lte: now },
        $or: [{ lockedUntil: null }, { lockedUntil: { $lte: now } }],
      },
      { $set: { lockedUntil: new Date(now.getTime() + leaseMs) } },
      { sort: { nextAttemptAt: 1 }, returnDocument: 'after' },
    ).lean<WebhookDeliveryRecord>();
    if (!d) break;
    claimed.push(d);
  }
  return claimed;
}

/** Records one attempt: delivered, retried later, or given up after the last attempt. */
export async function recordDeliveryAttempt(
  delivery: Pick<WebhookDeliveryRecord, '_id' | 'attempts'>,
  outcome: { ok: boolean; statusCode: number | null; error: string | null },
  now = new Date(),
): Promise<WebhookDeliveryRecord['status']> {
  const attempts = delivery.attempts + 1;
  const status = outcome.ok ? 'DELIVERED' : attempts >= WEBHOOK_MAX_ATTEMPTS ? 'FAILED' : 'PENDING';
  await WebhookDeliveryModel.updateOne(
    { _id: delivery._id },
    {
      $set: {
        status,
        attempts,
        lockedUntil: null,
        lastStatusCode: outcome.statusCode,
        lastError: outcome.error?.slice(0, 300) ?? null,
        nextAttemptAt:
          status === 'PENDING' ? new Date(now.getTime() + webhookBackoffMs(attempts)) : null,
        deliveredAt: outcome.ok ? now : null,
      },
    },
  );
  return status;
}

/**
 * A campaign interview reached REPORT_READY (the worker's last evaluation
 * stage): its invite becomes COMPLETED and, for an organisation's campaign
 * whose candidate agreed to share it, `campaign.candidate_completed` is
 * queued. Runs once per application, however often the stage is retried.
 */
export async function campaignInterviewCompleted(
  sessionId: Types.ObjectId | string,
  now = new Date(),
): Promise<{ notified: boolean }> {
  const application = await CampaignApplicationModel.findOneAndUpdate(
    { sessionId, completedNotifiedAt: null },
    { $set: { completedNotifiedAt: now } },
    { returnDocument: 'after' },
  ).lean();
  if (!application) return { notified: false };
  await CampaignInviteModel.updateOne(
    { campaignId: application.campaignId, applicationId: application._id, status: 'JOINED' },
    { $set: { status: 'COMPLETED', completedAt: now } },
  );
  const campaign = await CampaignModel.findById(application.campaignId, { orgId: 1 }).lean();
  if (!campaign?.orgId) return { notified: false };
  const [session, score, user, profile] = await Promise.all([
    InterviewSessionModel.findById(sessionId, { consents: 1, state: 1, endedAt: 1 }).lean(),
    InterviewScoreModel.findOne({ sessionId }, { overall: 1, band: 1 })
      .sort({ revision: -1 })
      .lean(),
    UserModel.findById(application.userId, { primaryEmail: 1 }).lean(),
    UserProfileModel.findOne({ userId: application.userId }, { displayName: 1 }).lean(),
  ]);
  const shared = (session?.consents ?? []).some((c) => c.type === 'CAMPAIGN_SHARING' && c.accepted);
  if (!shared || !user?.primaryEmail) return { notified: false };
  await enqueueOrgEvent(
    campaign.orgId,
    'campaign.candidate_completed',
    {
      campaignId: String(application.campaignId),
      applicationId: String(application._id),
      candidate: {
        userId: String(application.userId),
        name: profile?.displayName ?? null,
        email: user.primaryEmail,
      },
      status: 'COMPLETED',
      overall: score?.overall ?? null,
      band: score?.band ?? null,
      completedAt: session?.endedAt ? session.endedAt.toISOString() : null,
    },
    { now },
  );
  return { notified: true };
}

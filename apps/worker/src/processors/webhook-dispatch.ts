import type { Logger } from '@cbi/config';
import {
  claimDueDeliveries,
  OrgModel,
  OrgWebhookModel,
  recordDeliveryAttempt,
  webhookSecretContext,
  webhookSignatureHeader,
  type OrgWebhookRecord,
  type WebhookDeliveryRecord,
} from '@cbi/db';
import { SafeFetchError, UrlBlockedError } from '@cbi/provider-adapters';
import {
  WEBHOOK_DELIVERY_HEADER,
  WEBHOOK_EVENT_HEADER,
  WEBHOOK_SIGNATURE_HEADER,
} from '@cbi/shared-types';

/**
 * Sends due webhook deliveries (the outbox the API and the evaluation
 * pipeline write). Each attempt is signed afresh (`X-CB-Signature:
 * t=<unix>,v1=<HMAC-SHA256 of "<t>.<body>">`), posted through the SSRF
 * guard, and recorded: 2xx is delivered; anything else is retried with
 * backoff until the last attempt, then FAILED.
 */

export type PostJson = (
  url: string,
  body: string,
  headers: Record<string, string>,
) => Promise<{ status: number }>;

export interface WebhookDispatchDeps {
  post: PostJson;
  secrets: { decrypt(secret: OrgWebhookRecord['secret'], context: string): string };
  logger: Logger;
  batch?: number;
  now?: () => Date;
}

/** A short, safe reason for the delivery log (never the receiver's response body). */
export function failureReason(err: unknown): string {
  if (err instanceof UrlBlockedError) return `Blocked URL (${err.reason})`;
  if (err instanceof SafeFetchError)
    return err.reason === 'TIMEOUT' ? 'Timed out' : 'Network error';
  return 'Delivery failed';
}

export async function deliverOne(
  deps: WebhookDispatchDeps,
  delivery: WebhookDeliveryRecord,
  now: Date,
) {
  const hook = await OrgWebhookModel.findOne({
    _id: delivery.webhookId,
    orgId: delivery.orgId,
  }).lean<OrgWebhookRecord>();
  const org = hook ? await OrgModel.findById(hook.orgId, { status: 1 }).lean() : null;
  if (!hook || !org || org.status !== 'ACTIVE' || (!hook.active && delivery.event !== 'ping')) {
    // Deleted or paused webhook, or a suspended organisation: nothing is sent; retried later.
    return recordDeliveryAttempt(
      delivery,
      { ok: false, statusCode: null, error: hook ? 'Webhook paused' : 'Webhook deleted' },
      now,
    );
  }
  const secret = deps.secrets.decrypt(hook.secret, webhookSecretContext(String(hook._id)));
  try {
    const res = await deps.post(hook.url, delivery.body, {
      [WEBHOOK_SIGNATURE_HEADER]: webhookSignatureHeader(secret, delivery.body, now),
      [WEBHOOK_EVENT_HEADER]: delivery.event,
      [WEBHOOK_DELIVERY_HEADER]: String(delivery._id),
    });
    const ok = res.status >= 200 && res.status < 300;
    return recordDeliveryAttempt(
      delivery,
      { ok, statusCode: res.status, error: ok ? null : `HTTP ${res.status}` },
      now,
    );
  } catch (err) {
    deps.logger.warn(
      { err, deliveryId: String(delivery._id), webhookId: String(hook._id) },
      'webhook delivery failed',
    );
    return recordDeliveryAttempt(
      delivery,
      { ok: false, statusCode: null, error: failureReason(err) },
      now,
    );
  }
}

export async function runWebhookDispatch(deps: WebhookDispatchDeps) {
  const now = deps.now ?? (() => new Date());
  const claimed = await claimDueDeliveries(now(), deps.batch ?? 50);
  const counts = { DELIVERED: 0, PENDING: 0, FAILED: 0 };
  for (const delivery of claimed) counts[await deliverOne(deps, delivery, now())]++;
  if (claimed.length > 0) deps.logger.info(counts, 'webhook deliveries sent');
  return counts;
}

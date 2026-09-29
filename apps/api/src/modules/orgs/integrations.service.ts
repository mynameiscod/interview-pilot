import { createHash, randomBytes } from 'node:crypto';
import type { EncryptedSecret } from '@cbi/ai-core';
import {
  OrgApiKeyModel,
  OrgModel,
  OrgWebhookModel,
  WebhookDeliveryModel,
  webhookBody,
  type OrgApiKeyRecord,
  type OrgWebhookRecord,
  type WebhookDeliveryRecord,
} from '@cbi/db';
import type {
  ApiKeySummary,
  ApiKeyWithSecret,
  CreateApiKeyBody,
  CreateWebhookBody,
  UpdateWebhookBody,
  WebhookDelivery,
  WebhookSummary,
  WebhookWithSecret,
} from '@cbi/shared-types';
import type { AuditService } from '../../lib/audit.js';
import { AppError } from '../../lib/errors.js';
import { iso, objectId } from '../../lib/ids.js';
import type { ClientContext } from '../../lib/request-context.js';
import type { ApiKeyContext } from '../../types/express.js';

/** Secret-box binding for a webhook's signing secret. */
export const webhookSecretContext = (webhookId: string) => `orgWebhook:${webhookId}`;

/** Most webhooks and live API keys an organisation may have. */
export const MAX_WEBHOOKS = 10;
export const MAX_API_KEYS = 10;

/** `cbk_<8-char public prefix>_<43-char secret>`: 256 random bits in the secret part. */
const API_KEY_PATTERN = /^cbk_([A-Za-z0-9]{8})_([A-Za-z0-9_-]{43})$/;

export const hashApiKey = (key: string) => createHash('sha256').update(key).digest('hex');

export function newApiKey() {
  const prefix = randomBytes(6).toString('base64url').replace(/[-_]/g, 'x').slice(0, 8);
  const key = `cbk_${prefix}_${randomBytes(32).toString('base64url')}`;
  return { prefix, key };
}

export function webhookSummary(w: OrgWebhookRecord): WebhookSummary {
  return {
    id: String(w._id),
    url: w.url,
    events: w.events,
    active: w.active,
    description: w.description,
    secretHint: w.secretHint,
    createdAt: iso(w.createdAt),
  };
}

export function deliverySummary(d: WebhookDeliveryRecord): WebhookDelivery {
  return {
    id: String(d._id),
    webhookId: String(d.webhookId),
    event: d.event,
    status: d.status,
    attempts: d.attempts,
    lastStatusCode: d.lastStatusCode,
    lastError: d.lastError,
    nextAttemptAt: d.nextAttemptAt ? iso(d.nextAttemptAt) : null,
    deliveredAt: d.deliveredAt ? iso(d.deliveredAt) : null,
    createdAt: iso(d.createdAt),
  };
}

export function apiKeySummary(k: OrgApiKeyRecord): ApiKeySummary {
  return {
    id: String(k._id),
    name: k.name,
    prefix: `cbk_${k.prefix}`,
    scopes: k.scopes,
    createdAt: iso(k.createdAt),
    lastUsedAt: k.lastUsedAt ? iso(k.lastUsedAt) : null,
    revokedAt: k.revokedAt ? iso(k.revokedAt) : null,
  };
}

/**
 * Webhooks must be https to a public host (checked again, with DNS, by the
 * worker at every delivery). Plain http is accepted only in development and
 * tests, for local receivers.
 */
export function checkWebhookUrl(raw: string, allowHttp: boolean): string {
  const url = new URL(raw);
  if (url.protocol !== 'https:' && !(allowHttp && url.protocol === 'http:')) {
    throw AppError.validation('Webhook URLs must use https.');
  }
  if (url.username || url.password) {
    throw AppError.validation('Webhook URLs cannot contain credentials.');
  }
  return url.toString();
}

/**
 * Org webhooks and API keys (ATS integrations). Webhook signing secrets are
 * encrypted with the platform secret box (the worker signs every delivery);
 * API keys are stored only as SHA-256 hashes and shown once.
 */
export function createOrgIntegrationsService(deps: {
  audit: AuditService;
  secrets: {
    encrypt(plaintext: string, context: string): EncryptedSecret;
  };
  allowHttpWebhooks: boolean;
  now?: () => Date;
}) {
  const { audit } = deps;
  const now = deps.now ?? (() => new Date());
  const org = (orgId: string) => objectId(orgId, 'Organisation');

  async function webhookOf(orgId: string, id: string) {
    const w = await OrgWebhookModel.findOne({
      _id: objectId(id, 'Webhook'),
      orgId: org(orgId),
    }).lean<OrgWebhookRecord>();
    if (!w) throw AppError.notFound('Webhook not found');
    return w;
  }

  const record = (
    actorId: string,
    orgId: string,
    action: string,
    details: Record<string, unknown>,
    ctx: ClientContext,
  ) =>
    audit.record(
      {
        actorType: 'ORG_MEMBER',
        actorId,
        action,
        resourceType: 'org',
        resourceId: orgId,
        details,
      },
      ctx,
    );

  return {
    // ---- Webhooks ------------------------------------------------------------------------------

    async webhooks(orgId: string): Promise<WebhookSummary[]> {
      const rows = await OrgWebhookModel.find({ orgId: org(orgId) })
        .sort({ createdAt: 1 })
        .lean<OrgWebhookRecord[]>();
      return rows.map(webhookSummary);
    },

    /** The signing secret is returned here only. */
    async createWebhook(
      orgId: string,
      body: CreateWebhookBody,
      actorId: string,
      ctx: ClientContext,
    ): Promise<WebhookWithSecret> {
      const url = checkWebhookUrl(body.url, deps.allowHttpWebhooks);
      if ((await OrgWebhookModel.countDocuments({ orgId: org(orgId) })) >= MAX_WEBHOOKS) {
        throw AppError.conflict(`An organisation can have up to ${MAX_WEBHOOKS} webhooks.`);
      }
      const secret = `whsec_${randomBytes(32).toString('base64url')}`;
      const webhook = new OrgWebhookModel({
        orgId: org(orgId),
        url,
        events: [...new Set(body.events)],
        active: true,
        description: body.description,
        secretHint: secret.slice(0, 10),
        createdBy: actorId,
      });
      webhook.secret = deps.secrets.encrypt(secret, webhookSecretContext(String(webhook._id)));
      await webhook.save();
      await record(
        actorId,
        orgId,
        'org.webhook_created',
        { webhookId: String(webhook._id), host: new URL(url).host, events: body.events },
        ctx,
      );
      return { webhook: webhookSummary(webhook.toObject() as OrgWebhookRecord), secret };
    },

    async updateWebhook(
      orgId: string,
      id: string,
      body: UpdateWebhookBody,
      actorId: string,
      ctx: ClientContext,
    ): Promise<WebhookSummary> {
      const w = await webhookOf(orgId, id);
      const updated = await OrgWebhookModel.findOneAndUpdate(
        { _id: w._id, orgId: w.orgId },
        {
          $set: {
            events: [...new Set(body.events)],
            active: body.active,
            description: body.description,
          },
        },
        { returnDocument: 'after' },
      ).lean<OrgWebhookRecord>();
      await record(
        actorId,
        orgId,
        'org.webhook_updated',
        { webhookId: id, events: body.events, active: body.active },
        ctx,
      );
      return webhookSummary(updated!);
    },

    async deleteWebhook(orgId: string, id: string, actorId: string, ctx: ClientContext) {
      const w = await webhookOf(orgId, id);
      await OrgWebhookModel.deleteOne({ _id: w._id, orgId: w.orgId });
      // Pending deliveries to a deleted webhook are dropped (the log keeps what was sent).
      await WebhookDeliveryModel.updateMany(
        { webhookId: w._id, status: 'PENDING' },
        { $set: { status: 'FAILED', lastError: 'Webhook deleted', nextAttemptAt: null } },
      );
      await record(actorId, orgId, 'org.webhook_deleted', { webhookId: id }, ctx);
    },

    /** Queues a `ping` delivery (signed like any event) to check the receiver. */
    async pingWebhook(orgId: string, id: string, actorId: string, ctx: ClientContext) {
      const w = await webhookOf(orgId, id);
      const at = now();
      const delivery = await WebhookDeliveryModel.create({
        orgId: w.orgId,
        webhookId: w._id,
        event: 'ping',
        body: webhookBody('ping', { webhookId: id }, at),
        status: 'PENDING',
        attempts: 0,
        nextAttemptAt: at,
      });
      await record(actorId, orgId, 'org.webhook_pinged', { webhookId: id }, ctx);
      return deliverySummary(delivery.toObject() as WebhookDeliveryRecord);
    },

    /** The delivery log (newest first, 30 days kept). */
    async deliveries(orgId: string, webhookId: string): Promise<WebhookDelivery[]> {
      const w = await webhookOf(orgId, webhookId);
      const rows = await WebhookDeliveryModel.find({ orgId: w.orgId, webhookId: w._id })
        .sort({ createdAt: -1 })
        .limit(100)
        .lean<WebhookDeliveryRecord[]>();
      return rows.map(deliverySummary);
    },

    // ---- API keys ------------------------------------------------------------------------------

    async apiKeys(orgId: string): Promise<ApiKeySummary[]> {
      const rows = await OrgApiKeyModel.find({ orgId: org(orgId) })
        .sort({ createdAt: -1 })
        .lean<OrgApiKeyRecord[]>();
      return rows.map(apiKeySummary);
    },

    /** The key is returned here only; the server keeps its hash. */
    async createApiKey(
      orgId: string,
      body: CreateApiKeyBody,
      actorId: string,
      ctx: ClientContext,
    ): Promise<ApiKeyWithSecret> {
      const live = await OrgApiKeyModel.countDocuments({ orgId: org(orgId), revokedAt: null });
      if (live >= MAX_API_KEYS) {
        throw AppError.conflict(`An organisation can have up to ${MAX_API_KEYS} active API keys.`);
      }
      const { prefix, key } = newApiKey();
      const created = await OrgApiKeyModel.create({
        orgId: org(orgId),
        name: body.name,
        prefix,
        keyHash: hashApiKey(key),
        scopes: ['results:read'],
        createdBy: actorId,
      });
      await record(
        actorId,
        orgId,
        'org.api_key_created',
        { apiKeyId: String(created._id), prefix },
        ctx,
      );
      return { apiKey: apiKeySummary(created.toObject() as OrgApiKeyRecord), key };
    },

    async revokeApiKey(orgId: string, id: string, actorId: string, ctx: ClientContext) {
      const updated = await OrgApiKeyModel.findOneAndUpdate(
        { _id: objectId(id, 'API key'), orgId: org(orgId), revokedAt: null },
        { $set: { revokedAt: now() } },
        { returnDocument: 'after' },
      ).lean<OrgApiKeyRecord>();
      if (!updated) throw AppError.notFound('API key not found');
      await record(actorId, orgId, 'org.api_key_revoked', { apiKeyId: id }, ctx);
      return apiKeySummary(updated);
    },

    /**
     * Checks a presented API key: well-formed, known (by hash), not revoked,
     * and its organisation active. Unknown and revoked keys fail alike.
     */
    async authenticateApiKey(raw: string): Promise<ApiKeyContext> {
      const invalid = () => AppError.unauthenticated('Invalid API key.');
      if (!API_KEY_PATTERN.test(raw)) throw invalid();
      const key = await OrgApiKeyModel.findOne({
        keyHash: hashApiKey(raw),
        revokedAt: null,
      }).lean<OrgApiKeyRecord>();
      if (!key) throw invalid();
      const owner = await OrgModel.findById(key.orgId, { status: 1 }).lean();
      if (owner?.status !== 'ACTIVE') {
        throw new AppError(403, 'ACCOUNT_SUSPENDED', 'This organisation is suspended.');
      }
      // Last use, at most once a minute (avoids a write per request).
      const at = now();
      if (!key.lastUsedAt || at.getTime() - key.lastUsedAt.getTime() > 60_000) {
        await OrgApiKeyModel.updateOne({ _id: key._id }, { $set: { lastUsedAt: at } });
      }
      return { id: String(key._id), orgId: String(key.orgId), scopes: key.scopes };
    },
  };
}

export type OrgIntegrationsService = ReturnType<typeof createOrgIntegrationsService>;

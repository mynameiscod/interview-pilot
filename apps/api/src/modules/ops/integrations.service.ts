import { randomUUID } from 'node:crypto';
import type { SecretBox } from '@cbi/ai-core';
import { secretContext, type Integrations } from '@cbi/ai-runtime';
import { IntegrationConfigModel, type IntegrationConfigRecord } from '@cbi/db';
import {
  IntegrationKind,
  IntegrationSpecs,
  type IntegrationSummary,
  type IntegrationTestResult,
  type TestIntegrationBody,
  type UpdateIntegrationBody,
} from '@cbi/shared-types';
import type { AuditService } from '../../lib/audit.js';
import { AppError } from '../../lib/errors.js';
import { iso } from '../../lib/ids.js';
import type { ClientContext } from '../../lib/request-context.js';
import { transaction } from '../../lib/transaction.js';

type Kind = IntegrationKind;

export function parseKind(value: string): Kind {
  const kind = IntegrationKind.safeParse(value);
  if (!kind.success) throw AppError.notFound('Integration not found');
  return kind.data;
}

/**
 * Admin-managed provider credentials (System → Integrations, SUPER_ADMIN).
 * Secrets are write-only: they are encrypted before they are stored and
 * only their last 4 characters are ever returned. Every change is audited
 * (field names only, never values) and applied by every process at once.
 */
export function createIntegrationsAdminService(deps: {
  integrations: Integrations;
  secrets: SecretBox;
  audit: AuditService;
}) {
  const { integrations, secrets, audit } = deps;

  function summary(kind: Kind, rec: IntegrationConfigRecord | null): IntegrationSummary {
    const spec = IntegrationSpecs[kind];
    const st = integrations.status(kind);
    return {
      kind,
      source: st.source,
      provider: st.provider,
      ready: st.ready,
      missing: st.missing,
      settings: rec?.settings ?? {},
      secrets: Object.fromEntries(
        spec.secrets.map((f) => {
          const s = rec?.secrets?.[f];
          return [f, { set: Boolean(s), last4: s?.last4 ?? null }];
        }),
      ),
      providers: [...spec.providers],
      updatedAt: rec ? iso(rec.updatedAt) : null,
      updatedBy: rec?.updatedBy ? String(rec.updatedBy) : null,
      lastTest: rec?.lastTest
        ? { ok: rec.lastTest.ok, message: rec.lastTest.message, at: iso(rec.lastTest.at) }
        : null,
    };
  }

  async function get(kind: Kind) {
    const rec = await IntegrationConfigModel.findOne({ kind }).lean<IntegrationConfigRecord>();
    return summary(kind, rec);
  }

  async function runTest(kind: Kind, body: TestIntegrationBody): Promise<IntegrationTestResult> {
    if (!integrations.ready(kind)) {
      const st = integrations.status(kind);
      return {
        ok: false,
        message:
          st.provider === 'disabled'
            ? 'This integration is turned off.'
            : `Not ready: missing ${st.missing.join(', ')}.`,
      };
    }
    try {
      switch (kind) {
        case 'email': {
          if (!body.to) throw AppError.validation('Enter an address to send the test email to.');
          await integrations.email.send({
            to: body.to,
            subject: 'CareerPilot Interview: test email',
            text: 'This is a test message from System → Integrations. Email delivery works.',
          });
          return { ok: true, message: `Test email sent to ${body.to}.` };
        }
        case 'storage': {
          const key = `integration-tests/${randomUUID()}.txt`;
          const payload = Buffer.from(`storage test ${new Date().toISOString()}`);
          await integrations.storage.put(key, payload, 'text/plain');
          const back = await integrations.storage.get(key);
          await integrations.storage.delete(key);
          if (!back.equals(payload)) return { ok: false, message: 'Read back different content.' };
          return { ok: true, message: 'Wrote, read and deleted a test file.' };
        }
        case 'payments': {
          // An order id that cannot exist: valid keys answer "not found", wrong keys "unauthorized".
          try {
            await integrations.payments.fetchOrderPayments('order_cbiIntegrationTest');
          } catch (err) {
            const msg = err instanceof Error ? err.message : '';
            if (/HTTP 401|HTTP 403/.test(msg)) {
              return { ok: false, message: 'Razorpay rejected the key id or key secret.' };
            }
            if (!/HTTP 400|HTTP 404/.test(msg)) throw err;
          }
          return { ok: true, message: 'Razorpay accepted the API keys.' };
        }
        case 'judge': {
          const languages = await integrations.judge.listLanguages();
          return { ok: true, message: `Judge reachable (${languages.length} languages).` };
        }
        case 'sms':
          return {
            ok: true,
            message: 'Configured. Request a sign-in code for your mobile number to test delivery.',
          };
      }
    } catch (err) {
      if (err instanceof AppError) throw err;
      // Provider messages never contain credentials (ProviderError contract).
      return { ok: false, message: err instanceof Error ? err.message.slice(0, 300) : 'Failed' };
    }
  }

  return {
    get,
    async list(): Promise<IntegrationSummary[]> {
      const recs = await IntegrationConfigModel.find().lean<IntegrationConfigRecord[]>();
      return IntegrationKind.options.map((k) => summary(k, recs.find((r) => r.kind === k) ?? null));
    },

    async update(kind: Kind, body: UpdateIntegrationBody, actorId: string, ctx: ClientContext) {
      const spec = IntegrationSpecs[kind];
      if (!(spec.providers as readonly string[]).includes(body.provider)) {
        throw AppError.validation(`Choose one of: ${spec.providers.join(', ')}.`);
      }
      const settings = spec.settings.safeParse(body.settings);
      if (!settings.success) {
        throw AppError.validation('Invalid settings', settings.error.issues);
      }
      const unknown = Object.keys(body.secrets).filter(
        (f) => !(spec.secrets as readonly string[]).includes(f),
      );
      if (unknown.length > 0) throw AppError.validation(`Unknown secret: ${unknown.join(', ')}`);

      await transaction(async (tx) => {
        const existing = await IntegrationConfigModel.findOne({ kind }, null, {
          session: tx,
        }).lean<IntegrationConfigRecord>();
        const stored = { ...(existing?.secrets ?? {}) };
        const changed: string[] = [];
        for (const [field, value] of Object.entries(body.secrets)) {
          if (value === null) {
            if (stored[field]) changed.push(`${field}:cleared`);
            delete stored[field];
          } else if (value.trim() !== '') {
            stored[field] = secrets.encrypt(value.trim(), secretContext(kind, field));
            changed.push(field);
          }
        }
        await IntegrationConfigModel.updateOne(
          { kind },
          {
            $set: {
              provider: body.provider,
              settings: settings.data,
              secrets: stored,
              updatedBy: actorId,
              lastTest: null,
            },
          },
          { upsert: true, session: tx },
        );
        await audit.record(
          {
            actorType: 'ADMIN',
            actorId,
            action: 'integration.updated',
            resourceType: 'integration',
            resourceId: kind,
            details: {
              provider: body.provider,
              previousProvider: existing?.provider ?? null,
              settings: settings.data,
              secretsChanged: changed,
              reason: body.reason,
            },
          },
          ctx,
          tx,
        );
      });
      await integrations.announceChange();
      return get(kind);
    },

    /** Removes the admin configuration: the environment file applies again. */
    async reset(kind: Kind, reason: string, actorId: string, ctx: ClientContext) {
      await transaction(async (tx) => {
        const res = await IntegrationConfigModel.deleteOne({ kind }, { session: tx });
        if (res.deletedCount === 0) throw AppError.notFound('No admin configuration to remove');
        await audit.record(
          {
            actorType: 'ADMIN',
            actorId,
            action: 'integration.reset',
            resourceType: 'integration',
            resourceId: kind,
            details: { reason },
          },
          ctx,
          tx,
        );
      });
      await integrations.announceChange();
      return get(kind);
    },

    async test(kind: Kind, body: TestIntegrationBody, actorId: string, ctx: ClientContext) {
      const result = await runTest(kind, body);
      await IntegrationConfigModel.updateOne(
        { kind },
        { $set: { lastTest: { ...result, at: new Date() } } },
      );
      await audit.record(
        {
          actorType: 'ADMIN',
          actorId,
          action: 'integration.tested',
          resourceType: 'integration',
          resourceId: kind,
          outcome: result.ok ? 'SUCCESS' : 'FAILURE',
          details: { ok: result.ok },
        },
        ctx,
      );
      return result;
    },
  };
}

export type IntegrationsAdminService = ReturnType<typeof createIntegrationsAdminService>;

import type { SecretBox } from '@cbi/ai-core';
import type { Logger } from '@cbi/config';
import { IntegrationConfigModel, type IntegrationConfigRecord, type Redis } from '@cbi/db';
import {
  createBunnyStorage,
  createCodeBegunJudge,
  createJudge0Adapter,
  createMsg91OtpProvider,
  createRazorpayGateway,
  createSesEmailProvider,
  createSmtpEmailProvider,
  JudgeUnavailableError,
  NotConfiguredError,
  type EmailProvider,
  type JudgeAdapter,
  type OtpSmsProvider,
  type PaymentGateway,
  type StorageProvider,
} from '@cbi/provider-adapters';
import {
  INTEGRATION_REQUIREMENTS,
  IntegrationKind,
  IntegrationSpecs,
  type IntegrationSource,
} from '@cbi/shared-types';

/**
 * Admin-managed integrations. Each kind resolves, in order, to:
 *   1. the admin configuration stored in `integrationConfigs` (secrets
 *      decrypted with the AI secrets box), even when it says `disabled`;
 *   2. otherwise the provider built from the environment file (`fallback`);
 *   3. otherwise nothing: calls fail with NotConfiguredError.
 * Callers hold stable wrappers that always delegate to the current provider,
 * so a change applies without a restart. Changes are broadcast on Redis; every
 * process also re-reads periodically as a safety net.
 */

export const INTEGRATIONS_CHANNEL = 'cbi:integrations:changed' as const;

export type Kind = IntegrationKind;

export interface IntegrationFallbacks {
  email?: EmailProvider | null;
  sms?: OtpSmsProvider | null;
  storage?: StorageProvider | null;
  payments?: PaymentGateway | null;
  judge?: JudgeAdapter | null;
}

export interface ResolvedStatus {
  source: IntegrationSource;
  provider: string;
  ready: boolean;
  missing: string[];
}

/** Secrets are bound to their record and field, so a ciphertext cannot be moved elsewhere. */
export const secretContext = (kind: Kind, field: string) => `integration:${kind}:${field}`;

/** Which required values are missing for a provider (names only). */
export function missingValues(
  kind: Kind,
  provider: string,
  settings: Record<string, unknown>,
  secretSet: (field: string) => boolean,
): string[] {
  const req = INTEGRATION_REQUIREMENTS[kind][provider];
  if (!req) return [`provider:${provider}`];
  return [
    ...req.settings.filter((f) => {
      const v = settings[f];
      return v === undefined || v === null || v === '';
    }),
    ...req.secrets.filter((f) => !secretSet(f)),
  ];
}

type Built = {
  email: EmailProvider | null;
  sms: OtpSmsProvider | null;
  storage: StorageProvider | null;
  payments: PaymentGateway | null;
  judge: JudgeAdapter | null;
};

const str = (v: unknown) => (typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined);

/** Builds the provider for one admin record (null when disabled or incomplete). */
export function buildFromRecord(
  rec: Pick<IntegrationConfigRecord, 'kind' | 'provider' | 'settings' | 'secrets'>,
  secrets: SecretBox,
): { provider: Built[Kind]; missing: string[] } {
  const kind = rec.kind;
  const secret = (field: string) => {
    const s = rec.secrets?.[field];
    return s ? secrets.decrypt(s, secretContext(kind, field)) : undefined;
  };
  const settings = rec.settings ?? {};
  const missing = missingValues(kind, rec.provider, settings, (f) => Boolean(rec.secrets?.[f]));
  if (rec.provider === 'disabled' || missing.length > 0) return { provider: null, missing };

  switch (kind) {
    case 'email': {
      const from = str(settings.from)!;
      if (rec.provider === 'ses') {
        return {
          provider: createSesEmailProvider({
            region: str(settings.sesRegion)!,
            from,
            credentials: {
              accessKeyId: secret('sesAccessKeyId')!,
              secretAccessKey: secret('sesSecretAccessKey')!,
            },
          }),
          missing,
        };
      }
      const pass = secret('smtpPass');
      const user = str(settings.smtpUser);
      return {
        provider: createSmtpEmailProvider({
          host: str(settings.smtpHost)!,
          port: typeof settings.smtpPort === 'number' ? settings.smtpPort : 587,
          secure: settings.smtpSecure === true,
          // Credentials never travel unencrypted.
          requireTls: settings.smtpSecure !== true,
          from,
          auth: user && pass ? { user, pass } : undefined,
        }),
        missing,
      };
    }
    case 'payments':
      return {
        provider: createRazorpayGateway({
          keyId: str(settings.keyId)!,
          keySecret: secret('keySecret')!,
          webhookSecret: secret('webhookSecret')!,
        }),
        missing,
      };
    case 'storage':
      return {
        provider: createBunnyStorage({
          zone: str(settings.zone)!,
          accessKey: secret('accessKey')!,
          regionHost: str(settings.regionHost) ?? 'storage.bunnycdn.com',
        }),
        missing,
      };
    case 'sms':
      return {
        provider: createMsg91OtpProvider({
          authKey: secret('authKey')!,
          templateId: str(settings.templateId)!,
          otpVariable: str(settings.otpVariable) ?? 'otp',
        }),
        missing,
      };
    case 'judge': {
      const baseUrl = str(settings.baseUrl)!;
      const hmacSecret = secret('hmacSecret')!;
      return {
        provider:
          rec.provider === 'judge0'
            ? createJudge0Adapter({ baseUrl, hmacSecret, authToken: secret('judge0AuthToken') })
            : createCodeBegunJudge({ baseUrl, hmacSecret }),
        missing,
      };
    }
  }
}

export interface IntegrationsOptions {
  redis: Redis;
  logger: Logger;
  secrets: SecretBox;
  /** Providers from the environment file (used when there is no admin configuration). */
  fallbacks: IntegrationFallbacks;
  /** Names of the environment providers, for status (e.g. `ses`, `mock`). */
  fallbackNames?: Partial<Record<Kind, string>>;
  /** Periodic re-read (ms); 0 disables. */
  refreshMs?: number;
}

export function buildIntegrations(opts: IntegrationsOptions) {
  const { logger, secrets } = opts;
  const current: Built = {
    email: opts.fallbacks.email ?? null,
    sms: opts.fallbacks.sms ?? null,
    storage: opts.fallbacks.storage ?? null,
    payments: opts.fallbacks.payments ?? null,
    judge: opts.fallbacks.judge ?? null,
  };
  const status = {} as Record<Kind, ResolvedStatus>;
  const envStatus = (kind: Kind): ResolvedStatus => {
    const p = opts.fallbacks[kind];
    return p
      ? { source: 'env', provider: opts.fallbackNames?.[kind] ?? p.name, ready: true, missing: [] }
      : { source: 'none', provider: 'disabled', ready: false, missing: ['provider'] };
  };
  for (const k of IntegrationKind.options) status[k] = envStatus(k);

  async function reload() {
    const records = await IntegrationConfigModel.find().lean<IntegrationConfigRecord[]>();
    for (const kind of IntegrationKind.options) {
      const rec = records.find((r) => r.kind === kind);
      if (!rec) {
        (current as Record<Kind, unknown>)[kind] = opts.fallbacks[kind] ?? null;
        status[kind] = envStatus(kind);
        continue;
      }
      try {
        const built = buildFromRecord(rec, secrets);
        (current as Record<Kind, unknown>)[kind] = built.provider;
        status[kind] = {
          source: 'admin',
          provider: rec.provider,
          ready: built.provider !== null,
          missing: rec.provider === 'disabled' ? [] : built.missing,
        };
      } catch (err) {
        // A secret that cannot be decrypted (wrong master key) must not take the process down.
        logger.error({ err, kind }, 'integration configuration could not be loaded');
        (current as Record<Kind, unknown>)[kind] = null;
        status[kind] = {
          source: 'admin',
          provider: rec.provider,
          ready: false,
          missing: ['secrets'],
        };
      }
    }
  }

  const need = <K extends Kind>(kind: K): NonNullable<Built[K]> => {
    const p = current[kind];
    if (!p) throw new NotConfiguredError(kind);
    return p as NonNullable<Built[K]>;
  };

  // ---- Stable wrappers (async methods reject rather than throw when not configured) -----------
  const email: EmailProvider = {
    get name() {
      return current.email?.name ?? 'none';
    },
    send: async (message) => need('email').send(message),
  };
  const sms: OtpSmsProvider = {
    get name() {
      return current.sms?.name ?? 'none';
    },
    sendOtp: async (message) => need('sms').sendOtp(message),
  };
  const storage: StorageProvider = {
    get name() {
      return current.storage?.name ?? 'none';
    },
    put: async (key, body, type) => need('storage').put(key, body, type),
    get: async (key) => need('storage').get(key),
    delete: async (key) => need('storage').delete(key),
  };
  const payments: PaymentGateway = {
    get name() {
      return current.payments?.name ?? 'none';
    },
    get publicKeyId() {
      return current.payments?.publicKeyId ?? '';
    },
    createOrder: async (input) => need('payments').createOrder(input),
    fetchOrderPayments: async (orderId) => need('payments').fetchOrderPayments(orderId),
    fetchPayment: async (paymentId) => need('payments').fetchPayment(paymentId),
    verifyPaymentSignature: (orderId, paymentId, signature) =>
      current.payments?.verifyPaymentSignature(orderId, paymentId, signature) ?? false,
    parseWebhook: (raw, signature, eventId) =>
      current.payments?.parseWebhook(raw, signature, eventId) ?? null,
    refund: async (paymentId, amountMinor, notes) =>
      need('payments').refund(paymentId, amountMinor, notes),
  };
  // Without a judge, coding degrades exactly as when the judge is down.
  const judgeOrDown = () => {
    if (!current.judge) throw new JudgeUnavailableError('judge', 'not configured');
    return current.judge;
  };
  const judge: JudgeAdapter = {
    get name() {
      return current.judge?.name ?? 'none';
    },
    listLanguages: async () => judgeOrDown().listLanguages(),
    submit: async (request) => judgeOrDown().submit(request),
    status: async (token) => judgeOrDown().status(token),
    result: async (token) => judgeOrDown().result(token),
  };

  let timer: NodeJS.Timeout | null = null;
  const safeReload = () =>
    reload().catch((err: unknown) => logger.warn({ err }, 'integration reload failed'));

  return {
    email,
    sms,
    storage,
    payments,
    judge,
    /** Whether a kind can be used right now. */
    ready: (kind: Kind) => current[kind] !== null,
    status: (kind: Kind): ResolvedStatus => status[kind],
    reload,
    /** Loads once and starts the periodic refresh. */
    async start() {
      await reload();
      if (opts.refreshMs && !timer) {
        timer = setInterval(() => void safeReload(), opts.refreshMs);
        timer.unref();
      }
    },
    /** Reload here and tell every other process. */
    async announceChange() {
      await reload();
      try {
        await opts.redis.publish(INTEGRATIONS_CHANNEL, String(Date.now()));
      } catch (err) {
        logger.warn({ err }, 'integration change broadcast failed');
      }
    },
    async listenForChanges(): Promise<() => Promise<void>> {
      const subscriber = opts.redis.duplicate();
      await subscriber.connect();
      await subscriber.subscribe(INTEGRATIONS_CHANNEL);
      subscriber.on('message', (channel) => {
        if (channel === INTEGRATIONS_CHANNEL) void safeReload();
      });
      return async () => {
        if (timer) clearInterval(timer);
        await subscriber.quit().catch(() => undefined);
      };
    },
    /** Specs re-exported for callers that validate admin input. */
    specs: IntegrationSpecs,
  };
}

export type Integrations = ReturnType<typeof buildIntegrations>;

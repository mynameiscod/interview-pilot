/**
 * Configures one integration (email, payments, storage, sms, judge) from the
 * server shell: the bootstrap path before any admin can sign in (the first
 * super admin needs email for their sign-in code). Everything else is done in
 * the admin site (System → Integrations).
 *
 * Reads JSON from stdin, so secrets never appear in shell history or `ps`:
 *   { "provider": "smtp",
 *     "settings": { "from": "CareerPilot Interview <no-reply@codebegun.com>",
 *                   "smtpHost": "smtp.example.com", "smtpPort": 587, "smtpUser": "apikey" },
 *     "secrets":  { "smtpPass": "..." } }
 *
 *   docker compose ... exec -T api-<colour> node dist/scripts/configure-integration.js email < email.json
 *
 * Same storage as the admin site: secrets encrypted with AI_SECRETS_MASTER_KEY,
 * audited (field names only), and every running process reloads at once.
 */
import { buildSecretBox, INTEGRATIONS_CHANNEL, secretContext } from '@cbi/ai-runtime';
import { createLogger } from '@cbi/config';
import {
  AuditLogModel,
  connectMongo,
  createRedis,
  disconnectMongo,
  IntegrationConfigModel,
} from '@cbi/db';
import { AppEnv, IntegrationKind, IntegrationSpecs } from '@cbi/shared-types';
import { z } from 'zod';

const env = z
  .object({
    APP_ENV: AppEnv,
    MONGODB_URI: z.string().min(1),
    REDIS_URL: z.string().min(1),
    AI_SECRETS_MASTER_KEY: z.string().min(1),
    AI_SECRETS_KEY_ID: z.string().default('k1'),
    AI_SECRETS_PREVIOUS_KEYS: z.string().optional(),
  })
  .parse(process.env);
const logger = createLogger({ service: 'configure-integration', level: 'info', env: env.APP_ENV });

const kind = IntegrationKind.safeParse(process.argv[2]);
if (!kind.success) {
  logger.error(
    `Usage: configure-integration.js <${IntegrationKind.options.join('|')}> < config.json`,
  );
  process.exit(2);
}
const spec = IntegrationSpecs[kind.data];

const chunks: Buffer[] = [];
for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
const input = z
  .object({
    provider: z.enum(spec.providers as unknown as [string, ...string[]]),
    settings: z.record(z.string(), z.unknown()).default({}),
    secrets: z.record(z.string(), z.string().min(1)).default({}),
  })
  .parse(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
const settings = spec.settings.parse(input.settings);
const unknown = Object.keys(input.secrets).filter(
  (f) => !(spec.secrets as readonly string[]).includes(f),
);
if (unknown.length > 0) {
  logger.error({ unknown }, 'unknown secret fields');
  process.exit(2);
}

const box = buildSecretBox({
  AI_SECRETS_MASTER_KEY: env.AI_SECRETS_MASTER_KEY,
  AI_SECRETS_KEY_ID: env.AI_SECRETS_KEY_ID,
  AI_SECRETS_PREVIOUS_KEYS: env.AI_SECRETS_PREVIOUS_KEYS,
} as Parameters<typeof buildSecretBox>[0]);

await connectMongo({ uri: env.MONGODB_URI, autoIndex: false, logger });
const redis = createRedis(env.REDIS_URL, logger);
try {
  await redis.connect();
  const existing = await IntegrationConfigModel.findOne({ kind: kind.data }).lean();
  const secrets = { ...(existing?.secrets ?? {}) };
  for (const [field, value] of Object.entries(input.secrets)) {
    secrets[field] = box.encrypt(value, secretContext(kind.data, field));
  }
  await IntegrationConfigModel.updateOne(
    { kind: kind.data },
    { $set: { provider: input.provider, settings, secrets, lastTest: null } },
    { upsert: true },
  );
  await AuditLogModel.create({
    actorType: 'SYSTEM',
    action: 'integration.updated',
    resourceType: 'integration',
    resourceId: kind.data,
    outcome: 'SUCCESS',
    details: {
      provider: input.provider,
      settings,
      secretsChanged: Object.keys(input.secrets),
      via: 'configure-integration script',
    },
  });
  await redis.publish(INTEGRATIONS_CHANNEL, String(Date.now()));
  logger.info(
    { kind: kind.data, provider: input.provider },
    'integration saved; running processes reload it now. Test it in System → Integrations.',
  );
} finally {
  await redis.quit().catch(() => undefined);
  await disconnectMongo();
}

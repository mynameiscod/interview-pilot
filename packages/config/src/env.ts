import { AppEnv } from '@cbi/shared-types';
import { z } from 'zod';

const booleanString = z
  .enum(['true', 'false', '1', '0'])
  .transform((v) => v === 'true' || v === '1');

const LogLevel = z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']);

function isOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === 'http:' || url.protocol === 'https:') && url.origin === value;
  } catch {
    return false;
  }
}

/** Comma-separated list of origins: scheme://host[:port], no path or trailing slash. */
const originList = z
  .string()
  .min(1)
  .transform((raw) =>
    raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  )
  .pipe(
    z.array(
      z.string().refine(isOrigin, 'must be an origin such as https://interview.codebegun.com'),
    ),
  );

const mongoUri = z
  .string()
  .regex(/^mongodb(\+srv)?:\/\//, 'must be a mongodb:// or mongodb+srv:// URI');

const redisUrl = z.string().regex(/^rediss?:\/\//, 'must be a redis:// or rediss:// URL');

const baseEnvSchema = z.object({
  APP_ENV: AppEnv,
  LOG_LEVEL: LogLevel.default('info'),
  MONGODB_URI: mongoUri,
  REDIS_URL: redisUrl,
  /** Build/release identifier surfaced on /healthz. */
  APP_VERSION: z.string().default('0.0.0-dev'),
  SHUTDOWN_GRACE_MS: z.coerce.number().int().min(1000).max(120000).default(30000),
});

const secret = z.string().min(32, 'must be at least 32 characters');
const optionalString = z
  .string()
  .optional()
  .transform((v) => (v && v.trim() !== '' ? v.trim() : undefined));
const isDeployed = (appEnv: AppEnv) => appEnv === 'staging' || appEnv === 'production';

/** A base64-encoded 32-byte key (AES-256). */
const base64Key32 = z
  .string()
  .trim()
  .refine((v) => {
    const bytes = Buffer.from(v, 'base64');
    return bytes.length === 32 && bytes.toString('base64') === v;
  }, 'must be exactly 32 bytes, base64-encoded (openssl rand -base64 32)');

/** True when a base64 key decodes to the development example value. */
const isExampleKey = (v: string) =>
  /dev-only|change-me/i.test(Buffer.from(v, 'base64').toString('latin1'));

// --- Settings shared by the API and the worker ----------------------------------

/** AI runtime: both processes make AI calls and decrypt provider keys. */
const aiRuntimeShape = {
  /** Encrypts provider API keys stored through Admin (AES-256-GCM). */
  AI_SECRETS_MASTER_KEY: base64Key32,
  AI_SECRETS_KEY_ID: z
    .string()
    .regex(/^[a-z0-9_-]{1,16}$/i, 'letters, digits, - and _ only (max 16)')
    .default('k1'),
  /** Older keys kept for decryption during rotation: `k0:base64,k1:base64`. */
  AI_SECRETS_PREVIOUS_KEYS: optionalString,
  /** Deterministic mock provider; development/test only. */
  AI_MOCK_MODE: booleanString.default(false),
  AI_CONFIG_CACHE_TTL_SEC: z.coerce.number().int().min(1).max(600).default(30),
};

/** Object storage for uploaded documents (and media from Phase 8). */
const storageShape = {
  /** `local` writes under LOCAL_STORAGE_DIR (development only). */
  STORAGE_PROVIDER: z.enum(['bunny', 'local']).default('local'),
  LOCAL_STORAGE_DIR: z.string().default('.data/storage'),
  BUNNY_STORAGE_ZONE: optionalString,
  /** Region endpoint, e.g. storage.bunnycdn.com (Falkenstein) or sg.storage.bunnycdn.com. */
  BUNNY_STORAGE_REGION_HOST: z.string().default('storage.bunnycdn.com'),
  BUNNY_STORAGE_ACCESS_KEY: optionalString,
  UPLOAD_MAX_MB: z.coerce.number().int().min(1).max(25).default(8),
};

/** Outgoing email. The API needs it for sign-in codes; the worker for report notifications. */
const emailFields = {
  EMAIL_FROM: z.string().min(3),
  SES_REGION: optionalString,
  /** Omit both to use the default AWS credential chain. */
  SES_ACCESS_KEY_ID: optionalString,
  SES_SECRET_ACCESS_KEY: optionalString,
  SMTP_HOST: optionalString,
  SMTP_PORT: z.coerce.number().int().min(1).max(65535).default(587),
  SMTP_SECURE: booleanString.default(false),
  SMTP_REQUIRE_TLS: booleanString.default(true),
  SMTP_USER: optionalString,
  SMTP_PASS: optionalString,
};

type EmailEnv = {
  APP_ENV: AppEnv;
  EMAIL_PROVIDER: 'ses' | 'smtp' | 'disabled';
  SES_REGION?: string;
  SES_ACCESS_KEY_ID?: string;
  SES_SECRET_ACCESS_KEY?: string;
  SMTP_HOST?: string;
  SMTP_SECURE: boolean;
  SMTP_REQUIRE_TLS: boolean;
};

function emailIssues(env: EmailEnv, issue: (path: string, message: string) => void) {
  if (env.EMAIL_PROVIDER === 'ses' && !env.SES_REGION) {
    issue('SES_REGION', 'required when EMAIL_PROVIDER=ses');
  }
  if (Boolean(env.SES_ACCESS_KEY_ID) !== Boolean(env.SES_SECRET_ACCESS_KEY)) {
    issue('SES_ACCESS_KEY_ID', 'set both SES_ACCESS_KEY_ID and SES_SECRET_ACCESS_KEY, or neither');
  }
  if (env.EMAIL_PROVIDER === 'smtp' && !env.SMTP_HOST) {
    issue('SMTP_HOST', 'required when EMAIL_PROVIDER=smtp');
  }
  if (
    isDeployed(env.APP_ENV) &&
    env.EMAIL_PROVIDER === 'smtp' &&
    !env.SMTP_REQUIRE_TLS &&
    !env.SMTP_SECURE
  ) {
    issue('SMTP_REQUIRE_TLS', `unencrypted SMTP is not allowed in ${env.APP_ENV}`);
  }
}

/** Payments (Phase 6). The API creates and verifies orders; the worker reconciles and refunds. */
const paymentShape = {
  /** `mock` is an in-memory gateway for development and tests (refused in staging/production). */
  PAYMENT_PROVIDER: z.enum(['razorpay', 'mock']).default('mock'),
  /** Public key id (also given to the browser for Checkout). */
  RAZORPAY_KEY_ID: optionalString,
  RAZORPAY_KEY_SECRET: optionalString,
  RAZORPAY_WEBHOOK_SECRET: optionalString,
};

type PaymentEnv = {
  APP_ENV: AppEnv;
  PAYMENT_PROVIDER: 'razorpay' | 'mock';
  RAZORPAY_KEY_ID?: string;
  RAZORPAY_KEY_SECRET?: string;
  RAZORPAY_WEBHOOK_SECRET?: string;
};

function paymentIssues(env: PaymentEnv, issue: (path: string, message: string) => void) {
  if (
    env.PAYMENT_PROVIDER === 'razorpay' &&
    (!env.RAZORPAY_KEY_ID || !env.RAZORPAY_KEY_SECRET || !env.RAZORPAY_WEBHOOK_SECRET)
  ) {
    issue(
      'RAZORPAY_KEY_ID',
      'RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET and RAZORPAY_WEBHOOK_SECRET are required when PAYMENT_PROVIDER=razorpay',
    );
  }
  if (isDeployed(env.APP_ENV) && env.PAYMENT_PROVIDER === 'mock') {
    issue(
      'PAYMENT_PROVIDER',
      `the mock payment gateway is for development only, not ${env.APP_ENV}`,
    );
  }
}

type SharedEnv = {
  APP_ENV: AppEnv;
  AI_SECRETS_MASTER_KEY: string;
  AI_SECRETS_KEY_ID: string;
  AI_SECRETS_PREVIOUS_KEYS?: string;
  AI_MOCK_MODE: boolean;
  STORAGE_PROVIDER: 'bunny' | 'local';
  BUNNY_STORAGE_ZONE?: string;
  BUNNY_STORAGE_ACCESS_KEY?: string;
};

function sharedIssues(env: SharedEnv, issue: (path: string, message: string) => void) {
  if (env.AI_SECRETS_PREVIOUS_KEYS) {
    for (const item of env.AI_SECRETS_PREVIOUS_KEYS.split(',').map((s) => s.trim())) {
      const [keyId, key] = [item.slice(0, item.indexOf(':')), item.slice(item.indexOf(':') + 1)];
      if (!keyId || !base64Key32.safeParse(key).success) {
        issue('AI_SECRETS_PREVIOUS_KEYS', 'entries must look like keyId:base64 (32-byte keys)');
        break;
      }
      if (keyId === env.AI_SECRETS_KEY_ID) {
        issue('AI_SECRETS_PREVIOUS_KEYS', 'must not repeat AI_SECRETS_KEY_ID');
        break;
      }
    }
  }
  if (
    env.STORAGE_PROVIDER === 'bunny' &&
    (!env.BUNNY_STORAGE_ZONE || !env.BUNNY_STORAGE_ACCESS_KEY)
  ) {
    issue(
      'BUNNY_STORAGE_ZONE',
      'BUNNY_STORAGE_ZONE and BUNNY_STORAGE_ACCESS_KEY are required when STORAGE_PROVIDER=bunny',
    );
  }
  if (isDeployed(env.APP_ENV)) {
    if (env.AI_MOCK_MODE) {
      issue(
        'AI_MOCK_MODE',
        `the mock AI provider is for development and tests only, not ${env.APP_ENV}`,
      );
    }
    if (isExampleKey(env.AI_SECRETS_MASTER_KEY)) {
      issue(
        'AI_SECRETS_MASTER_KEY',
        `the example development key must not be used in ${env.APP_ENV}`,
      );
    }
    if (env.STORAGE_PROVIDER === 'local') {
      issue('STORAGE_PROVIDER', `local storage is for development only, not ${env.APP_ENV}`);
    }
  }
}

const apiObjectSchema = baseEnvSchema.extend({
  ...aiRuntimeShape,
  ...storageShape,
  ...paymentShape,
  PORT_API: z.coerce.number().int().min(1).max(65535).default(4000),
  CORS_ALLOWED_ORIGINS: originList,
  /** Number of trusted reverse-proxy hops (NGINX = 1). Needed for correct client IPs. */
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(5).default(0),
  REQUEST_BODY_LIMIT: z.string().default('1mb'),
  API_DOCS_ENABLED: booleanString.default(false),
  PUBLIC_CANDIDATE_URL: z.url(),
  PUBLIC_ADMIN_URL: z.url(),

  // --- Sessions -----------------------------------------------------------
  JWT_ACCESS_SECRET: secret,
  JWT_ACCESS_TTL_SEC: z.coerce.number().int().min(60).max(3600).default(600),
  REFRESH_TTL_CANDIDATE_DAYS: z.coerce.number().int().min(1).max(90).default(30),
  REFRESH_TTL_ADMIN_HOURS: z.coerce.number().int().min(1).max(72).default(12),
  /** Leave unset to scope cookies to the API host only (recommended). */
  COOKIE_DOMAIN: optionalString,

  // --- OTP ----------------------------------------------------------------
  /** Keys OTP hashes and pseudonymous hashes (IP, destination). */
  OTP_HMAC_SECRET: secret,
  OTP_TTL_SEC: z.coerce.number().int().min(60).max(900).default(300),
  OTP_MAX_ATTEMPTS: z.coerce.number().int().min(3).max(10).default(5),
  OTP_RESEND_COOLDOWN_SEC: z.coerce.number().int().min(10).max(300).default(30),
  OTP_MAX_PER_DESTINATION_PER_HOUR: z.coerce.number().int().min(1).max(20).default(5),

  // --- Google sign-in -----------------------------------------------------
  /** Unset disables Google sign-in. */
  GOOGLE_CLIENT_ID: optionalString,

  // --- Email --------------------------------------------------------------
  EMAIL_PROVIDER: z.enum(['ses', 'smtp']),
  ...emailFields,

  // --- SMS ----------------------------------------------------------------
  /** `disabled` hides mobile OTP (e.g. until DLT registration completes). */
  SMS_PROVIDER: z.enum(['msg91', 'dev-mailbox', 'disabled']),
  MSG91_AUTH_KEY: optionalString,
  MSG91_OTP_TEMPLATE_ID: optionalString,
  MSG91_OTP_VARIABLE: z.string().default('otp'),

  /** Optional first-run keys; imported once (encrypted) when the provider has none. */
  AI_BOOTSTRAP_OPENAI_API_KEY: optionalString,
  AI_BOOTSTRAP_ANTHROPIC_API_KEY: optionalString,
  AI_BOOTSTRAP_GEMINI_API_KEY: optionalString,
});

export const apiEnvSchema = apiObjectSchema.superRefine((env, ctx) => {
  const issue = (path: string, message: string) =>
    ctx.addIssue({ code: 'custom', path: [path], message });

  emailIssues(env, issue);
  paymentIssues(env, issue);
  if (env.SMS_PROVIDER === 'msg91' && (!env.MSG91_AUTH_KEY || !env.MSG91_OTP_TEMPLATE_ID)) {
    issue(
      'MSG91_AUTH_KEY',
      'MSG91_AUTH_KEY and MSG91_OTP_TEMPLATE_ID are required when SMS_PROVIDER=msg91',
    );
  }
  if (env.JWT_ACCESS_SECRET === env.OTP_HMAC_SECRET) {
    issue('OTP_HMAC_SECRET', 'must differ from JWT_ACCESS_SECRET');
  }
  sharedIssues(env, issue);
  if (isDeployed(env.APP_ENV)) {
    if (env.SMS_PROVIDER === 'dev-mailbox') {
      issue('SMS_PROVIDER', `dev-mailbox is for local development only, not ${env.APP_ENV}`);
    }
    for (const key of ['JWT_ACCESS_SECRET', 'OTP_HMAC_SECRET'] as const) {
      if (/dev-only|change-me/i.test(env[key])) {
        issue(key, `the example development value must not be used in ${env.APP_ENV}`);
      }
    }
  }
});
export type ApiEnv = z.infer<typeof apiEnvSchema>;

export const workerEnvSchema = baseEnvSchema
  .extend({
    ...aiRuntimeShape,
    ...storageShape,
    ...paymentShape,
    WORKER_HEALTH_PORT: z.coerce.number().int().min(1).max(65535).default(4100),
    WORKER_HEARTBEAT_INTERVAL_MS: z.coerce.number().int().min(1000).default(15000),
    /** How often AI usage is rolled up into providerHealth. */
    WORKER_PROVIDER_HEALTH_INTERVAL_MS: z.coerce.number().int().min(10_000).default(60_000),
    /** How often live interview timeouts (disconnect, pause, expiry) are checked. */
    WORKER_LIVE_SWEEP_INTERVAL_MS: z.coerce.number().int().min(5_000).max(120_000).default(15_000),
    /** Parallel evaluation stages (AI calls and PDF rendering). */
    WORKER_EVALUATION_CONCURRENCY: z.coerce.number().int().min(1).max(20).default(3),
    /** Report-ready emails; `disabled` skips them (the report is still shown in the app). */
    EMAIL_PROVIDER: z.enum(['ses', 'smtp', 'disabled']).default('disabled'),
    ...emailFields,
    EMAIL_FROM: z.string().min(3).default('CareerPilot Interview <no-reply@localhost>'),
    /** Links in emails point here. */
    PUBLIC_CANDIDATE_URL: z.url().default('http://localhost:5173'),
    /** Parallel document jobs (parsing is CPU- and memory-heavy). */
    WORKER_DOCUMENT_CONCURRENCY: z.coerce.number().int().min(1).max(8).default(2),
    WORKER_ANALYSIS_CONCURRENCY: z.coerce.number().int().min(1).max(20).default(4),
    /** Job-description URL fetching (SSRF-guarded). */
    JD_FETCH_TIMEOUT_MS: z.coerce.number().int().min(1000).max(30_000).default(10_000),
    JD_FETCH_MAX_BYTES: z.coerce
      .number()
      .int()
      .min(64 * 1024)
      .max(10 * 1024 * 1024)
      .default(2 * 1024 * 1024),
  })
  .superRefine((env, ctx) => {
    const issue = (path: string, message: string) =>
      ctx.addIssue({ code: 'custom', path: [path], message });
    sharedIssues(env, issue);
    emailIssues(env, issue);
    paymentIssues(env, issue);
  });
export type WorkerEnv = z.infer<typeof workerEnvSchema>;

export class EnvValidationError extends Error {
  constructor(public readonly issues: string[]) {
    super(`Invalid environment configuration:\n  - ${issues.join('\n  - ')}`);
    this.name = 'EnvValidationError';
  }
}

interface DeployRuleInput {
  APP_ENV: AppEnv;
  CORS_ALLOWED_ORIGINS?: string[];
  API_DOCS_ENABLED?: boolean;
}

/** Rules that only apply to deployed environments. */
function deployedEnvIssues(env: DeployRuleInput): string[] {
  const issues: string[] = [];
  if (env.APP_ENV === 'staging' || env.APP_ENV === 'production') {
    const insecure = (env.CORS_ALLOWED_ORIGINS ?? []).filter((o) => !o.startsWith('https://'));
    if (insecure.length > 0) {
      issues.push(
        `CORS_ALLOWED_ORIGINS: non-HTTPS origins not allowed in ${env.APP_ENV}: ${insecure.join(', ')}`,
      );
    }
  }
  if (env.APP_ENV === 'production' && env.API_DOCS_ENABLED) {
    issues.push('API_DOCS_ENABLED: interactive API docs must be disabled in production');
  }
  return issues;
}

/**
 * Parses and validates environment variables. Error messages name the variable
 * and the rule but never echo the value, because values may be secrets.
 */
export function loadEnv<S extends z.ZodType<DeployRuleInput>>(
  schema: S,
  source: Record<string, string | undefined> = process.env,
): z.infer<S> {
  const result = schema.safeParse(source);
  if (!result.success) {
    throw new EnvValidationError(
      result.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`),
    );
  }
  const issues = deployedEnvIssues(result.data);
  if (issues.length > 0) throw new EnvValidationError(issues);
  return result.data;
}

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

export const apiEnvSchema = baseEnvSchema.extend({
  PORT_API: z.coerce.number().int().min(1).max(65535).default(4000),
  CORS_ALLOWED_ORIGINS: originList,
  /** Number of trusted reverse-proxy hops (NGINX = 1). Needed for correct client IPs. */
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(5).default(0),
  REQUEST_BODY_LIMIT: z.string().default('1mb'),
  API_DOCS_ENABLED: booleanString.default(false),
});
export type ApiEnv = z.infer<typeof apiEnvSchema>;

export const workerEnvSchema = baseEnvSchema.extend({
  WORKER_HEALTH_PORT: z.coerce.number().int().min(1).max(65535).default(4100),
  WORKER_HEARTBEAT_INTERVAL_MS: z.coerce.number().int().min(1000).default(15000),
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

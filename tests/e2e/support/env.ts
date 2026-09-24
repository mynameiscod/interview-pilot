import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Everything the suite needs to know about its environment, in one place.
 * Every value can be overridden with an E2E_* variable (see README.md).
 * All URLs use `localhost` (not 127.0.0.1) so the SPAs and the API are the
 * same site and the refresh cookie (SameSite=Lax) is sent.
 */
const here = dirname(fileURLToPath(import.meta.url));

export const E2E_DIR = resolve(here, '..');
export const REPO_ROOT = resolve(E2E_DIR, '../..');
/** SPA builds, logs and local file storage (gitignored). */
export const CACHE_DIR = join(E2E_DIR, '.cache');

const port = (name: string, fallback: number) => Number(process.env[name] ?? fallback);

export const PORTS = {
  api: port('E2E_API_PORT', 4971),
  worker: port('E2E_WORKER_HEALTH_PORT', 4972),
  candidate: port('E2E_CANDIDATE_PORT', 6273),
  admin: port('E2E_ADMIN_PORT', 6274),
};

export const URLS = {
  api: `http://localhost:${PORTS.api}`,
  workerHealth: `http://localhost:${PORTS.worker}`,
  candidate: `http://localhost:${PORTS.candidate}`,
  admin: `http://localhost:${PORTS.admin}`,
  mailpit: (process.env.E2E_MAILPIT_URL ?? 'http://localhost:8025').replace(/\/+$/, ''),
};

/** Dedicated database and Redis DB index: the suite drops/flushes only these. */
export const MONGODB_URI =
  process.env.E2E_MONGODB_URI ??
  'mongodb://localhost:27018/cbi_interview_e2e?directConnection=true';
export const REDIS_URL = process.env.E2E_REDIS_URL ?? 'redis://localhost:6380/13';

export const SMTP = {
  host: process.env.E2E_SMTP_HOST ?? '127.0.0.1',
  port: process.env.E2E_SMTP_PORT ?? '1025',
};

/** Timeouts for steps that wait on the worker (role analysis, scoring, PDF rendering). */
export const WORKER_STEP_TIMEOUT = Number(process.env.E2E_WORKER_TIMEOUT_MS ?? 240_000);

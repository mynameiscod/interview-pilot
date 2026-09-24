/* eslint-disable no-console -- the setup reports progress and failures on the console. */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { resetStores } from './data';
import { CACHE_DIR, MONGODB_URI, PORTS, REDIS_URL, REPO_ROOT, SMTP, URLS } from './env';

/**
 * Starts the stack the suite runs against:
 *  - the compiled API and worker (`corepack pnpm build` must have run) with AI,
 *    storage and judge mocks, email via SMTP to Mailpit and SMS disabled;
 *  - both SPAs, rebuilt into .cache/ with VITE_API_URL pointing at the e2e API
 *    (the API URL is baked in at build time), served by `vite preview`.
 * Returns the teardown that stops everything.
 */

const LOG_DIR = join(CACHE_DIR, 'logs');
const SPA_DIR = join(CACHE_DIR, 'spa');
const STORAGE_DIR = join(CACHE_DIR, 'storage');
const viteBin = join(
  dirname(
    createRequire(join(REPO_ROOT, 'apps/candidate-web/package.json')).resolve('vite/package.json'),
  ),
  'bin/vite.js',
);

const SPA_ENV = {
  'candidate-web': {
    VITE_API_URL: URLS.api,
    VITE_APP_ENV: 'development',
    VITE_GOOGLE_CLIENT_ID: '',
  },
  'admin-web': {
    VITE_API_URL: URLS.api,
    VITE_APP_ENV: 'development',
    VITE_GOOGLE_CLIENT_ID: '',
    VITE_CANDIDATE_URL: URLS.candidate,
  },
} as const;
type SpaName = keyof typeof SPA_ENV;

const SECRETS = {
  AI_SECRETS_MASTER_KEY: Buffer.alloc(32, 7).toString('base64'),
  JWT_ACCESS_SECRET: 'e2e-jwt-secret-0123456789abcdef0123456789',
  OTP_HMAC_SECRET: 'e2e-otp-secret-0123456789abcdef0123456789',
};

function serverEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    APP_ENV: 'development',
    LOG_LEVEL: process.env.E2E_LOG_LEVEL ?? 'warn',
    MONGODB_URI,
    REDIS_URL,
    ...SECRETS,
    AI_MOCK_MODE: 'true',
    STORAGE_PROVIDER: 'local',
    LOCAL_STORAGE_DIR: STORAGE_DIR,
    JUDGE_PROVIDER: 'mock',
    EMAIL_PROVIDER: 'smtp',
    EMAIL_FROM: 'e2e@localhost',
    SMTP_HOST: SMTP.host,
    SMTP_PORT: SMTP.port,
    SMTP_REQUIRE_TLS: 'false',
    SMS_PROVIDER: 'disabled',
    PUBLIC_CANDIDATE_URL: URLS.candidate,
    PUBLIC_ADMIN_URL: URLS.admin,
  };
}

function start(name: string, args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv }) {
  const log = openSync(join(LOG_DIR, `${name}.log`), 'w');
  const child = spawn(process.execPath, args, {
    cwd: opts.cwd,
    env: opts.env,
    stdio: ['ignore', log, log],
    windowsHide: true,
  });
  return child;
}

function logTail(name: string, lines = 40) {
  const file = join(LOG_DIR, `${name}.log`);
  if (!existsSync(file)) return '';
  return readFileSync(file, 'utf8').split(/\r?\n/).slice(-lines).join('\n');
}

function exited(child: ChildProcess) {
  return child.exitCode !== null || child.signalCode !== null;
}

async function waitFor(name: string, url: string, child: ChildProcess, timeoutMs = 120_000) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    if (exited(child)) {
      throw new Error(`${name} exited with code ${child.exitCode}. Log tail:\n${logTail(name)}`);
    }
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(5_000) });
      if (res.ok) return;
    } catch {
      // not listening yet
    }
    if (Date.now() > end) {
      throw new Error(`${name} did not become ready at ${url}. Log tail:\n${logTail(name)}`);
    }
    await new Promise((r) => setTimeout(r, 500));
  }
}

async function build(app: SpaName) {
  const outDir = join(SPA_DIR, app);
  const stampFile = join(SPA_DIR, `${app}.json`);
  const stamp = JSON.stringify(SPA_ENV[app]);
  if (
    process.env.E2E_SKIP_SPA_BUILD === '1' &&
    existsSync(join(outDir, 'index.html')) &&
    existsSync(stampFile) &&
    readFileSync(stampFile, 'utf8') === stamp
  ) {
    console.log(`[e2e] reusing the ${app} build (E2E_SKIP_SPA_BUILD=1)`);
    return;
  }
  const name = `build-${app}`;
  const child = start(name, [viteBin, 'build', '--outDir', outDir, '--emptyOutDir'], {
    cwd: join(REPO_ROOT, 'apps', app),
    env: { ...process.env, ...SPA_ENV[app] },
  });
  const code = await new Promise<number | null>((resolve) => child.on('exit', resolve));
  if (code !== 0) throw new Error(`${app} build failed (${code}). Log tail:\n${logTail(name)}`);
  writeFileSync(stampFile, stamp);
}

export default async function globalSetup() {
  for (const dist of ['apps/api/dist/index.js', 'apps/worker/dist/index.js']) {
    if (!existsSync(join(REPO_ROOT, dist))) {
      throw new Error(`${dist} is missing: run \`corepack pnpm build\` before the e2e suite.`);
    }
  }
  mkdirSync(LOG_DIR, { recursive: true });
  mkdirSync(SPA_DIR, { recursive: true });
  rmSync(STORAGE_DIR, { recursive: true, force: true });
  mkdirSync(STORAGE_DIR, { recursive: true });

  const started = Date.now();
  console.log('[e2e] resetting the e2e database and Redis index; building the SPAs…');
  await Promise.all([resetStores(), build('candidate-web'), build('admin-web')]);

  const children: ChildProcess[] = [];
  const stopAll = async () => {
    for (const child of children) if (!exited(child)) child.kill();
    await Promise.all(
      children.map(
        (child) =>
          new Promise<void>((resolve) => {
            if (exited(child)) return resolve();
            const timer = setTimeout(() => {
              child.kill('SIGKILL');
              resolve();
            }, 10_000);
            child.once('exit', () => {
              clearTimeout(timer);
              resolve();
            });
          }),
      ),
    );
  };

  try {
    const env = serverEnv();
    const api = start('api', ['apps/api/dist/index.js'], {
      cwd: REPO_ROOT,
      env: {
        ...env,
        PORT_API: String(PORTS.api),
        CORS_ALLOWED_ORIGINS: `${URLS.candidate},${URLS.admin}`,
      },
    });
    children.push(api);
    const worker = start('worker', ['apps/worker/dist/index.js'], {
      cwd: REPO_ROOT,
      env: { ...env, WORKER_HEALTH_PORT: String(PORTS.worker) },
    });
    children.push(worker);
    const previews = (['candidate-web', 'admin-web'] as const).map((app) => {
      const port = app === 'candidate-web' ? PORTS.candidate : PORTS.admin;
      const child = start(
        app,
        [
          viteBin,
          'preview',
          '--outDir',
          join(SPA_DIR, app),
          '--port',
          String(port),
          '--strictPort',
          '--host',
          'localhost',
        ],
        { cwd: join(REPO_ROOT, 'apps', app), env: process.env },
      );
      children.push(child);
      return child;
    });

    await Promise.all([
      waitFor('api', `${URLS.api}/readyz`, api),
      waitFor('worker', `${URLS.workerHealth}/readyz`, worker),
      waitFor('candidate-web', URLS.candidate, previews[0]!),
      waitFor('admin-web', URLS.admin, previews[1]!),
    ]);
  } catch (err) {
    await stopAll();
    throw err;
  }
  console.log(
    `[e2e] stack ready in ${Math.round((Date.now() - started) / 1000)}s (logs: ${LOG_DIR})`,
  );

  return async () => {
    await stopAll();
  };
}

#!/usr/bin/env node
// Boots the *compiled* API and worker under plain Node (no Vite/tsx transforms),
// waits for /readyz, then sends SIGTERM and requires a clean exit.
//
// Catches problems unit tests cannot: ESM/CommonJS interop, missing runtime
// dependencies in dist/, env validation at startup, and graceful shutdown.
//
//   pnpm build && MONGODB_URI=... REDIS_URL=... node infrastructure/scripts/boot-smoke.mjs
import { spawn } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const { MONGODB_URI, REDIS_URL } = process.env;
if (!MONGODB_URI || !REDIS_URL) {
  console.error('boot-smoke: MONGODB_URI and REDIS_URL are required');
  process.exit(2);
}

const shared = {
  APP_ENV: 'test',
  LOG_LEVEL: 'warn',
  MONGODB_URI,
  REDIS_URL,
  SHUTDOWN_GRACE_MS: '5000',
};

const services = [
  {
    name: 'api',
    entry: 'apps/api/dist/index.js',
    url: 'http://127.0.0.1:4901/readyz',
    env: {
      ...shared,
      PORT_API: '4901',
      CORS_ALLOWED_ORIGINS: 'http://localhost:5173',
      PUBLIC_CANDIDATE_URL: 'http://localhost:5173',
      PUBLIC_ADMIN_URL: 'http://localhost:5174',
      JWT_ACCESS_SECRET: 'boot-smoke-jwt-secret-0123456789abcdef0123',
      OTP_HMAC_SECRET: 'boot-smoke-otp-secret-0123456789abcdef0123',
      EMAIL_PROVIDER: 'smtp',
      EMAIL_FROM: 'smoke@localhost',
      SMTP_HOST: '127.0.0.1',
      SMTP_PORT: '1',
      SMS_PROVIDER: 'disabled',
      // 32 bytes of 0x2a, base64. Smoke-test only.
      AI_SECRETS_MASTER_KEY: Buffer.alloc(32, 42).toString('base64'),
    },
  },
  {
    name: 'worker',
    entry: 'apps/worker/dist/index.js',
    url: 'http://127.0.0.1:4902/readyz',
    env: {
      ...shared,
      WORKER_HEALTH_PORT: '4902',
      AI_SECRETS_MASTER_KEY: Buffer.alloc(32, 42).toString('base64'),
    },
  },
];

async function waitReady(url, child, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`exited early with code ${child.exitCode}`);
    try {
      const res = await fetch(url, { headers: { connection: 'close' } });
      await res.body?.cancel();
      if (res.status === 200) return;
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`not ready within ${timeoutMs}ms`);
}

function stop(child) {
  return new Promise((resolveStop) => {
    child.once('exit', (code, signal) => resolveStop({ code, signal }));
    child.kill('SIGTERM');
  });
}

let failed = false;
for (const svc of services) {
  const output = [];
  const child = spawn(process.execPath, [join(root, svc.entry)], {
    cwd: root,
    env: { PATH: process.env.PATH, ...svc.env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (d) => output.push(d));
  child.stderr.on('data', (d) => output.push(d));
  try {
    await waitReady(svc.url, child);
    const { code, signal } = await stop(child);
    // On Windows, kill() terminates without running signal handlers.
    const clean = code === 0 || (process.platform === 'win32' && signal === 'SIGTERM');
    if (!clean) throw new Error(`shutdown exit code ${code} signal ${signal}`);
    console.log(`boot-smoke: ${svc.name} ready and shut down cleanly`);
  } catch (err) {
    failed = true;
    child.kill('SIGKILL');
    console.error(
      `boot-smoke: ${svc.name} FAILED: ${err.message}\n${Buffer.concat(output).toString()}`,
    );
  }
}
// exitCode (not exit()) lets sockets close first; avoids a libuv assertion on Windows.
process.exitCode = failed ? 1 : 0;

#!/usr/bin/env node
// Load test runner (Phase 12): starts the compiled API and worker with mock
// providers on a throwaway database, seeds N candidates with READY text
// interviews and signed access tokens, runs the k6 scenario (HTTP start +
// Socket.IO room + answers + end), then waits for the evaluation queue to turn
// every interview into a report and prints a summary.
//
//   corepack pnpm build && node tests/load/run.mjs [--vus 200] [--answers 4]
//
// Needs the dev stack (`corepack pnpm infra:up`: MongoDB replica set on
// localhost:27018, Redis on localhost:6380) and k6 on PATH (or K6_BIN).
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..');
const require = createRequire(join(repo, 'packages', 'db', 'package.json'));
const mongoose = require('mongoose');
const { SignJWT } = createRequire(join(repo, 'packages', 'auth-core', 'package.json'))('jose');
const { MongoClient, ObjectId } = mongoose.mongo;

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? Number(process.argv[i + 1]) : fallback;
};
const VUS = arg('vus', 200);
const ANSWERS = arg('answers', 4);
const PORT = 4995;
const API = `http://127.0.0.1:${PORT}`;
const ORIGIN = 'http://localhost:5173';
const JWT_SECRET = 'load-jwt-secret-0123456789abcdef0123456789';
const MONGODB_URI =
  process.env.LOAD_MONGODB_URI ??
  'mongodb://localhost:27018/cbi_interview_load?directConnection=true';
const shared = {
  ...process.env,
  APP_ENV: 'development',
  LOG_LEVEL: process.env.LOG_LEVEL ?? 'warn',
  MONGODB_URI,
  REDIS_URL: process.env.LOAD_REDIS_URL ?? 'redis://localhost:6380/14',
  AI_SECRETS_MASTER_KEY: Buffer.alloc(32, 7).toString('base64'),
  AI_MOCK_MODE: 'true',
  STORAGE_PROVIDER: 'local',
  LOCAL_STORAGE_DIR: mkdtempSync(join(tmpdir(), 'cbi-load-')),
  JUDGE_PROVIDER: 'mock',
  // Sign-in codes are never sent (tokens are minted); report emails go to the local mailpit.
  EMAIL_PROVIDER: 'smtp',
  EMAIL_FROM: 'load@localhost',
  SMTP_HOST: '127.0.0.1',
  SMTP_PORT: '1025',
  SMTP_REQUIRE_TLS: 'false',
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function until(label, fn, timeoutMs) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn().catch(() => null);
    if (v) return v;
    if (Date.now() > end) throw new Error(`timeout waiting for ${label}`);
    await sleep(1000);
  }
}

const mongo = await MongoClient.connect(MONGODB_URI);
const db = mongo.db();
await db.dropDatabase();
// Seed through the app's own models so every schema default is applied.
const models = await import(pathToFileURL(join(repo, 'packages', 'db', 'dist', 'index.js')).href);
await models.mongoose.connect(MONGODB_URI);

const procs = [
  spawn(
    'node',
    process.env.LOAD_PROFILE
      ? ['--cpu-prof', `--cpu-prof-dir=${process.env.LOAD_PROFILE}`, join(here, 'profiled-api.mjs')]
      : ['apps/api/dist/index.js'],
    {
      cwd: repo,
      stdio: ['ignore', process.env.LOAD_LOGS ? 'inherit' : 'ignore', 'inherit', 'ipc'],
      env: {
        ...shared,
        PORT_API: String(PORT),
        CORS_ALLOWED_ORIGINS: ORIGIN,
        PUBLIC_CANDIDATE_URL: ORIGIN,
        PUBLIC_ADMIN_URL: 'http://localhost:5174',
        JWT_ACCESS_SECRET: JWT_SECRET,
        JWT_ACCESS_TTL_SEC: '3600',
        OTP_HMAC_SECRET: 'load-otp-secret-0123456789abcdef0123456789',
        SMS_PROVIDER: 'disabled',
        // Like production behind NGINX: each candidate is rate-limited by their own address.
        TRUST_PROXY_HOPS: '1',
      },
    },
  ),
  spawn('node', ['apps/worker/dist/index.js'], {
    cwd: repo,
    stdio: ['ignore', 'ignore', 'inherit'],
    env: { ...shared, WORKER_HEALTH_PORT: String(PORT + 1), PUBLIC_CANDIDATE_URL: ORIGIN },
  }),
];

let exitCode = 1;
try {
  await until('api', async () => (await fetch(`${API}/readyz`)).ok, 90_000);
  await until(
    'worker',
    async () => (await fetch(`http://127.0.0.1:${PORT + 1}/readyz`)).ok,
    90_000,
  );
  // The API seeds the library at start.
  const role = await until(
    'library',
    () => db.collection('roles').findOne({ slug: 'backend-engineer' }),
    30_000,
  );
  const template = await db
    .collection('interviewTemplates')
    .findOne({ key: 'standard-practice', status: 'ACTIVE' });

  // ---- Seed candidates, READY text interviews and access tokens ----
  const key = new TextEncoder().encode(JWT_SECRET);
  const now = new Date();
  const users = [];
  for (let i = 0; i < VUS; i++) {
    const userId = new ObjectId();
    const targetId = new ObjectId();
    const sessionId = new ObjectId();
    users.push({ userId, targetId, sessionId });
  }
  await models.UserModel.insertMany(
    users.map((u, i) => ({
      _id: u.userId,
      primaryEmail: `load-${i}@example.com`,
      emailVerifiedAt: now,
      onboardingCompletedAt: now,
      adminRoles: [],
      status: 'ACTIVE',
      tokenVersion: 0,
      createdAt: now,
      updatedAt: now,
    })),
  );
  await models.UserProfileModel.insertMany(
    users.map((u) => ({ userId: u.userId, createdAt: now, updatedAt: now })),
  );
  await models.JobTargetModel.insertMany(
    users.map((u) => ({
      _id: u.targetId,
      userId: u.userId,
      source: 'ROLE_ONLY',
      roleId: role._id,
      roleTitle: role.title,
      extraction: { status: 'READY', parser: 'none', completedAt: now },
      createdAt: now,
      updatedAt: now,
    })),
  );
  await models.InterviewSessionModel.insertMany(
    users.map((u) => ({
      _id: u.sessionId,
      userId: u.userId,
      jobTargetId: u.targetId,
      resumeId: null,
      templateId: template._id,
      blueprintId: role.activeBlueprintId,
      mode: 'TEXT',
      language: 'en',
      state: 'READY',
      analysisAttempts: 1,
    })),
  );
  const tokens = await Promise.all(
    users.map(async (u) => ({
      sessionId: String(u.sessionId),
      token: await new SignJWT({ sid: `load-${u.userId}`, tv: 0, roles: [] })
        .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
        .setSubject(String(u.userId))
        .setAudience('candidate')
        .setIssuer('cbi-api')
        .setIssuedAt()
        .setExpirationTime('1h')
        .sign(key),
    })),
  );
  const dataFile = join(tmpdir(), `cbi-load-${Date.now()}.json`);
  writeFileSync(dataFile, JSON.stringify(tokens));
  console.log(`seeded ${VUS} candidates with READY interviews`);
  if (process.env.LOAD_DB_PROFILE)
    await db.command({
      profile: Number(process.env.LOAD_DB_PROFILE),
      slowms: Number(process.env.LOAD_SLOWMS ?? 100),
    });

  // Optional: MongoDB round-trip times from this host while k6 runs.
  const rtts = [];
  const pinger = process.env.LOAD_PING
    ? setInterval(() => {
        const t = performance.now();
        void db.command({ ping: 1 }).then(() => rtts.push(performance.now() - t));
      }, 200)
    : null;

  // ---- k6 ----
  const resultsDir = join(here, 'results');
  mkdirSync(resultsDir, { recursive: true });
  const summaryFile = join(resultsDir, `summary-${VUS}vus.json`);
  const k6 = spawn(
    process.env.K6_BIN ?? 'k6',
    ['run', '--quiet', '--summary-export', summaryFile, join(here, 'interview.k6.js')],
    {
      cwd: repo,
      stdio: 'inherit',
      env: {
        ...process.env,
        API,
        ORIGIN,
        DATA_FILE: dataFile,
        VUS: String(VUS),
        ANSWERS: String(ANSWERS),
      },
    },
  );
  const k6Code = await new Promise((resolve) => k6.on('exit', resolve));
  if (pinger) {
    clearInterval(pinger);
    rtts.sort((x, y) => x - y);
    const q = (f) => rtts[Math.floor(f * (rtts.length - 1))]?.toFixed(1);
    console.log(`mongo ping rtt ms: p50 ${q(0.5)} p95 ${q(0.95)} max ${q(1)} (n=${rtts.length})`);
  }

  if (process.env.LOAD_DB_PROFILE) {
    await db.command({ profile: 0 });
    const ops = await db
      .collection('system.profile')
      .aggregate([
        { $match: { ns: { $not: /system\./ } } },
        { $group: { _id: { op: '$op', ns: '$ns' }, n: { $sum: 1 }, ms: { $sum: '$millis' } } },
        { $sort: { n: -1 } },
      ])
      .toArray();
    writeFileSync(join(resultsDir, 'db-ops.json'), JSON.stringify(ops, null, 2));
  }
  // ---- Queue: every ended interview must reach a report ----
  const started = Date.now();
  const ids = users.map((u) => u.sessionId);
  const counts = async () =>
    Object.fromEntries(
      (
        await db
          .collection('interviewSessions')
          .aggregate([
            { $match: { _id: { $in: ids } } },
            { $group: { _id: '$state', n: { $sum: 1 } } },
          ])
          .toArray()
      ).map((r) => [r._id, r.n]),
    );
  let states = await counts();
  while ((states.PROCESSING ?? 0) > 0 && Date.now() - started < 15 * 60_000) {
    await sleep(5000);
    states = await counts();
  }
  const drainSec = Math.round((Date.now() - started) / 1000);
  const reports = await db
    .collection('interviewReports')
    .countDocuments({ sessionId: { $in: ids } });
  console.log(
    `queue drained in ${drainSec}s; states ${JSON.stringify(states)}; reports ${reports}`,
  );
  writeFileSync(
    join(resultsDir, `queue-${VUS}vus.json`),
    JSON.stringify({ vus: VUS, drainSec, states, reports }, null, 2),
  );
  exitCode =
    k6Code === 0 && (states.PROCESSING ?? 0) === 0 && reports === (states.REPORT_READY ?? 0)
      ? 0
      : 1;
} catch (err) {
  console.error('load test error', err);
} finally {
  if (process.env.LOAD_PROFILE) procs[0].send('stop');
  await sleep(process.env.LOAD_PROFILE ? 5000 : 0);
  for (const p of procs) p.kill('SIGTERM');
  await sleep(2000);
  await db.dropDatabase().catch(() => undefined);
  await mongo.close();
  await models.mongoose.disconnect();
  process.exit(exitCode);
}

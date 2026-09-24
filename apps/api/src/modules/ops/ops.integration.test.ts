import {
  AiUsageModel,
  AnalyticsDailyModel,
  AnalyticsEventModel,
  AuditLogModel,
  ensureOpsDefaults,
  InterviewReportModel,
  InterviewSessionModel,
  istDay,
  mongoose,
  PurchaseModel,
  ShareLinkModel,
  UserModel,
  UserProfileModel,
} from '@cbi/db';
import type { FailedJob } from '@cbi/shared-types';
import {
  ClientFlags,
  CostReport,
  CreatedShareLink,
  Dashboard,
  ProofView,
  QueueName,
  SystemHealth,
  WORKER_HEARTBEAT_KEY_PREFIX,
  type AdminRole,
} from '@cbi/shared-types';
import { Queue, Worker } from 'bullmq';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildTestApp, TEST_ORIGIN } from '../../test-support/harness.js';
import { signInWithEmail, useIntegrationServices } from '../../test-support/integration.js';

const { redis } = useIntegrationServices();

let t: Awaited<ReturnType<typeof buildTestApp>>;
const closers: (() => Promise<unknown>)[] = [];

beforeEach(async () => {
  t = await buildTestApp({ redis });
  await ensureOpsDefaults();
});
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
});

type Method = 'get' | 'post' | 'put' | 'delete';

async function candidate(email = 'asha@example.com') {
  const { accessToken, user } = await signInWithEmail(t.app, t.email.sent, email);
  const call = (method: Method, path: string) =>
    request(t.app)
      [method](`/api/v1${path}`)
      .set('Origin', TEST_ORIGIN)
      .set('Authorization', `Bearer ${accessToken}`);
  return { userId: String(user.id), call };
}

async function adminAs(roles: AdminRole[], email = `${roles[0]!.toLowerCase()}@codebegun.com`) {
  const user = await UserModel.create({ primaryEmail: email, adminRoles: roles });
  await UserProfileModel.create({ userId: user._id });
  const { accessToken } = await signInWithEmail(t.app, t.email.sent, email, 'admin');
  return (method: Method, path: string) =>
    request(t.app)
      [method](`/api/v1/admin${path}`)
      .set('Origin', TEST_ORIGIN)
      .set('Authorization', `Bearer ${accessToken}`);
}

const publicCall = (method: Method, path: string) =>
  request(t.app)[method](`/api/v1${path}`).set('Origin', TEST_ORIGIN);

const today = () => istDay(new Date());

describe('permissions', () => {
  it('limits analytics and operations to the right roles', async () => {
    const content = await adminAs(['CONTENT_ADMIN']);
    const support = await adminAs(['SUPPORT_ADMIN']);
    const finance = await adminAs(['FINANCE_ADMIN']);
    const ops = await adminAs(['OPERATIONS_ADMIN']);
    const flag = { enabled: true, rolloutPercent: 100, reason: 'try' };

    for (const denied of [content, support]) {
      await denied('get', '/analytics/dashboard').expect(403);
      await denied('get', '/system/health').expect(403);
    }
    await finance('get', '/analytics/dashboard').expect(200);
    await finance('get', '/analytics/costs').expect(200);
    await finance('get', '/system/health').expect(403);
    await finance('get', '/flags').expect(403);

    await ops('get', '/analytics/dashboard').expect(200);
    await ops('get', '/system/health').expect(200);
    await ops('get', '/flags').expect(200);
    await ops('get', '/settings').expect(200);
    // Flags and settings are SUPER_ADMIN only.
    await ops('put', '/flags/reports.publicProof').send(flag).expect(403);
    await ops('put', '/settings/maintenance')
      .send({ value: { enabled: true, message: '' }, reason: 'try' })
      .expect(403);
  });
});

describe('analytics ingestion', () => {
  it('stores allow-listed events, with the user when signed in and no IP', async () => {
    const anon = await publicCall('post', '/analytics/events')
      .send({
        anonId: 'anon_12345678',
        events: [{ name: 'page_view', path: '/pricing', props: { plan: 'starter' } }],
      })
      .expect(202);
    expect(anon.body.data).toEqual({ accepted: 1 });
    const asha = await candidate();
    await asha
      .call('post', '/analytics/events')
      .send({
        anonId: 'anon_12345678',
        events: [
          { name: 'report_viewed', path: '/app/reports/:id' },
          // A timestamp from last week is not trusted.
          { name: 'pricing_viewed', at: new Date(Date.now() - 7 * 86_400_000).toISOString() },
        ],
      })
      .expect(202);
    const stored = await AnalyticsEventModel.find().sort({ receivedAt: 1, name: 1 }).lean();
    expect(stored.map((e) => [e.name, e.userId ? String(e.userId) : null])).toEqual([
      ['page_view', null],
      ['pricing_viewed', asha.userId],
      ['report_viewed', asha.userId],
    ]);
    const old = stored.find((e) => e.name === 'pricing_viewed')!;
    expect(old.at.getTime()).toBe(old.receivedAt.getTime());
    expect(JSON.stringify(stored)).not.toMatch(/127\.0\.0\.1|::ffff/);
  });

  it('rejects unknown events, URLs with queries and oversized batches', async () => {
    const send = (events: unknown[]) =>
      publicCall('post', '/analytics/events').send({ anonId: 'anon_12345678', events });
    await send([{ name: 'purchase_paid' }]).expect(400); // server-side facts are not client events
    await send([{ name: 'page_view', path: '/login?email=a@b.c' }]).expect(400);
    await send([{ name: 'page_view', props: { Email: 'a@b.c' } }]).expect(400);
    await send(Array.from({ length: 26 }, () => ({ name: 'page_view' }))).expect(400);
    await publicCall('post', '/analytics/events')
      .send({ anonId: 'x', events: [{ name: 'page_view' }] })
      .expect(400);
    expect(await AnalyticsEventModel.countDocuments()).toBe(0);
  });
});

describe('rollups and the dashboard', () => {
  async function seed() {
    const asha = await candidate();
    await candidate('ravi@example.com');
    const now = new Date();
    const started = await InterviewSessionModel.create({
      userId: asha.userId,
      jobTargetId: new mongoose.Types.ObjectId(),
      templateId: new mongoose.Types.ObjectId(),
      state: 'REPORT_READY',
      startedAt: now,
      endedAt: now,
    });
    await PurchaseModel.create({
      userId: asha.userId,
      planId: new mongoose.Types.ObjectId(),
      plan: { code: 'starter', version: 1, name: 'Starter', credits: 3, validityDays: null },
      couponId: null,
      couponCode: null,
      listPriceMinor: 49_900,
      discountMinor: 0,
      amountMinor: 49_900,
      currency: 'INR',
      status: 'PAID',
      statusHistory: [
        { status: 'CREATED', at: now, source: 'test' },
        { status: 'PAID', at: now, source: 'test' },
      ],
    });
    const usage = (feature: string, provider: string, costMicros: number, currency = 'USD') => ({
      at: now,
      feature,
      provider,
      providerId: new mongoose.Types.ObjectId(),
      modelRef: new mongoose.Types.ObjectId(),
      model: `${provider}-model`,
      servedModel: null,
      sessionId: String(started._id),
      userId: null,
      correlationId: null,
      promptKey: null,
      promptVersion: null,
      units: { inputTokens: 1, cachedInputTokens: 0, outputTokens: 1, requests: 1 },
      latencyMs: 100,
      attempt: 1,
      outcome: 'SUCCESS',
      errorCode: null,
      priceSnapshot: null,
      costMicros,
      currency,
    });
    await AiUsageModel.insertMany([
      usage('interview.question', 'openai', 600_000),
      usage('interview.question', 'openai', 200_000),
      usage('role.analyze', 'anthropic', 200_000),
    ]);
    await asha
      .call('post', '/analytics/events')
      .send({ anonId: 'anon_12345678', events: [{ name: 'report_viewed' }] })
      .expect(202);
    return asha;
  }

  it('computes KPIs, funnel and margin from the rollups', async () => {
    await seed();
    const ops = await adminAs(['OPERATIONS_ADMIN']);
    const day = today();
    await ops('post', '/analytics/rollup')
      .send({ from: day, to: day, reason: 'backfill' })
      .expect(200);
    // Recomputing is idempotent.
    await ops('post', '/analytics/rollup')
      .send({ from: day, to: day, reason: 'again' })
      .expect(200);
    expect(
      await AnalyticsDailyModel.countDocuments({ day, metric: 'registrations', dimsHash: '' }),
    ).toBe(1);

    const d = Dashboard.parse(
      (await ops('get', `/analytics/dashboard?from=${day}&to=${day}`).expect(200)).body.data,
    );
    expect(d.kpis).toMatchObject({
      registrations: 2,
      interviewsStarted: 1,
      interviewsCompleted: 1,
      completionRate: 1,
      freeToPaidRate: 0.5,
      revenueMinor: 49_900,
      // $1.00 at ₹84 = ₹84.00
      aiCostMinor: 8_400,
      gatewayFeesMinor: 998,
    });
    expect(d.kpis.grossMargin).toBeCloseTo((49_900 - 8_400 - 998) / 49_900, 3);
    expect(d.funnel.map((f) => f.users)).toEqual([2, 0, 1, 1, 1, 1, 1]);
    expect(d.series).toHaveLength(1);
    expect(d.targets.completionRate).toBe(0.7);
    expect(d.computedAt).not.toBeNull();

    const byProvider = CostReport.parse(
      (await ops('get', `/analytics/costs?from=${day}&to=${day}&groupBy=provider`).expect(200)).body
        .data,
    );
    expect(byProvider.rows.map((r) => [r.key, r.calls, r.costMinor])).toEqual([
      ['openai', 2, 6_720],
      ['anthropic', 1, 1_680],
    ]);
    expect(byProvider.totals.aiCostPerInterviewMinor).toBe(8_400);
    await ops('get', `/analytics/costs?from=${day}&to=2020-01-01`).expect(400);
  });

  it('uses the configured exchange rate and India-time days', async () => {
    const zero = await adminAs(['SUPER_ADMIN']);
    await zero('put', '/settings/finance')
      .send({ value: { usdToInr: 90, gatewayFeeRate: 0 }, reason: 'new rate' })
      .expect(200);
    // 23:59 and 00:01 India time on either side of midnight.
    const before = new Date('2026-09-23T18:29:00Z');
    const after = new Date('2026-09-23T18:31:00Z');
    await UserModel.create([
      { primaryEmail: 'a@example.com', createdAt: before },
      { primaryEmail: 'b@example.com', createdAt: after },
    ]);
    await zero('post', '/analytics/rollup')
      .send({ from: '2026-09-23', to: '2026-09-24', reason: 'check days' })
      .expect(200);
    const d = Dashboard.parse(
      (await zero('get', '/analytics/dashboard?from=2026-09-23&to=2026-09-24').expect(200)).body
        .data,
    );
    expect(d.series.map((s) => [s.day, s.registrations])).toEqual([
      ['2026-09-23', 1],
      ['2026-09-24', 1],
    ]);
    expect(d.usdToInr).toBe(90);
    await zero('get', '/analytics/dashboard?from=2024-01-01&to=2026-09-24').expect(400);
  });
});

describe('feature flags and settings', () => {
  it('sends client flags, applies rollouts and audits changes', async () => {
    const superAdmin = await adminAs(['SUPER_ADMIN']);
    const flags = async (call = publicCall) =>
      ClientFlags.parse((await call('get', '/flags').expect(200)).body.data);
    expect(await flags()).toEqual({ 'reports.publicProof': false });

    await superAdmin('put', '/flags/reports.publicProof')
      .send({ enabled: true, rolloutPercent: 100, reason: 'launch' })
      .expect(200);
    expect(await flags()).toEqual({ 'reports.publicProof': true });

    // A 0% rollout is on for nobody; partial rollouts never apply to anonymous visitors.
    await superAdmin('put', '/flags/reports.publicProof')
      .send({ enabled: true, rolloutPercent: 0, reason: 'pause rollout' })
      .expect(200);
    const asha = await candidate();
    expect(await flags(asha.call as typeof publicCall)).toEqual({ 'reports.publicProof': false });
    await superAdmin('put', '/flags/unknown.flag')
      .send({ enabled: true, rolloutPercent: 100, reason: 'unknown' })
      .expect(404);
    expect(await AuditLogModel.countDocuments({ action: 'flag.updated' })).toBe(2);
  });

  it('validates settings, and maintenance mode stops new interviews only', async () => {
    const superAdmin = await adminAs(['SUPER_ADMIN']);
    await superAdmin('put', '/settings/finance')
      .send({ value: { usdToInr: -1, gatewayFeeRate: 0.02 }, reason: 'bad' })
      .expect(400);
    await superAdmin('put', '/settings/nope').send({ value: {}, reason: 'bad' }).expect(404);
    await superAdmin('put', '/settings/maintenance')
      .send({ value: { enabled: true, message: 'Back at 10 pm IST' }, reason: 'deploy' })
      .expect(200);
    const status = await publicCall('get', '/system/status').expect(200);
    expect(status.body.data.maintenance).toEqual({ enabled: true, message: 'Back at 10 pm IST' });

    const asha = await candidate();
    const s = await InterviewSessionModel.create({
      userId: asha.userId,
      jobTargetId: new mongoose.Types.ObjectId(),
      templateId: new mongoose.Types.ObjectId(),
      blueprintId: new mongoose.Types.ObjectId(),
      state: 'READY',
      mode: 'TEXT',
    });
    const res = await asha.call('post', `/interviews/${String(s._id)}/start`).expect(503);
    expect(res.body.error).toMatchObject({ code: 'MAINTENANCE', message: 'Back at 10 pm IST' });
    expect(await AuditLogModel.countDocuments({ action: 'setting.updated' })).toBe(1);
  });
});

describe('system health and queues', () => {
  it('reports dependencies, worker heartbeats, queues and stuck interviews', async () => {
    const ops = await adminAs(['OPERATIONS_ADMIN']);
    await redis.set(
      `${WORKER_HEARTBEAT_KEY_PREFIX}w-1`,
      JSON.stringify({
        workerId: 'w-1',
        version: '1.0.0',
        at: new Date().toISOString(),
        queues: ['system'],
      }),
      'PX',
      60_000,
    );
    await InterviewSessionModel.collection.insertOne({
      userId: new mongoose.Types.ObjectId(),
      state: 'PROCESSING',
      updatedAt: new Date(Date.now() - 3600_000),
    });
    const h = SystemHealth.parse((await ops('get', '/system/health').expect(200)).body.data);
    expect(h.dependencies.every((d) => d.ok)).toBe(true);
    expect(h.workers.map((w) => w.workerId)).toEqual(['w-1']);
    expect(h.queues.map((q) => q.name).sort()).toEqual(Object.values(QueueName).sort());
    expect(h.sessions).toMatchObject({ processing: 1, stuck: 1 });
  });

  it('lists failed jobs (ids only) and retries one, audited', async () => {
    const ops = await adminAs(['OPERATIONS_ADMIN']);
    const support = await adminAs(['SUPPORT_ADMIN']);
    const conn = redis.duplicate({ maxRetriesPerRequest: null });
    closers.push(() => conn.quit());
    const queue = new Queue(QueueName.DOCUMENTS, { connection: conn });
    closers.push(() => queue.close());
    const worker = new Worker(
      QueueName.DOCUMENTS,
      async () => {
        throw new Error('parser crashed on page 3');
      },
      { connection: conn.duplicate({ maxRetriesPerRequest: null }) },
    );
    const failed = new Promise((resolve) => worker.once('failed', resolve));
    const job = await queue.add('resume.extract', { resumeId: 'r1', secret: 'x'.repeat(100) });
    await failed;
    await worker.close();

    const list = (await ops('get', `/system/queues/${QueueName.DOCUMENTS}/failed`).expect(200)).body
      .data as FailedJob[];
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      id: job.id,
      name: 'resume.extract',
      failedReason: 'parser crashed on page 3',
      data: { resumeId: 'r1' },
    });
    await ops('get', '/system/queues/nope/failed').expect(404);

    const retry = (who: typeof ops, id: string) =>
      who('post', `/system/queues/${QueueName.DOCUMENTS}/jobs/${id}/retry`).send({
        reason: 'parser fixed',
      });
    await retry(support, job.id!).expect(403);
    await retry(ops, job.id!).expect(200);
    expect(await queue.getJobState(job.id!)).toBe('waiting');
    await retry(ops, job.id!).expect(404); // no longer failed
    await retry(ops, 'missing').expect(404);
    expect(await AuditLogModel.countDocuments({ action: 'queue.job_retried' })).toBe(1);
  });
});

describe('candidate proof (flagged)', () => {
  async function reported(userId: string, visible = true) {
    const s = await InterviewSessionModel.create({
      userId,
      jobTargetId: new mongoose.Types.ObjectId(),
      templateId: new mongoose.Types.ObjectId(),
      state: 'REPORT_READY',
      mode: 'TEXT',
    });
    await InterviewReportModel.create({
      sessionId: s._id,
      userId,
      revision: 0,
      scoreRevision: 0,
      visibility: { candidate: visible },
      generatedAt: new Date(),
      overall: 72,
      content: {
        schemaVersion: 1,
        header: {
          title: 'Backend Engineer',
          companyName: 'Acme',
          mode: 'TEXT',
          language: 'en',
          startedAt: null,
          endedAt: '2026-09-24T10:25:00.000Z',
          durationSec: 1500,
          endReason: 'ROUND_ENDED',
        },
        overall: {
          score: 72,
          band: 'READY_WITH_GAPS',
          confidence: {
            level: 'MEDIUM',
            value: 0.6,
            factors: {
              independentQuestions: 1,
              practicalEvidence: 1,
              consistency: 1,
              completeness: 1,
            },
          },
          assessedWeight: 1,
        },
        summary: 'Private summary',
        dimensions: [
          {
            key: 'api',
            name: 'API design',
            category: 'TECHNICAL',
            weight: 100,
            score: 72,
            rationale: 'Private rationale',
            evidence: [],
            fallback: false,
          },
        ],
        strengths: [],
        gaps: [],
        rounds: [],
        coverage: [],
        plan: { next24h: [], next3Days: [], next7Days: [] },
        previous: null,
        transcript: [{ seq: 1, roundType: 'INTRO', question: 'Q', answer: 'SECRET ANSWER' }],
        disclaimer: 'AI-generated estimate.',
      },
    });
    return String(s._id);
  }

  it('does not exist while the flag is off', async () => {
    const asha = await candidate();
    const id = await reported(asha.userId);
    await asha.call('post', `/reports/${id}/shares`).send({}).expect(404);
    await asha.call('get', `/reports/${id}/shares`).expect(404);
    await publicCall('get', '/proof/AAAAAAAAAAAAAAAAAAAAAAAA').expect(404);
  });

  it('shares a score-only proof that can expire and be revoked', async () => {
    const superAdmin = await adminAs(['SUPER_ADMIN']);
    await superAdmin('put', '/flags/reports.publicProof')
      .send({ enabled: true, rolloutPercent: 100, reason: 'launch' })
      .expect(200);
    const asha = await candidate();
    const ravi = await candidate('ravi@example.com');
    await UserProfileModel.updateOne({ userId: asha.userId }, { $set: { displayName: 'Asha' } });
    const id = await reported(asha.userId);

    const created = CreatedShareLink.parse(
      (await asha.call('post', `/reports/${id}/shares`).send({ expiresInDays: 7 }).expect(201)).body
        .data,
    );
    const token = created.path.split('/').pop()!;
    expect(JSON.stringify(await ShareLinkModel.findOne().lean())).not.toContain(token);

    const res = await publicCall('get', `/proof/${token}`).expect(200);
    expect(res.headers['x-robots-tag']).toBe('noindex');
    const proof = ProofView.parse(res.body.data);
    expect(proof).toMatchObject({
      candidateName: 'Asha',
      roleTitle: 'Backend Engineer',
      overall: 72,
    });
    // Scores only: no transcript, rationale, summary or company.
    expect(JSON.stringify(res.body)).not.toMatch(/SECRET ANSWER|Private|Acme/);
    await publicCall('get', `/proof/${token}`).expect(200);
    expect((await ShareLinkModel.findOne().lean())!.views).toBe(2);

    // Another candidate can neither see nor revoke it.
    await ravi
      .call('get', `/reports/${id}/shares`)
      .expect(200)
      .expect((r) => {
        expect(r.body.data).toEqual([]);
      });
    await ravi.call('delete', `/reports/shares/${created.link.id}`).expect(404);

    await asha.call('delete', `/reports/shares/${created.link.id}`).expect(200);
    await publicCall('get', `/proof/${token}`).expect(404);

    const second = CreatedShareLink.parse(
      (await asha.call('post', `/reports/${id}/shares`).send({}).expect(201)).body.data,
    );
    await ShareLinkModel.updateOne(
      { _id: second.link.id },
      { $set: { expiresAt: new Date(Date.now() - 1000) } },
    );
    await publicCall('get', `/proof/${second.path.split('/').pop()}`).expect(404);

    // Hidden (campaign) reports cannot be shared.
    const hidden = await reported(asha.userId, false);
    await asha.call('post', `/reports/${hidden}/shares`).send({}).expect(404);
    expect(await AuditLogModel.countDocuments({ action: 'proof.link_created' })).toBe(2);
  });

  it('caps active links per report', async () => {
    const superAdmin = await adminAs(['SUPER_ADMIN']);
    await superAdmin('put', '/flags/reports.publicProof')
      .send({ enabled: true, rolloutPercent: 100, reason: 'launch' })
      .expect(200);
    const asha = await candidate();
    const id = await reported(asha.userId);
    for (let i = 0; i < 5; i++)
      await asha.call('post', `/reports/${id}/shares`).send({}).expect(201);
    await asha.call('post', `/reports/${id}/shares`).send({}).expect(409);
  });
});

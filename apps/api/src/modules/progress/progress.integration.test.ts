import { emailLinkKey, signEmailLink } from '@cbi/auth-core';
import {
  AuditLogModel,
  BadgeAwardModel,
  CertificateModel,
  CreditLedgerModel,
  ensureLibraryCatalog,
  FeatureFlagModel,
  InterviewReportModel,
  InterviewSessionModel,
  InterviewTemplateModel,
  JobTargetModel,
  mongoose,
  RoleBlueprintModel,
  RoleModel,
  SystemSettingModel,
  UserProfileModel,
} from '@cbi/db';
import {
  CertificateStatus,
  CertificateVerification,
  DrillResult,
  InterviewSummary,
  ProgressOverview,
  type ReportContent,
} from '@cbi/shared-types';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { buildTestApp, TEST_ORIGIN } from '../../test-support/harness.js';
import { signInWithEmail, useIntegrationServices } from '../../test-support/integration.js';

const { redis } = useIntegrationServices();

let t: Awaited<ReturnType<typeof buildTestApp>>;

beforeEach(async () => {
  t = await buildTestApp({ redis });
  await ensureLibraryCatalog();
});

type Method = 'get' | 'post' | 'put';

async function candidate(email = 'asha@example.com') {
  const { accessToken, user } = await signInWithEmail(t.app, t.email.sent, email);
  const call = (method: Method, path: string) =>
    request(t.app)
      [method](`/api/v1${path}`)
      .set('Origin', TEST_ORIGIN)
      .set('Authorization', `Bearer ${accessToken}`);
  return { call, userId: String(user.id) };
}

const publicCall = (method: Method, path: string) =>
  request(t.app)[method](`/api/v1${path}`).set('Origin', TEST_ORIGIN);

async function switchProofFlag(enabled: boolean) {
  await FeatureFlagModel.updateOne(
    { key: 'reports.publicProof' },
    { $set: { enabled, rolloutPercent: 100, description: 'proof', clientVisible: true } },
    { upsert: true },
  );
  t.container.opsChanges.invalidateLocal();
}

async function setPractice(value: Record<string, unknown>) {
  await SystemSettingModel.updateOne(
    { key: 'practice' },
    {
      $set: {
        value: {
          drillsPerDay: 3,
          drillQuestions: 3,
          certificateMinBand: 'READY_WITH_GAPS',
          defaultWeeklyGoal: 3,
          ...value,
        },
      },
    },
    { upsert: true },
  );
  t.container.opsChanges.invalidateLocal();
}

function content(overall: number | null, scores: Record<string, number | null>, endedAt: string) {
  return {
    schemaVersion: 1,
    header: {
      title: 'Backend Engineer',
      companyName: null,
      mode: 'VOICE',
      language: 'en',
      startedAt: endedAt,
      endedAt,
      durationSec: 1500,
      endReason: 'ROUND_ENDED',
    },
    overall: {
      score: overall,
      band:
        overall === null
          ? 'INSUFFICIENT_EVIDENCE'
          : overall >= 65
            ? 'READY_WITH_GAPS'
            : 'DEVELOPING',
      confidence: {
        level: 'MEDIUM',
        value: 0.6,
        factors: {
          independentQuestions: 0.8,
          practicalEvidence: 0.4,
          consistency: 0.7,
          completeness: 0.9,
        },
      },
      assessedWeight: 0.9,
    },
    summary: 'Solid API design, with gaps in system design.',
    dimensions: Object.entries(scores).map(([key, score]) => ({
      key,
      name: key.replace('-', ' '),
      category: 'TECHNICAL',
      weight: 50,
      score,
      rationale: null,
      evidence: [],
      fallback: false,
    })),
    strengths: [],
    gaps: [],
    rounds: [],
    coverage: [],
    plan: {
      next24h: [
        { action: 'Write two examples.', why: 'Examples help.', dimensionKey: 'api-design' },
      ],
      next3Days: [{ action: 'Practise aloud.', why: 'Fluency helps.', dimensionKey: null }],
      next7Days: [{ action: 'Retake the interview.', why: 'See progress.', dimensionKey: null }],
    },
    previous: null,
    transcript: null,
    disclaimer: 'AI-generated estimate.',
  } satisfies ReportContent;
}

/** A finished interview (or drill) with its report, at the backend role from the library. */
async function finished(
  userId: string,
  opts: {
    overall?: number | null;
    scores?: Record<string, number | null>;
    endedAt?: string;
    kind?: 'INTERVIEW' | 'DRILL';
  } = {},
) {
  const role = await RoleModel.findOne({ slug: 'backend-engineer' }).lean();
  const blueprint = await RoleBlueprintModel.findById(role!.activeBlueprintId).lean();
  const template = await InterviewTemplateModel.findOne({ key: 'standard-practice' }).lean();
  const target = await JobTargetModel.create({
    userId,
    source: 'ROLE_ONLY',
    roleId: role!._id,
    roleTitle: role!.title,
    extraction: { status: 'READY' },
  });
  const endedAt = opts.endedAt ?? new Date().toISOString();
  const session = await InterviewSessionModel.create({
    userId,
    kind: opts.kind ?? 'INTERVIEW',
    drill:
      opts.kind === 'DRILL'
        ? {
            competencyKey: 'api-design',
            competencyName: 'API design',
            sourceSessionId: new mongoose.Types.ObjectId(),
          }
        : null,
    jobTargetId: target._id,
    templateId: template!._id,
    blueprintId: blueprint!._id,
    mode: 'VOICE',
    state: 'REPORT_READY',
    endedAt: new Date(endedAt),
    credit: { status: opts.kind === 'DRILL' ? 'FREE' : 'CONSUMED', lotId: null },
  });
  const competencyKeys = blueprint!.content.competencies.map((c) => c.key);
  await InterviewReportModel.create({
    sessionId: session._id,
    userId,
    revision: 0,
    scoreRevision: 0,
    kind: opts.kind ?? 'INTERVIEW',
    content: content(
      opts.overall === undefined ? 70 : opts.overall,
      opts.scores ?? { [competencyKeys[0]!]: 72, [competencyKeys[1]!]: 58 },
      endedAt,
    ),
    roleKey: `role:${String(role!._id)}`,
    overall: opts.overall === undefined ? 70 : opts.overall,
    generatedAt: new Date(endedAt),
  });
  return { id: String(session._id), keys: competencyKeys };
}

const overview = async (c: Awaited<ReturnType<typeof candidate>>) =>
  ProgressOverview.parse((await c.call('get', '/users/me/progress').expect(200)).body.data);

describe('progress hub', () => {
  it('starts empty for a new candidate', async () => {
    const asha = await candidate();
    const hub = await overview(asha);
    expect(hub.readiness).toEqual({ latest: null, delta: null, trend: [] });
    expect(hub.plan).toBeNull();
    expect(hub.dimensions).toEqual([]);
    expect(hub.streak).toMatchObject({ current: 0, longest: 0, practicedToday: false });
    expect(hub.goals).toMatchObject({ weeklyTarget: 3, weekCompleted: 0, targetDate: null });
    expect(hub.badges.every((b) => !b.earned)).toBe(true);
    expect(hub.drills).toEqual({ freePerDay: 3, usedToday: 0, remainingToday: 3, questions: 3 });
  });

  it('builds trends across interviews and drills, and awards badges once', async () => {
    const asha = await candidate();
    const day = 24 * 3600 * 1000;
    const first = await finished(asha.userId, {
      overall: 55,
      endedAt: new Date(Date.now() - 2 * day).toISOString(),
    });
    const [k0, k1] = first.keys;
    await finished(asha.userId, {
      overall: 67,
      scores: { [k0!]: 78, [k1!]: 60 },
      endedAt: new Date(Date.now() - day).toISOString(),
    });
    await finished(asha.userId, { kind: 'DRILL', overall: 81, scores: { [k1!]: 81 } });

    const hub = await overview(asha);
    expect(hub.readiness.trend.map((p) => p.overall)).toEqual([55, 67]);
    expect(hub.readiness.delta).toBe(12);
    const second = hub.dimensions.find((d) => d.key === k1)!;
    expect(second.points.map((p) => [p.score, p.kind])).toEqual([
      [58, 'INTERVIEW'],
      [60, 'INTERVIEW'],
      [81, 'DRILL'],
    ]);
    expect(hub.streak).toMatchObject({ current: 3, longest: 3, practicedToday: true });
    expect(hub.totals).toEqual({ interviews: 2, drills: 1 });
    expect(hub.plan?.items.map((i) => [i.id, i.done])).toEqual([
      ['next24h.0', false],
      ['next3Days.0', false],
      ['next7Days.0', false],
    ]);
    const earned = hub.badges.filter((b) => b.earned).map((b) => b.key);
    expect(earned).toEqual([
      'FIRST_INTERVIEW',
      'FIRST_VOICE_INTERVIEW',
      'STREAK_3',
      'READINESS_PLUS_10',
    ]);

    await overview(asha);
    expect(await BadgeAwardModel.countDocuments({ userId: asha.userId })).toBe(4);
    // Drills stay out of report history.
    const history = (await asha.call('get', '/reports').expect(200)).body.data as unknown[];
    expect(history).toHaveLength(2);
  });

  it('ticks plan items for the owner only and awards PLAN_COMPLETE', async () => {
    const asha = await candidate();
    const ravi = await candidate('ravi@example.com');
    const { id } = await finished(asha.userId);
    const tick = (who: typeof asha, itemId: string, done = true) =>
      who
        .call('put', '/users/me/progress/plan-items')
        .send({ sessionId: id, revision: 0, itemId, done });

    const res = await tick(asha, 'next24h.0').expect(200);
    expect(res.body.data).toMatchObject({
      id: 'next24h.0',
      done: true,
      dimensionKey: 'api-design',
    });
    await tick(ravi, 'next24h.0').expect(404);
    await tick(asha, 'next24h.5').expect(404);
    await tick(asha, 'bogus').expect(400);
    await tick(asha, 'next3Days.0').expect(200);
    await tick(asha, 'next7Days.0').expect(200);

    let hub = await overview(asha);
    expect(hub.plan?.doneCount).toBe(3);
    expect(hub.badges.find((b) => b.key === 'PLAN_COMPLETE')?.earned).toBe(true);

    await tick(asha, 'next7Days.0', false).expect(200);
    hub = await overview(asha);
    expect(hub.plan?.doneCount).toBe(2);
    // A badge, once earned, stays.
    expect(hub.badges.find((b) => b.key === 'PLAN_COMPLETE')?.earned).toBe(true);
  });

  it('saves goals and suggests a schedule up to the target date', async () => {
    const asha = await candidate();
    const inTenDays = new Date(Date.now() + 10 * 24 * 3600 * 1000).toISOString().slice(0, 10);
    const res = await asha
      .call('put', '/users/me/progress/goals')
      .send({ weeklyTarget: 4, targetDate: inTenDays })
      .expect(200);
    const hub = ProgressOverview.parse(res.body.data);
    expect(hub.goals.weeklyTarget).toBe(4);
    expect(hub.goals.targetDate).toBe(inTenDays);
    expect(hub.goals.schedule.at(-1)?.kind).toBe('INTERVIEW');
    await asha
      .call('put', '/users/me/progress/goals')
      .send({ weeklyTarget: 3, targetDate: '2020-01-01' })
      .expect(400);
    await asha
      .call('put', '/users/me/progress/goals')
      .send({ weeklyTarget: 0, targetDate: null })
      .expect(400);
  });
});

describe('drills', () => {
  it('needs a finished interview and a skill from its blueprint', async () => {
    const asha = await candidate();
    await asha.call('post', '/drills').send({ dimensionKey: 'api-design' }).expect(409);
    await finished(asha.userId);
    await asha.call('post', '/drills').send({ dimensionKey: 'not-a-skill' }).expect(400);
  });

  it('creates a free drill, reuses it, starts it without touching credits and enforces the daily quota', async () => {
    const asha = await candidate();
    const { id: sourceId, keys } = await finished(asha.userId);
    await InterviewSessionModel.updateOne(
      { _id: sourceId },
      {
        $set: {
          analysis: {
            detectedRole: {
              title: 'Backend Engineer',
              family: 'ENGINEERING',
              seniority: 'JUNIOR',
              confidence: 0.9,
            },
            matchedRole: null,
            blueprint: { id: 'bp', origin: 'CANONICAL', version: 1 },
            skills: [{ name: 'Node.js', weight: 40, sources: ['ROLE'], inResume: true }],
            resumeHighlights: [],
            gaps: [],
            inputs: { resume: false, jd: false, companyPatterns: false },
            plannedRounds: [{ type: 'INTRO', durationSec: 180, focus: [] }],
            totalDurationSec: 1920,
            analyzedAt: '2026-09-20T10:00:00.000Z',
          },
        },
      },
    );
    await setPractice({ drillsPerDay: 1 });

    const created = await asha
      .call('post', '/drills')
      .send({ dimensionKey: keys[0], mode: 'TEXT' })
      .expect(201);
    const drill = InterviewSummary.parse(created.body.data);
    expect(drill).toMatchObject({ kind: 'DRILL', state: 'READY', credit: 'NONE' });
    expect(drill.drill?.competencyKey).toBe(keys[0]);
    expect(drill.analysis?.plannedRounds).toEqual([
      { type: 'TECHNICAL', durationSec: 420, focus: [drill.drill!.competencyName] },
    ]);
    expect(drill.analysis?.totalDurationSec).toBe(420);
    const again = await asha
      .call('post', '/drills')
      .send({ dimensionKey: keys[0], mode: 'TEXT' })
      .expect(201);
    expect(again.body.data.id).toBe(drill.id);
    // Drills are not listed with interviews.
    const list = (await asha.call('get', '/interviews').expect(200)).body.data as {
      kind: string;
    }[];
    expect(list.every((i) => i.kind === 'INTERVIEW')).toBe(true);

    const ledgerBefore = await CreditLedgerModel.countDocuments({ userId: asha.userId });
    const started = await asha.call('post', `/interviews/${drill.id}/start`).send({}).expect(200);
    expect(started.body.data).toMatchObject({ kind: 'DRILL', state: 'ACTIVE', credit: 'FREE' });
    const session = await InterviewSessionModel.findById(drill.id).lean();
    expect(session?.planner?.rounds).toHaveLength(1);
    expect(session?.planner?.rounds[0]?.questionCount).toBe(3);
    // Only the welcome credit may have been granted; nothing was reserved.
    const entries = await CreditLedgerModel.find({ userId: asha.userId }).lean();
    expect(entries.filter((e) => e.type === 'INTERVIEW_RESERVE')).toHaveLength(0);
    expect(entries.length - ledgerBefore).toBeLessThanOrEqual(1);
    await asha.call('post', `/interviews/${drill.id}/end`).send({}).expect(200);

    const refused = await asha.call('post', '/drills').send({ dimensionKey: keys[1] }).expect(402);
    expect(refused.body.error.code).toBe('DRILL_LIMIT_REACHED');
  });

  it('shows a drill result to its owner only', async () => {
    const asha = await candidate();
    const ravi = await candidate('ravi@example.com');
    const { keys } = await finished(asha.userId, { endedAt: '2026-09-01T10:00:00.000Z' });
    const drill = await finished(asha.userId, { kind: 'DRILL', scores: { [keys[0]!]: 77 } });
    await InterviewSessionModel.updateOne(
      { _id: drill.id },
      { $set: { 'drill.competencyKey': keys[0] } },
    );
    const res = await asha.call('get', `/drills/${drill.id}`).expect(200);
    const result = DrillResult.parse(res.body.data);
    expect(result).toMatchObject({ score: 77, previousScore: 72, state: 'REPORT_READY' });
    await ravi.call('get', `/drills/${drill.id}`).expect(404);
  });
});

describe('certificates', () => {
  it('stays hidden while the proof flag is off', async () => {
    const asha = await candidate();
    const { id } = await finished(asha.userId);
    await asha.call('get', `/reports/${id}/certificate`).expect(404);
    await asha.call('post', `/reports/${id}/certificate`).expect(404);
  });

  it('issues once for a qualifying report and verifies publicly', async () => {
    await switchProofFlag(true);
    const asha = await candidate();
    await UserProfileModel.updateOne(
      { userId: asha.userId },
      { $set: { displayName: 'Asha' } },
      { upsert: true },
    );
    const low = await finished(asha.userId, { overall: 52 });
    const high = await finished(asha.userId, { overall: 70 });

    const lowStatus = CertificateStatus.parse(
      (await asha.call('get', `/reports/${low.id}/certificate`).expect(200)).body.data,
    );
    expect(lowStatus).toMatchObject({ eligible: false, certificate: null });
    await asha.call('post', `/reports/${low.id}/certificate`).expect(409);

    const issued = CertificateStatus.parse(
      (await asha.call('post', `/reports/${high.id}/certificate`).expect(200)).body.data,
    );
    expect(issued.certificate?.code).toMatch(/^CPI-/);
    expect(t.jobs.jobs.filter((j) => j.kind === 'certificatePdf')).toHaveLength(1);
    const again = CertificateStatus.parse(
      (await asha.call('post', `/reports/${high.id}/certificate`).expect(200)).body.data,
    );
    expect(again.certificate?.code).toBe(issued.certificate?.code);
    expect(await CertificateModel.countDocuments({ userId: asha.userId })).toBe(1);
    await asha.call('get', `/reports/${high.id}/certificate/pdf`).expect(409);

    const verified = CertificateVerification.parse(
      (await publicCall('get', `/certificates/${issued.certificate!.code}`).expect(200)).body.data,
    );
    expect(verified).toMatchObject({ candidateName: 'Asha', overall: 70, superseded: false });
    await publicCall('get', '/certificates/CPI-2222-2222-2222').expect(404);
    await publicCall('get', '/certificates/nonsense').expect(404);
    await switchProofFlag(false);
    await publicCall('get', `/certificates/${issued.certificate!.code}`).expect(404);
  });
});

describe('email unsubscribe', () => {
  it('turns product updates off with a signed link, without signing in', async () => {
    const asha = await candidate();
    await UserProfileModel.updateOne(
      { userId: asha.userId },
      { $set: { productUpdatesOptIn: true, displayName: 'Asha' } },
      { upsert: true },
    );
    const key = emailLinkKey(Buffer.from(t.env.AI_SECRETS_MASTER_KEY, 'base64'));
    const token = signEmailLink(key, { userId: asha.userId, purpose: 'unsubscribe' });
    await publicCall('post', '/email/unsubscribe').send({ token }).expect(200);
    const profile = await UserProfileModel.findOne({ userId: asha.userId }).lean();
    expect(profile?.productUpdatesOptIn).toBe(false);
    expect(
      await AuditLogModel.countDocuments({ action: 'profile.product_updates_unsubscribed' }),
    ).toBe(1);
    // A second click still confirms.
    await publicCall('post', '/email/unsubscribe').send({ token }).expect(200);
    await publicCall('post', '/email/unsubscribe')
      .send({ token: `${token}x`.padEnd(30, 'x') })
      .expect(400);
  });
});

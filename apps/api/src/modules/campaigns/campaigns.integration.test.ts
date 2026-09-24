import {
  AuditLogModel,
  CampaignApplicationModel,
  CampaignModel,
  ensureLibraryCatalog,
  getCreditBalance,
  InterviewReportModel,
  InterviewScoreModel,
  InterviewSessionModel,
  ReviewRevisionModel,
  RoleBlueprintModel,
  RoleModel,
  UserModel,
  UserProfileModel,
} from '@cbi/db';
import {
  AdminInterviewDetail,
  CampaignResults,
  CampaignSummary,
  CampaignWithInvite,
  InterviewSummary,
  JoinCampaignResult,
  PublicCampaign,
  ReportSummary,
  ScoreRevisionSummary,
  SessionConsents,
  type AdminRole,
  type CreateCampaignBody,
  type ReportContent,
} from '@cbi/shared-types';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { buildTestApp, TEST_ORIGIN } from '../../test-support/harness.js';
import { signInWithEmail, useIntegrationServices } from '../../test-support/integration.js';
import { bootstrapAi } from '../ai/ai-bootstrap.js';
import { readZip } from '../../lib/zip.js';

const { redis } = useIntegrationServices();

let t: Awaited<ReturnType<typeof buildTestApp>>;

beforeEach(async () => {
  t = await buildTestApp({ redis });
  await bootstrapAi({
    env: t.env,
    ai: t.container.ai,
    audit: t.container.audit,
    logger: t.container.logger,
  });
  await ensureLibraryCatalog();
});

type Method = 'get' | 'post' | 'put' | 'patch';

async function candidate(email = 'asha@example.com') {
  const { accessToken, user } = await signInWithEmail(t.app, t.email.sent, email);
  const call = (method: Method, path: string) =>
    request(t.app)
      [method](`/api/v1${path}`)
      .set('Origin', TEST_ORIGIN)
      .set('Authorization', `Bearer ${accessToken}`);
  return { accessToken, userId: String(user.id), call };
}
type Candidate = Awaited<ReturnType<typeof candidate>>;

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
type Admin = Awaited<ReturnType<typeof adminAs>>;

const publicCall = (method: Method, path: string) =>
  request(t.app)[method](`/api/v1${path}`).set('Origin', TEST_ORIGIN);

const HOUR = 3600_000;

async function body(overrides: Partial<CreateCampaignBody> = {}): Promise<CreateCampaignBody> {
  const role = await RoleModel.findOne({ slug: 'backend-engineer' }).lean();
  return {
    name: 'Backend hiring — September',
    companyId: null,
    companyName: 'Acme Labs',
    roleId: String(role!._id),
    templateKey: 'standard-practice',
    jobDescription: 'We build payment APIs in Node.js and MongoDB.',
    modes: ['TEXT'],
    languages: ['en', 'hi'],
    window: { startAt: new Date(Date.now() - HOUR).toISOString(), endAt: null },
    maxCandidates: null,
    proctoring: { recording: 'OFF', tabSwitchTracking: false },
    candidateSeesReport: true,
    sponsoredCredits: null,
    ...overrides,
  };
}

/** Creates and (by default) activates a campaign; returns its id and invite token. */
async function campaign(
  admin: Admin,
  overrides: Partial<CreateCampaignBody> = {},
  activate = true,
) {
  const res = await admin('post', '/campaigns')
    .send(await body(overrides))
    .expect(201);
  const created = CampaignWithInvite.parse(res.body.data);
  if (activate) {
    await admin('post', `/campaigns/${created.campaign.id}/status`)
      .send({ status: 'ACTIVE', reason: 'launch' })
      .expect(200);
  }
  return {
    id: created.campaign.id,
    token: created.invitePath.split('/').pop()!,
    summary: created.campaign,
  };
}

const join = (c: Candidate, token: string) => c.call('post', `/campaigns/${token}/join`).send({});

/** Stands in for the worker's analysis: READY with the campaign's pinned blueprint. */
async function analysed(interviewId: string) {
  const s = await InterviewSessionModel.findById(interviewId).lean();
  const camp = await CampaignModel.findById(s!.campaignId).lean();
  await InterviewSessionModel.updateOne(
    { _id: s!._id },
    { $set: { state: 'READY', blueprintId: camp!.blueprintId } },
  );
}

async function acceptConsents(c: Candidate, id: string) {
  const current = SessionConsents.parse(
    (await c.call('get', `/interviews/${id}/consents`).expect(200)).body.data,
  );
  await c
    .call('post', `/interviews/${id}/consents`)
    .send({ decisions: current.items.map((i) => ({ consentTextId: i.text.id, accepted: true })) })
    .expect(200);
  return current;
}

async function joinedAndReady(c: Candidate, token: string) {
  const { interviewId } = JoinCampaignResult.parse((await join(c, token).expect(201)).body.data);
  await analysed(interviewId);
  return interviewId;
}

function reportContent(overall: number, scores: Record<string, number | null>): ReportContent {
  return {
    schemaVersion: 1,
    header: {
      title: 'Backend Engineer',
      companyName: 'Acme Labs',
      mode: 'TEXT',
      language: 'en',
      startedAt: '2026-09-24T10:00:00.000Z',
      endedAt: '2026-09-24T10:25:00.000Z',
      durationSec: 1500,
      endReason: 'ROUND_ENDED',
    },
    overall: {
      score: overall,
      band: 'READY_WITH_GAPS',
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
      assessedWeight: 1,
    },
    summary: 'Solid API design.',
    dimensions: Object.entries(scores).map(([key, score]) => ({
      key,
      name: key,
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
      next24h: [{ action: 'Write two examples.', why: 'Examples help.', dimensionKey: null }],
      next3Days: [{ action: 'Practise aloud.', why: 'Fluency helps.', dimensionKey: null }],
      next7Days: [{ action: 'Retake the interview.', why: 'See progress.', dimensionKey: null }],
    },
    previous: null,
    transcript: null,
    disclaimer: 'AI-generated estimate.',
  };
}

/** Stands in for the evaluation pipeline: score and report revision 0. */
async function evaluated(
  interviewId: string,
  scores: Record<string, number | null>,
  visible = true,
) {
  const s = await InterviewSessionModel.findById(interviewId).lean();
  const values = Object.values(scores).filter((v): v is number => v !== null);
  const overall = Math.round(values.reduce((a, b) => a + b, 0) / values.length);
  await InterviewSessionModel.updateOne(
    { _id: s!._id },
    { $set: { state: 'REPORT_READY', endedAt: new Date() } },
  );
  await InterviewScoreModel.create({
    sessionId: s!._id,
    userId: s!.userId,
    revision: 0,
    dimensions: Object.entries(scores).map(([key, score]) => ({
      key,
      name: key,
      category: 'TECHNICAL',
      weight: 100 / Object.keys(scores).length,
      score,
      aiScore: score,
      adjusted: false,
      fallback: false,
      rationale: null,
      evidenceIds: [],
    })),
    overall,
    band: 'READY_WITH_GAPS',
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
    assessedWeight: 1,
    templateId: s!.templateId,
    promptVersions: {},
    createdBy: 'AI',
    reason: null,
  });
  await InterviewReportModel.create({
    sessionId: s!._id,
    userId: s!.userId,
    revision: 0,
    scoreRevision: 0,
    content: reportContent(overall, scores),
    visibility: { candidate: visible },
    roleKey: 'role:backend',
    overall,
    generatedAt: new Date(),
  });
  return overall;
}

async function dimensionKeys(campaignId: string) {
  const camp = await CampaignModel.findById(campaignId).lean();
  const blueprint = await RoleBlueprintModel.findById(camp!.blueprintId).lean();
  return blueprint!.content.competencies.map((c) => c.key) as [string, string, ...string[]];
}

describe('campaign administration', () => {
  it('limits campaigns to roles with the campaign permissions', async () => {
    const ops = await adminAs(['OPERATIONS_ADMIN']);
    const support = await adminAs(['SUPPORT_ADMIN']);
    const content = await adminAs(['CONTENT_ADMIN']);
    const finance = await adminAs(['FINANCE_ADMIN']);
    const { id } = await campaign(ops);

    for (const denied of [content, finance]) {
      await denied('get', '/campaigns').expect(403);
      await denied('get', `/campaigns/${id}/results`).expect(403);
      await denied('get', '/interviews').expect(403);
    }
    // Support can look, not change or export.
    await support('get', '/campaigns').expect(200);
    await support('get', `/campaigns/${id}/results`).expect(200);
    await support('get', '/interviews').expect(200);
    await support('post', '/campaigns')
      .send(await body())
      .expect(403);
    await support('post', `/campaigns/${id}/status`)
      .send({ status: 'PAUSED', reason: 'try' })
      .expect(403);
    await support('post', `/campaigns/${id}/rotate-invite`).send({ reason: 'try' }).expect(403);
    await support('get', `/campaigns/${id}/results.csv`).expect(403);
    await support('get', `/campaigns/${id}/package.zip`).expect(403);

    // Candidates' tokens do not open admin routes.
    const asha = await candidate();
    await request(t.app)
      .get('/api/v1/admin/campaigns')
      .set('Origin', TEST_ORIGIN)
      .set('Authorization', `Bearer ${asha.accessToken}`)
      .expect(401);
  });

  it('pins the role blueprint and template, shows the invite once and audits changes', async () => {
    const ops = await adminAs(['OPERATIONS_ADMIN']);
    const created = await campaign(ops, {}, false);
    const role = await RoleModel.findOne({ slug: 'backend-engineer' }).lean();
    expect(created.summary).toMatchObject({
      status: 'DRAFT',
      role: { id: String(role!._id) },
      blueprint: { id: String(role!.activeBlueprintId) },
      template: { key: 'standard-practice' },
      joined: 0,
      tokenHint: created.token.slice(0, 4),
    });
    const stored = await CampaignModel.findById(created.id).lean();
    expect(JSON.stringify(stored)).not.toContain(created.token);

    const got = await ops('get', `/campaigns/${created.id}`).expect(200);
    expect(JSON.stringify(got.body)).not.toContain(created.token);
    CampaignSummary.parse(got.body.data);

    // Draft campaigns are invisible to candidates.
    await publicCall('get', `/campaigns/${created.token}`).expect(404);
    await ops('post', `/campaigns/${created.id}/status`)
      .send({ status: 'ACTIVE', reason: 'launch' })
      .expect(200);
    await publicCall('get', `/campaigns/${created.token}`).expect(200);

    // Modes the template does not offer are refused.
    await ops('post', '/campaigns')
      .send(await body({ templateKey: 'nope' }))
      .expect(404);

    const actions = (await AuditLogModel.find({ resourceId: created.id }).lean()).map(
      (a) => a.action,
    );
    expect(actions).toEqual(['campaign.created', 'campaign.status_changed']);
  });

  it('allows only forward status changes; closed is final', async () => {
    const ops = await adminAs(['OPERATIONS_ADMIN']);
    const { id } = await campaign(ops);
    const status = (s: string) =>
      ops('post', `/campaigns/${id}/status`).send({ status: s, reason: 'ops' });
    await status('PAUSED').expect(200);
    await status('ACTIVE').expect(200);
    await status('CLOSED').expect(200);
    const res = await status('ACTIVE').expect(409);
    expect(res.body.error.code).toBe('INVALID_STATE');
    await ops('post', `/campaigns/${id}/rotate-invite`).send({ reason: 'leak' }).expect(409);
  });
});

describe('invite links', () => {
  it('rejects unknown and malformed tokens alike', async () => {
    const asha = await candidate();
    await publicCall('get', '/campaigns/not-a-real-token-at-all').expect(404);
    await publicCall('get', '/campaigns/x').expect(404);
    await join(asha, 'AAAAAAAAAAAAAAAAAAAAAAAA').expect(404);
    await publicCall('post', '/campaigns/AAAAAAAAAAAAAAAAAAAAAAAA/join').send({}).expect(401);
  });

  it('describes the campaign publicly and explains why it is closed', async () => {
    const ops = await adminAs(['OPERATIONS_ADMIN']);
    const { id, token } = await campaign(ops, { sponsoredCredits: 5 });
    const view = PublicCampaign.parse(
      (await publicCall('get', `/campaigns/${token}`).expect(200)).body.data,
    );
    expect(view).toMatchObject({
      companyName: 'Acme Labs',
      roleTitle: 'Backend Engineer',
      modes: ['TEXT'],
      sponsored: true,
      closedReason: null,
      joinedInterviewId: null,
    });
    expect(view.assesses.length).toBeGreaterThan(2);

    const asha = await candidate();
    const reason = async () =>
      PublicCampaign.parse((await publicCall('get', `/campaigns/${token}`).expect(200)).body.data)
        .closedReason;
    const status = (s: string) =>
      ops('post', `/campaigns/${id}/status`).send({ status: s, reason: 'ops' }).expect(200);

    await status('PAUSED');
    expect(await reason()).toBe('PAUSED');
    expect((await join(asha, token).expect(409)).body.error.code).toBe('CAMPAIGN_CLOSED');
    await status('ACTIVE');

    const update = (window: { startAt: string; endAt: string | null }) =>
      ops('put', `/campaigns/${id}`)
        .send({
          name: 'Backend hiring',
          companyName: 'Acme Labs',
          jobDescription: null,
          window,
          maxCandidates: null,
          candidateSeesReport: true,
          sponsoredCredits: 5,
          reason: 'dates',
        })
        .expect(200);
    await update({ startAt: new Date(Date.now() + HOUR).toISOString(), endAt: null });
    expect(await reason()).toBe('NOT_STARTED');
    await join(asha, token).expect(409);
    await update({
      startAt: new Date(Date.now() - 2 * HOUR).toISOString(),
      endAt: new Date(Date.now() - HOUR).toISOString(),
    });
    expect(await reason()).toBe('ENDED');
    await join(asha, token).expect(409);

    await status('CLOSED');
    expect(await reason()).toBe('CLOSED');
    await join(asha, token).expect(409);
    expect(await CampaignApplicationModel.countDocuments()).toBe(0);
  });

  it('a rotated link replaces the old one; joined candidates keep their interview', async () => {
    const ops = await adminAs(['OPERATIONS_ADMIN']);
    const { id, token } = await campaign(ops);
    const asha = await candidate();
    const first = JoinCampaignResult.parse((await join(asha, token).expect(201)).body.data);
    const rotated = CampaignWithInvite.parse(
      (await ops('post', `/campaigns/${id}/rotate-invite`).send({ reason: 'leaked' }).expect(200))
        .body.data,
    );
    const fresh = rotated.invitePath.split('/').pop()!;
    expect(fresh).not.toBe(token);
    await publicCall('get', `/campaigns/${token}`).expect(404);
    await join(await candidate('ravi@example.com'), token).expect(404);
    await asha.call('get', `/interviews/${first.interviewId}`).expect(200);
    const again = JoinCampaignResult.parse((await join(asha, fresh).expect(200)).body.data);
    expect(again).toEqual({ interviewId: first.interviewId, created: false });
  });
});

describe('joining', () => {
  it('creates one pinned interview per candidate, idempotently', async () => {
    const ops = await adminAs(['OPERATIONS_ADMIN']);
    const { id, token } = await campaign(ops);
    const asha = await candidate();
    const [a, b] = await Promise.all([join(asha, token), join(asha, token)]);
    const ids = [a, b].map((r) => JoinCampaignResult.parse(r.body.data).interviewId);
    expect(ids[0]).toBe(ids[1]);
    expect([a.status, b.status].sort()).toEqual([200, 201]);
    expect(await CampaignApplicationModel.countDocuments({ campaignId: id })).toBe(1);
    expect((await CampaignModel.findById(id).lean())!.joinedCount).toBe(1);

    const s = await InterviewSessionModel.findById(ids[0]).lean();
    const camp = await CampaignModel.findById(id).lean();
    expect(String(s!.campaignId)).toBe(id);
    expect(String(s!.templateId)).toBe(String(camp!.templateId));
    expect(s!.mode).toBe('TEXT');
    // Analysis starts straight away.
    expect(t.jobs.jobs).toContainEqual(expect.objectContaining({ kind: 'analyze', id: ids[0] }));

    const summary = InterviewSummary.parse(
      (await asha.call('get', `/interviews/${ids[0]}`).expect(200)).body.data,
    );
    expect(summary.campaign).toMatchObject({
      id,
      companyName: 'Acme Labs',
      sponsored: false,
      reportVisible: true,
      modes: ['TEXT'],
    });
    const view = PublicCampaign.parse(
      (await asha.call('get', `/campaigns/${token}`).expect(200)).body.data,
    );
    expect(view.joinedInterviewId).toBe(ids[0]);
  });

  it('never admits more candidates than the limit, even in parallel', async () => {
    const ops = await adminAs(['OPERATIONS_ADMIN']);
    const { id, token } = await campaign(ops, { maxCandidates: 2 });
    const people = await Promise.all(
      ['a', 'b', 'c', 'd', 'e'].map((n) => candidate(`${n}@example.com`)),
    );
    const results = await Promise.all(people.map((p) => join(p, token)));
    expect(results.filter((r) => r.status === 201)).toHaveLength(2);
    const refused = results.filter((r) => r.status === 409);
    expect(refused).toHaveLength(3);
    for (const r of refused) expect(r.body.error.code).toBe('CAMPAIGN_CLOSED');
    expect((await CampaignModel.findById(id).lean())!.joinedCount).toBe(2);
    expect(await InterviewSessionModel.countDocuments({ campaignId: id })).toBe(2);
    const view = PublicCampaign.parse(
      (await publicCall('get', `/campaigns/${token}`).expect(200)).body.data,
    );
    expect(view.closedReason).toBe('FULL');
  });

  it("keeps each candidate's campaign interview private", async () => {
    const ops = await adminAs(['OPERATIONS_ADMIN']);
    const { token } = await campaign(ops);
    const asha = await candidate();
    const ravi = await candidate('ravi@example.com');
    const id = await joinedAndReady(asha, token);
    await ravi.call('get', `/interviews/${id}`).expect(404);
    await ravi.call('get', `/interviews/${id}/consents`).expect(404);
    await ravi.call('post', `/interviews/${id}/start`).expect(404);
    await ravi.call('get', `/reports/${id}`).expect(404);
  });

  it('limits setup to the campaign modes and languages', async () => {
    const ops = await adminAs(['OPERATIONS_ADMIN']);
    const { token } = await campaign(ops, { languages: ['en'] });
    const asha = await candidate();
    const id = await joinedAndReady(asha, token);
    await asha
      .call('patch', `/interviews/${id}/setup`)
      .send({ mode: 'TEXT', language: 'en' })
      .expect(200);
    await asha
      .call('patch', `/interviews/${id}/setup`)
      .send({ mode: 'TEXT', language: 'hi' })
      .expect(400);
    await asha
      .call('patch', `/interviews/${id}/setup`)
      .send({ mode: 'VOICE', language: 'en' })
      .expect(400);
  });
});

describe('starting a campaign interview', () => {
  it('asks for consent to share results with the company', async () => {
    const ops = await adminAs(['OPERATIONS_ADMIN']);
    const { token } = await campaign(ops, {
      proctoring: { recording: 'OFF', tabSwitchTracking: true },
    });
    const asha = await candidate();
    const id = await joinedAndReady(asha, token);
    await asha.call('post', `/interviews/${id}/start`).expect(409);
    const consents = await acceptConsents(asha, id);
    // The campaign's proctoring replaces the template's (observations on, recording off).
    expect(consents.items.map((i) => [i.type, i.required])).toEqual([
      ['CAMPAIGN_SHARING', true],
      ['INTEGRITY', true],
    ]);
    await asha.call('post', `/interviews/${id}/start`).expect(200);
  });

  it("spends the campaign's sponsored budget before the candidate's credits", async () => {
    const ops = await adminAs(['OPERATIONS_ADMIN']);
    const { id: campaignId, token } = await campaign(ops, { sponsoredCredits: 1 });
    const asha = await candidate();
    const ravi = await candidate('ravi@example.com');

    const first = await joinedAndReady(asha, token);
    await acceptConsents(asha, first);
    const started = InterviewSummary.parse(
      (await asha.call('post', `/interviews/${first}/start`).expect(200)).body.data,
    );
    expect(started.credit).toBe('SPONSORED');
    expect(started.campaign?.sponsored).toBe(true);
    expect((await getCreditBalance(asha.userId)).available).toBe(1);

    const second = await joinedAndReady(ravi, token);
    await acceptConsents(ravi, second);
    const own = InterviewSummary.parse(
      (await ravi.call('post', `/interviews/${second}/start`).expect(200)).body.data,
    );
    expect(own.credit).toBe('RESERVED');
    expect((await getCreditBalance(ravi.userId)).available).toBe(0);
    expect((await CampaignModel.findById(campaignId).lean())!.sponsoredCredits).toEqual({
      total: 1,
      used: 1,
    });

    // The budget cannot drop below what was used.
    const res = await ops('put', `/campaigns/${campaignId}`)
      .send({
        name: 'Backend hiring',
        companyName: 'Acme Labs',
        jobDescription: null,
        window: { startAt: new Date(Date.now() - HOUR).toISOString(), endAt: null },
        maxCandidates: null,
        candidateSeesReport: true,
        sponsoredCredits: null,
        reason: 'budget cut',
      })
      .expect(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
  });

  it('cannot start while the campaign is paused', async () => {
    const ops = await adminAs(['OPERATIONS_ADMIN']);
    const { id: campaignId, token } = await campaign(ops);
    const asha = await candidate();
    const id = await joinedAndReady(asha, token);
    await acceptConsents(asha, id);
    await ops('post', `/campaigns/${campaignId}/status`)
      .send({ status: 'PAUSED', reason: 'hold' })
      .expect(200);
    const res = await asha.call('post', `/interviews/${id}/start`).expect(409);
    expect(res.body.error.code).toBe('CAMPAIGN_CLOSED');
  });
});

describe('results and exports', () => {
  async function scored() {
    const ops = await adminAs(['OPERATIONS_ADMIN']);
    const { id, token } = await campaign(ops, { candidateSeesReport: false });
    const asha = await candidate();
    const ravi = await candidate('ravi@example.com');
    const meera = await candidate('meera@example.com');
    await UserProfileModel.updateOne(
      { userId: asha.userId },
      { $set: { displayName: '=HYPERLINK("x")' } },
    );
    const a = await joinedAndReady(asha, token);
    const r = await joinedAndReady(ravi, token);
    await joinedAndReady(meera, token);
    // Two of the pinned blueprint's dimensions.
    const [k1, k2] = await dimensionKeys(id);
    await evaluated(a, { [k1]: 80, [k2]: 60 }, false);
    await evaluated(r, { [k1]: 50, [k2]: 90 }, false);
    return { ops, id, asha, a, r, k2 };
  }

  it('ranks candidates and filters by status, overall and dimension', async () => {
    const { ops, id, a, r, k2 } = await scored();
    const all = CampaignResults.parse(
      (await ops('get', `/campaigns/${id}/results`).expect(200)).body.data,
    );
    expect(all.rows.map((x) => [x.interviewId, x.overall, x.status])).toEqual([
      [a, 70, 'COMPLETED'],
      [r, 70, 'COMPLETED'],
      [expect.any(String), null, 'JOINED'],
    ]);
    const byDim = CampaignResults.parse(
      (await ops('get', `/campaigns/${id}/results?dimension=${k2}:80`).expect(200)).body.data,
    );
    expect(byDim.rows.map((x) => x.interviewId)).toEqual([r]);
    const joined = CampaignResults.parse(
      (await ops('get', `/campaigns/${id}/results?status=JOINED`).expect(200)).body.data,
    );
    expect(joined.rows).toHaveLength(1);
    await ops('get', `/campaigns/${id}/results?minOverall=200`).expect(400);
  });

  it('hides the report from candidates when the company keeps it', async () => {
    const { asha, a } = await scored();
    await asha.call('get', `/reports/${a}`).expect(404);
    const summary = InterviewSummary.parse(
      (await asha.call('get', `/interviews/${a}`).expect(200)).body.data,
    );
    expect(summary.campaign?.reportVisible).toBe(false);
  });

  it('exports CSV and a package, neutralising formulas and auditing both', async () => {
    const { ops, id, a } = await scored();
    const csv = await ops('get', `/campaigns/${id}/results.csv`).expect(200);
    expect(csv.headers['content-type']).toContain('text/csv');
    // Starts with a BOM so spreadsheets read UTF-8.
    expect(csv.text.charCodeAt(0)).toBe(0xfeff);
    const text = csv.text.slice(1);
    const [header, first] = text.split('\r\n');
    expect(header).toContain('Overall');
    expect(first).toMatch(/^"'=HYPERLINK\(""x""\)",asha@example.com,COMPLETED/);

    const zip = await ops('get', `/campaigns/${id}/package.zip`)
      .buffer(true)
      .parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => cb(null, Buffer.concat(chunks)));
      })
      .expect(200);
    const files = readZip(zip.body as Buffer);
    expect([...files.keys()]).toEqual(
      expect.arrayContaining(['results.csv', 'campaign.json', expect.stringContaining(a)]),
    );
    const exports = await AuditLogModel.find({ action: 'campaign.results_exported' }).lean();
    expect(exports.map((e) => (e.details as { format: string }).format).sort()).toEqual([
      'csv',
      'package',
    ]);
  });
});

describe('manual review', () => {
  it('flags, and revises scores as new revisions that the candidate then sees', async () => {
    const ops = await adminAs(['OPERATIONS_ADMIN']);
    const support = await adminAs(['SUPPORT_ADMIN']);
    const { token } = await campaign(ops);
    const asha = await candidate();
    const id = await joinedAndReady(asha, token);
    await evaluated(id, { 'api-design': 80, databases: 60 });

    await support('post', `/interviews/${id}/flag`)
      .send({ flagged: true, reason: 'x' })
      .expect(403);
    await support('post', `/interviews/${id}/revise-score`)
      .send({ dimensions: [{ key: 'databases', score: 90, note: 'strong' }], reason: 'review' })
      .expect(403);

    await ops('post', `/interviews/${id}/flag`)
      .send({ flagged: true, reason: 'Check the database answer' })
      .expect(200);
    const flagged = await ops('get', '/interviews?flagged=true').expect(200);
    expect(flagged.body.data.map((r: { id: string }) => r.id)).toEqual([id]);

    await ops('post', `/interviews/${id}/revise-score`)
      .send({ dimensions: [{ key: 'unknown', score: 90, note: 'strong' }], reason: 'review' })
      .expect(400);
    const revised = ScoreRevisionSummary.parse(
      (
        await ops('post', `/interviews/${id}/revise-score`)
          .send({
            dimensions: [{ key: 'databases', score: 90, note: 'Indexing answer was correct' }],
            reason: 'Reviewed the transcript',
          })
          .expect(201)
      ).body.data,
    );
    expect(revised).toMatchObject({ revision: 1, overall: 85, reason: 'Reviewed the transcript' });
    expect(revised.dimensions.find((d) => d.key === 'databases')).toMatchObject({
      score: 90,
      note: 'Indexing answer was correct',
    });

    // The AI original is untouched.
    const original = await InterviewScoreModel.findOne({ sessionId: id, revision: 0 }).lean();
    expect(original!.overall).toBe(70);
    expect(await ReviewRevisionModel.countDocuments({ sessionId: id })).toBe(1);
    expect(t.jobs.jobs).toContainEqual({ kind: 'reportPdf', id, revision: 1 });

    const report = ReportSummary.parse(
      (await asha.call('get', `/reports/${id}`).expect(200)).body.data,
    );
    expect(report.revision).toBe(1);
    expect(report.content.overall.score).toBe(85);
    expect(report.content.review?.note).toBe('Reviewed the transcript');

    const detail = AdminInterviewDetail.parse(
      (await ops('get', `/interviews/${id}`).expect(200)).body.data,
    );
    expect(detail.scoreRevisions.map((r) => r.revision)).toEqual([0, 1]);
    expect(detail.reportRevisions.map((r) => r.revision)).toEqual([0, 1]);
    expect(detail.flag.flagged).toBe(true);
    expect(await AuditLogModel.countDocuments({ action: 'interview.review_viewed' })).toBe(1);
    expect(await AuditLogModel.countDocuments({ action: 'interview.score_revised' })).toBe(1);
  });

  it('only reviews interviews that have a report', async () => {
    const ops = await adminAs(['OPERATIONS_ADMIN']);
    const { token } = await campaign(ops);
    const id = await joinedAndReady(await candidate(), token);
    await ops('post', `/interviews/${id}/revise-score`)
      .send({ dimensions: [{ key: 'databases', score: 90, note: 'strong' }], reason: 'review' })
      .expect(409);
    await ops('get', '/interviews/000000000000000000000000').expect(404);
  });
});

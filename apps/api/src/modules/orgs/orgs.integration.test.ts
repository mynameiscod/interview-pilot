import {
  AuditLogModel,
  CampaignApplicationModel,
  CampaignInviteModel,
  CampaignModel,
  campaignDimensions,
  campaignInterviewCompleted,
  ensureLibraryCatalog,
  IdentityCaptureModel,
  InterviewScoreModel,
  inviteTokenContext,
  InterviewSessionModel,
  OrgApiKeyModel,
  OrgMemberModel,
  OrgModel,
  OrgWebhookModel,
  RoleModel,
  UserModel,
  UserProfileModel,
  verifyWebhookSignature,
  WebhookDeliveryModel,
  webhookSecretContext,
  webhookSignatureHeader,
  type CampaignRecord,
} from '@cbi/db';
import { totpCode } from '@cbi/auth-core';
import {
  CampaignWithInvite,
  InviteListPage,
  JoinCampaignResult,
  OrgMeResponse,
  OrgResults,
  SessionConsents,
  type AdminRole,
  type CreateCampaignInput,
  type CreateOrgBody,
  type MfaChallenge,
} from '@cbi/shared-types';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { buildTestApp, TEST_ORIGIN } from '../../test-support/harness.js';
import {
  completeMfa,
  signInWithEmail,
  useIntegrationServices,
} from '../../test-support/integration.js';
import { bootstrapAi } from '../ai/ai-bootstrap.js';

const { redis } = useIntegrationServices();

let t: Awaited<ReturnType<typeof buildTestApp>>;

beforeEach(async () => {
  // Bulk invite uploads are larger than the 4 kB test default.
  t = await buildTestApp({ redis, env: { REQUEST_BODY_LIMIT: '512kb' } });
  await bootstrapAi({
    env: t.env,
    ai: t.container.ai,
    audit: t.container.audit,
    logger: t.container.logger,
  });
  await ensureLibraryCatalog();
});

type Method = 'get' | 'post' | 'put' | 'patch' | 'delete';
type Call = (method: Method, path: string) => request.Test;

const HOUR = 3600_000;
/** A minimal JPEG (magic bytes and padding): enough for type checks. */
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(2048, 7)]);

async function adminAs(roles: AdminRole[], email = `${roles[0]!.toLowerCase()}@codebegun.com`) {
  const user = await UserModel.create({ primaryEmail: email, adminRoles: roles });
  await UserProfileModel.create({ userId: user._id });
  const { accessToken } = await signInWithEmail(t.app, t.email.sent, email, 'admin');
  const call: Call = (method, path) =>
    request(t.app)
      [method](`/api/v1/admin${path}`)
      .set('Origin', TEST_ORIGIN)
      .set('Authorization', `Bearer ${accessToken}`);
  return Object.assign(call, { accessToken });
}
type Admin = Awaited<ReturnType<typeof adminAs>>;

async function createOrg(admin: Admin, overrides: Partial<CreateOrgBody> = {}) {
  const res = await admin('post', '/orgs')
    .send({
      name: 'Acme Labs',
      type: 'EMPLOYER',
      seats: 5,
      interviewQuota: null,
      walletCredits: 10,
      mfaRequired: false,
      ownerEmail: 'owner@acme.test',
      ...overrides,
    })
    .expect(201);
  return res.body.data.org as { id: string };
}

/** An org member's session: calls under /api/v1/org. */
async function orgAs(email: string) {
  const { accessToken } = await signInWithEmail(t.app, t.email.sent, email, 'org');
  const call: Call = (method, path) =>
    request(t.app)
      [method](`/api/v1/org${path}`)
      .set('Origin', TEST_ORIGIN)
      .set('Authorization', `Bearer ${accessToken}`);
  return Object.assign(call, { accessToken });
}
type Member = Awaited<ReturnType<typeof orgAs>>;

async function candidate(email: string) {
  const { accessToken, user } = await signInWithEmail(t.app, t.email.sent, email);
  const call: Call = (method, path) =>
    request(t.app)
      [method](`/api/v1${path}`)
      .set('Origin', TEST_ORIGIN)
      .set('Authorization', `Bearer ${accessToken}`);
  return Object.assign(call, { userId: String(user.id), accessToken });
}
type Candidate = Awaited<ReturnType<typeof candidate>>;

async function campaignBody(overrides: Partial<CreateCampaignInput> = {}) {
  const role = await RoleModel.findOne({ slug: 'backend-engineer' }).lean();
  return {
    name: 'Backend hiring',
    companyId: null,
    companyName: 'Acme Labs',
    roleId: String(role!._id),
    templateKey: 'standard-practice',
    jobDescription: null,
    modes: ['TEXT'],
    languages: ['en'],
    window: { startAt: new Date(Date.now() - HOUR).toISOString(), endAt: null },
    maxCandidates: null,
    proctoring: { recording: 'OFF', tabSwitchTracking: false },
    candidateSeesReport: true,
    sponsoredCredits: null,
    ...overrides,
  } satisfies CreateCampaignInput;
}

async function orgCampaign(member: Member, overrides: Partial<CreateCampaignInput> = {}) {
  const res = await member('post', '/campaigns')
    .send(await campaignBody(overrides))
    .expect(201);
  const created = CampaignWithInvite.parse(res.body.data);
  await member('post', `/campaigns/${created.campaign.id}/status`)
    .send({ status: 'ACTIVE', reason: 'launch' })
    .expect(200);
  return { id: created.campaign.id, token: created.invitePath.split('/').pop()! };
}

/** The raw token of an invite (the worker decrypts it the same way for the email link). */
async function inviteToken(campaignId: string, email: string) {
  const invite = await CampaignInviteModel.findOne({ campaignId, email }).lean();
  return t.container.ai.secrets.decrypt(invite!.tokenEnc, inviteTokenContext(String(invite!._id)));
}

/** Stands in for the worker's analysis (READY on the pinned blueprint), then accepts every consent. */
async function readyAndConsented(c: Candidate, interviewId: string) {
  const s = await InterviewSessionModel.findById(interviewId).lean();
  const camp = await CampaignModel.findById(s!.campaignId).lean();
  await InterviewSessionModel.updateOne(
    { _id: s!._id },
    { $set: { state: 'READY', blueprintId: camp!.blueprintId } },
  );
  const current = SessionConsents.parse(
    (await c('get', `/interviews/${interviewId}/consents`).expect(200)).body.data,
  );
  await c('post', `/interviews/${interviewId}/consents`)
    .send({ decisions: current.items.map((i) => ({ consentTextId: i.text.id, accepted: true })) })
    .expect(200);
}

/** Stands in for the evaluation pipeline: a score for every blueprint dimension. */
async function scored(interviewId: string, overall: number) {
  const s = await InterviewSessionModel.findById(interviewId).lean();
  const campaign = await CampaignModel.findById(s!.campaignId).lean<CampaignRecord>();
  const dims = await campaignDimensions(campaign!);
  await InterviewSessionModel.updateOne(
    { _id: s!._id },
    { $set: { state: 'REPORT_READY', endedAt: new Date() } },
  );
  await InterviewScoreModel.create({
    sessionId: s!._id,
    userId: s!.userId,
    revision: 0,
    dimensions: dims.map((d) => ({
      key: d.key,
      name: d.name,
      category: 'TECHNICAL',
      weight: 100 / dims.length,
      score: overall,
      aiScore: overall,
      adjusted: false,
      fallback: false,
      rationale: null,
      evidenceIds: [],
    })),
    overall,
    band: overall >= 75 ? 'READY' : 'DEVELOPING',
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
}

async function joinConsented(c: Candidate, path: string) {
  const res = await c('post', path).send({}).expect(201);
  const { interviewId } = JoinCampaignResult.parse(res.body.data);
  await readyAndConsented(c, interviewId);
  const app = await CampaignApplicationModel.findOne({ sessionId: interviewId }).lean();
  return { interviewId, applicationId: String(app!._id) };
}

const actions = async (action: string) => AuditLogModel.find({ action }).sort({ at: 1 }).lean();

describe('organisations, members and sign-in', () => {
  it('super admins create organisations and invite owners; only members get org codes', async () => {
    const admin = await adminAs(['SUPER_ADMIN']);
    const ops = await adminAs(['OPERATIONS_ADMIN']);
    await ops('post', '/orgs').send({}).expect(403);
    const org = await createOrg(admin);
    expect((await ops('get', '/orgs').expect(200)).body.data.total).toBe(1);
    expect(t.email.sent.some((m) => m.to === 'owner@acme.test' && /invited/.test(m.subject))).toBe(
      true,
    );
    expect(await OrgMemberModel.findOne({ orgId: org.id }).lean()).toMatchObject({
      role: 'ORG_OWNER',
      status: 'INVITED',
    });

    const owner = await orgAs('owner@acme.test');
    const me = OrgMeResponse.parse((await owner('get', '/me').expect(200)).body.data);
    expect(me.org).toMatchObject({ id: org.id, name: 'Acme Labs', type: 'EMPLOYER' });
    expect(me.orgRole).toBe('ORG_OWNER');
    expect(me.orgPermissions).toContain('org.members.manage');
    expect((await OrgMemberModel.findOne({ orgId: org.id }).lean())!.status).toBe('ACTIVE');

    // Strangers get the same answer but no code (no enumeration).
    const before = t.email.sent.length;
    await request(t.app)
      .post('/api/v1/org/auth/otp/request')
      .set('Origin', TEST_ORIGIN)
      .send({ channel: 'EMAIL', destination: 'stranger@acme.test' })
      .expect(202);
    expect(t.email.sent.length).toBe(before);

    // Audiences never cross: org tokens do not open admin routes, nor admin/candidate tokens org ones.
    const cand = await candidate('asha@example.com');
    await request(t.app)
      .get('/api/v1/admin/me')
      .set('Origin', TEST_ORIGIN)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .expect(401);
    for (const token of [admin.accessToken, cand.accessToken]) {
      await request(t.app)
        .get('/api/v1/org/me')
        .set('Origin', TEST_ORIGIN)
        .set('Authorization', `Bearer ${token}`)
        .expect(401);
    }
    expect(await actions('org.created')).toHaveLength(1);
    expect(await actions('org.member_invited')).toHaveLength(1);
  });

  it('can require an authenticator app for the organisation', async () => {
    const admin = await adminAs(['SUPER_ADMIN']);
    await createOrg(admin, { mfaRequired: true, ownerEmail: 'secure@acme.test' });
    const agent = request.agent(t.app);
    const requested = await agent
      .post('/api/v1/org/auth/otp/request')
      .set('Origin', TEST_ORIGIN)
      .send({ channel: 'EMAIL', destination: 'secure@acme.test' })
      .expect(202);
    const message = [...t.email.sent].reverse().find((m) => m.to === 'secure@acme.test')!;
    const code = /\b(\d{6})\b/.exec(message.text)![1];
    const first = await agent
      .post('/api/v1/org/auth/otp/verify')
      .set('Origin', TEST_ORIGIN)
      .send({ challengeId: requested.body.data.challengeId, code })
      .expect(200);
    expect(first.body.data).toMatchObject({ mfaRequired: true, mode: 'ENROLL' });
    // No refresh cookie before the second factor.
    expect(first.headers['set-cookie']).toBeUndefined();
    // An org challenge never completes an admin session.
    const challenge = first.body.data as MfaChallenge;
    await agent
      .post('/api/v1/admin/auth/mfa/verify')
      .set('Origin', TEST_ORIGIN)
      .send({ mfaToken: challenge.mfaToken, code: totpCode(challenge.enrollment!.secret) })
      .expect(401);
    const done = await completeMfa(agent, challenge, 'secure@acme.test', 'org');
    expect(done.body.data.recoveryCodes).toHaveLength(10);
    await request(t.app)
      .get('/api/v1/org/me')
      .set('Origin', TEST_ORIGIN)
      .set('Authorization', `Bearer ${done.body.data.accessToken}`)
      .expect(200);
    const enabled = await actions('auth.mfa_enabled');
    expect(enabled.filter((e) => e.actorType === 'ORG_MEMBER')).toHaveLength(1);
  });

  it('owners manage members within their seats; roles limit what members can do', async () => {
    const admin = await adminAs(['SUPER_ADMIN']);
    const org = await createOrg(admin, { seats: 2 });
    const owner = await orgAs('owner@acme.test');
    await owner('post', '/members')
      .send({ email: 'rec@acme.test', role: 'ORG_RECRUITER' })
      .expect(201);
    await owner('post', '/members')
      .send({ email: 'view@acme.test', role: 'ORG_VIEWER' })
      .expect(409);
    await admin('put', `/orgs/${org.id}`)
      .send({
        name: 'Acme Labs',
        seats: 3,
        interviewQuota: null,
        mfaRequired: false,
        reason: 'grow',
      })
      .expect(200);
    await owner('post', '/members')
      .send({ email: 'view@acme.test', role: 'ORG_VIEWER' })
      .expect(201);

    const recruiter = await orgAs('rec@acme.test');
    const viewer = await orgAs('view@acme.test');
    await recruiter('post', '/members')
      .send({ email: 'x@acme.test', role: 'ORG_VIEWER' })
      .expect(403);
    await viewer('post', '/campaigns')
      .send(await campaignBody())
      .expect(403);
    await viewer('get', '/campaigns').expect(200);
    await recruiter('get', '/webhooks').expect(403);

    // The last owner stays an owner.
    const members = (await owner('get', '/members').expect(200)).body.data as {
      id: string;
      email: string;
    }[];
    const ownerId = members.find((m) => m.email === 'owner@acme.test')!.id;
    await owner('put', `/members/${ownerId}`).send({ role: 'ORG_VIEWER' }).expect(409);

    // Removing a member ends their access at once.
    const viewerId = members.find((m) => m.email === 'view@acme.test')!.id;
    await owner('delete', `/members/${viewerId}`).expect(204);
    // Removal ends the member's sessions, and an ended session stops working at once.
    await viewer('get', '/campaigns').expect(401);
    expect(await actions('org.member_removed')).toHaveLength(1);
  });

  it('suspending an organisation blocks its members immediately', async () => {
    const admin = await adminAs(['SUPER_ADMIN']);
    const org = await createOrg(admin);
    const owner = await orgAs('owner@acme.test');
    await admin('post', `/orgs/${org.id}/status`)
      .send({ status: 'SUSPENDED', reason: 'unpaid' })
      .expect(200);
    const res = await owner('get', '/me').expect(403);
    expect(res.body.error.code).toBe('ACCOUNT_SUSPENDED');
  });
});

describe('tenant isolation', () => {
  it("never shows one organisation another's campaigns, candidates, exports or integrations", async () => {
    const admin = await adminAs(['SUPER_ADMIN']);
    await createOrg(admin, { name: 'Org A', ownerEmail: 'a@a.test' });
    await createOrg(admin, { name: 'Org B', ownerEmail: 'b@b.test' });
    const a = await orgAs('a@a.test');
    const b = await orgAs('b@b.test');

    const campA = await orgCampaign(a);
    await a('post', `/campaigns/${campA.id}/invites`)
      .send({ invites: [{ email: 'asha@example.com' }] })
      .expect(201);
    const asha = await candidate('asha@example.com');
    const { applicationId } = await joinConsented(asha, `/campaigns/${campA.token}/join`);
    const hook = (
      await a('post', '/webhooks')
        .send({ url: 'http://hooks.a.test/cb', events: ['candidate.stage_changed'] })
        .expect(201)
    ).body.data.webhook.id as string;
    const keyA = (await a('post', '/api-keys').send({ name: 'ATS' }).expect(201)).body.data;
    const keyB = (await b('post', '/api-keys').send({ name: 'ATS' }).expect(201)).body.data;
    const memberA = ((await a('get', '/members').expect(200)).body.data as { id: string }[])[0]!.id;

    // Lists are scoped to the organisation.
    expect((await b('get', '/campaigns').expect(200)).body.data.total).toBe(0);
    // Every direct id answers 404, exactly like a missing one.
    const notFound: [Method, string, object?][] = [
      ['get', `/campaigns/${campA.id}`],
      ['put', `/campaigns/${campA.id}`, {}],
      ['post', `/campaigns/${campA.id}/status`, { status: 'CLOSED', reason: 'take over' }],
      ['post', `/campaigns/${campA.id}/rotate-invite`, { reason: 'take over' }],
      ['get', `/campaigns/${campA.id}/invites`],
      ['post', `/campaigns/${campA.id}/invites`, { invites: [{ email: 'x@b.test' }] }],
      ['get', `/campaigns/${campA.id}/results`],
      ['get', `/campaigns/${campA.id}/results.csv`],
      ['get', `/campaigns/${campA.id}/candidates/${applicationId}`],
      ['post', `/campaigns/${campA.id}/candidates/${applicationId}/stage`, { stage: 'HIRED' }],
      [
        'post',
        `/campaigns/${campA.id}/candidates/stage`,
        { stage: 'HIRED', applicationIds: [applicationId] },
      ],
      ['post', `/campaigns/${campA.id}/candidates/${applicationId}/notes`, { body: 'x' }],
      [
        'put',
        `/webhooks/${hook}`,
        { events: ['candidate.stage_changed'], active: false, description: null },
      ],
      ['get', `/webhooks/${hook}/deliveries`],
      ['delete', `/webhooks/${hook}`],
      ['post', `/api-keys/${keyA.apiKey.id}/revoke`],
      ['delete', `/members/${memberA}`],
    ];
    for (const [method, path, body] of notFound) {
      const call = b(method, path);
      const res = await (body ? call.send(body) : call);
      if (method === 'put' && path === `/campaigns/${campA.id}`) {
        // An invalid body fails validation first; a valid one still cannot reach the campaign.
        expect([400, 404]).toContain(res.status);
        continue;
      }
      expect(res.status, `${method} ${path}`).toBe(404);
    }
    // B's members could not change anything of A's.
    expect((await CampaignModel.findById(campA.id).lean())!.status).toBe('ACTIVE');
    expect((await CampaignApplicationModel.findById(applicationId).lean())!.stage).toBe('NEW');
    expect(await OrgWebhookModel.countDocuments({ _id: hook, active: true })).toBe(1);
    expect((await OrgApiKeyModel.findById(keyA.apiKey.id).lean())!.revokedAt).toBeNull();

    // API keys are scoped the same way.
    const api = (key: string, path: string) =>
      request(t.app).get(`/api/v1/org-api${path}`).set('Authorization', `Bearer ${key}`);
    await api(keyB.key, `/campaigns/${campA.id}/results`).expect(404);
    expect((await api(keyB.key, '/campaigns').expect(200)).body.data.total).toBe(0);
    const viaA = OrgResults.parse(
      (await api(keyA.key, `/campaigns/${campA.id}/results`).expect(200)).body.data,
    );
    expect(viaA.rows).toHaveLength(1);

    // CodeBegun admins still see every campaign.
    expect((await admin('get', '/campaigns').expect(200)).body.data.total).toBe(1);
  });
});

describe('org campaigns, wallet and quota', () => {
  it('draws sponsored budgets from the wallet and returns unused ones on close', async () => {
    const admin = await adminAs(['SUPER_ADMIN']);
    const org = await createOrg(admin, { walletCredits: 3 });
    const owner = await orgAs('owner@acme.test');
    const refused = await owner('post', '/campaigns')
      .send(await campaignBody({ sponsoredCredits: 5 }))
      .expect(402);
    expect(refused.body.error.code).toBe('INSUFFICIENT_CREDITS');
    await admin('post', `/orgs/${org.id}/wallet`).send({ delta: 7, reason: 'top up' }).expect(200);

    const { id } = await orgCampaign(owner, { sponsoredCredits: 5 });
    expect((await OrgModel.findById(org.id).lean())!.wallet).toEqual({ balance: 5, allocated: 5 });
    const summary = (await owner('get', `/campaigns/${id}`).expect(200)).body.data;
    await owner('put', `/campaigns/${id}`)
      .send({
        name: summary.name,
        companyName: summary.companyName,
        jobDescription: null,
        window: summary.window,
        maxCandidates: null,
        candidateSeesReport: true,
        sponsoredCredits: 8,
        reason: 'more candidates',
      })
      .expect(200);
    expect((await OrgModel.findById(org.id).lean())!.wallet).toEqual({ balance: 2, allocated: 8 });
    await owner('post', `/campaigns/${id}/status`)
      .send({ status: 'CLOSED', reason: 'done' })
      .expect(200);
    expect((await OrgModel.findById(org.id).lean())!.wallet).toEqual({ balance: 10, allocated: 0 });
    const closed = await actions('campaign.status_changed');
    expect(closed.at(-1)).toMatchObject({
      actorType: 'ORG_MEMBER',
      details: expect.objectContaining({ returnedToWallet: 8 }),
    });
  });

  it("never lets more candidates join than the organisation's interview quota", async () => {
    const admin = await adminAs(['SUPER_ADMIN']);
    await createOrg(admin, { interviewQuota: 1 });
    const owner = await orgAs('owner@acme.test');
    const { token } = await orgCampaign(owner);
    const one = await candidate('one@example.com');
    const two = await candidate('two@example.com');
    await one('post', `/campaigns/${token}/join`).send({}).expect(201);
    const res = await two('post', `/campaigns/${token}/join`).send({}).expect(409);
    expect(res.body.error.code).toBe('CAMPAIGN_CLOSED');
  });
});

describe('invites', () => {
  it('previews CSVs, creates invites once per email and tracks opened and joined', async () => {
    const admin = await adminAs(['SUPER_ADMIN']);
    await createOrg(admin);
    const owner = await orgAs('owner@acme.test');
    const { id } = await orgCampaign(owner);

    await owner('post', `/campaigns/${id}/invites`)
      .send({ invites: [{ email: 'asha@example.com', name: 'Asha', language: 'hi' }] })
      .expect(201);
    const preview = (
      await owner('post', `/campaigns/${id}/invites/preview`)
        .send({
          csv: 'email,name,language\nasha@example.com,Asha,\nravi@example.com,Ravi,te\nbad,,\n',
        })
        .expect(200)
    ).body.data;
    expect(preview.valid.map((r: { email: string }) => r.email)).toEqual(['ravi@example.com']);
    expect(preview.duplicates).toEqual(['asha@example.com']);
    expect(preview.errors).toEqual([expect.objectContaining({ line: 4 })]);
    const bulk = await owner('post', `/campaigns/${id}/invites`)
      .send({ invites: [...preview.valid, { email: 'asha@example.com' }] })
      .expect(201);
    expect(bulk.body.data).toEqual({ created: 1, skipped: ['asha@example.com'] });

    // New invites wait for the worker's mailer.
    const pending = await CampaignInviteModel.find({ campaignId: id }).lean();
    expect(pending.every((i) => i.status === 'PENDING' && i.nextSendAt)).toBe(true);
    expect(pending.every((i) => !JSON.stringify(i.tokenEnc).includes(i.tokenHash))).toBe(true);

    // The personal link opens the landing page and marks the invite opened.
    const token = await inviteToken(id, 'asha@example.com');
    await CampaignInviteModel.updateOne(
      { campaignId: id, email: 'asha@example.com' },
      { $set: { status: 'SENT' } },
    );
    const landing = await request(t.app).get(`/api/v1/campaign-invites/${token}`).expect(200);
    expect(landing.body.data).toMatchObject({ companyName: 'Acme Labs', inviteOnly: false });
    const asha = await candidate('asha@example.com');
    const joined = await asha('post', `/campaign-invites/${token}/join`).send({}).expect(201);
    const invite = await CampaignInviteModel.findOne({
      campaignId: id,
      email: 'asha@example.com',
    }).lean();
    expect(invite).toMatchObject({ status: 'JOINED', userId: expect.anything(), nextSendAt: null });
    expect(invite!.openedAt).toBeInstanceOf(Date);
    const app = await CampaignApplicationModel.findOne({
      sessionId: joined.body.data.interviewId,
    }).lean();
    expect(String(app!.inviteId)).toBe(String(invite!._id));

    const list = InviteListPage.parse(
      (await owner('get', `/campaigns/${id}/invites`).expect(200)).body.data,
    );
    expect(list.counts).toMatchObject({ JOINED: 1, PENDING: 1 });
    expect(await actions('org.invites_created')).toHaveLength(2);
  });

  it('admits only invited emails to invite-only campaigns; revoked links stop working', async () => {
    const admin = await adminAs(['SUPER_ADMIN']);
    await createOrg(admin);
    const owner = await orgAs('owner@acme.test');
    const { id, token } = await orgCampaign(owner, { requireInvite: true });
    await owner('post', `/campaigns/${id}/invites`)
      .send({ invites: [{ email: 'asha@example.com' }, { email: 'kiran@example.com' }] })
      .expect(201);

    const ravi = await candidate('ravi@example.com');
    const refused = await ravi('post', `/campaigns/${token}/join`).send({}).expect(403);
    expect(refused.body.error.code).toBe('INVITE_REQUIRED');
    // A forwarded personal link does not help someone else.
    const ashaLink = await inviteToken(id, 'asha@example.com');
    const forwarded = await ravi('post', `/campaign-invites/${ashaLink}/join`).send({}).expect(403);
    expect(forwarded.body.error.message).toContain('@example.com');
    expect(forwarded.body.error.message).not.toContain('asha@');

    // The invited email joins even through the shared link, and the invite is linked.
    const asha = await candidate('asha@example.com');
    await asha('post', `/campaigns/${token}/join`).send({}).expect(201);
    expect((await CampaignInviteModel.findOne({ email: 'asha@example.com' }).lean())!.status).toBe(
      'JOINED',
    );

    const kiran = (await owner('get', `/campaigns/${id}/invites?q=kiran`).expect(200)).body.data
      .items[0];
    await owner('post', `/campaigns/${id}/invites/${kiran.id}/revoke`).expect(200);
    const kiranLink = await inviteToken(id, 'kiran@example.com');
    await request(t.app).get(`/api/v1/campaign-invites/${kiranLink}`).expect(404);
    expect(await actions('org.invite_revoked')).toHaveLength(1);
  });
});

describe('pipeline and collaboration', () => {
  it('shows only consenting candidates, moves stages, notes, scorecards, webhooks and exports', async () => {
    const admin = await adminAs(['SUPER_ADMIN']);
    await createOrg(admin);
    const owner = await orgAs('owner@acme.test');
    await owner('post', '/members')
      .send({ email: 'rec@acme.test', role: 'ORG_RECRUITER' })
      .expect(201);
    const recruiter = await orgAs('rec@acme.test');
    const { id, token } = await orgCampaign(owner, { employerView: 'SCORES' });
    const created = await owner('post', '/webhooks')
      .send({
        url: 'http://hooks.acme.test/cb',
        events: ['candidate.stage_changed', 'campaign.candidate_completed'],
      })
      .expect(201);
    const secret = created.body.data.secret as string;
    const stored = await OrgWebhookModel.findById(created.body.data.webhook.id).lean();
    expect(JSON.stringify(stored)).not.toContain(secret);
    expect(
      t.container.ai.secrets.decrypt(stored!.secret, webhookSecretContext(String(stored!._id))),
    ).toBe(secret);

    const asha = await candidate('asha@example.com');
    const ravi = await candidate('ravi@example.com');
    const a = await joinConsented(asha, `/campaigns/${token}/join`);
    const b = await joinConsented(ravi, `/campaigns/${token}/join`);
    // Joined but has not agreed to share yet: invisible to the organisation.
    const kiran = await candidate('kiran@example.com');
    const k = await kiran('post', `/campaigns/${token}/join`).send({}).expect(201);
    const kApp = await CampaignApplicationModel.findOne({
      sessionId: k.body.data.interviewId,
    }).lean();
    await scored(a.interviewId, 82);
    await scored(b.interviewId, 55);

    let results = OrgResults.parse(
      (await owner('get', `/campaigns/${id}/results`).expect(200)).body.data,
    );
    expect(results.total).toBe(2);
    expect(results.rows.map((r) => r.overall)).toEqual([82, 55]);
    expect(results.stages).toMatchObject({ NEW: 2 });
    await owner('get', `/campaigns/${id}/candidates/${String(kApp!._id)}`).expect(404);

    // Stage changes: one, then in bulk (the non-consenting candidate never moves).
    await recruiter('post', `/campaigns/${id}/candidates/${a.applicationId}/stage`)
      .send({ stage: 'SHORTLISTED', note: 'Strong API design' })
      .expect(200);
    const bulk = await recruiter('post', `/campaigns/${id}/candidates/stage`)
      .send({ stage: 'ON_HOLD', applicationIds: [b.applicationId, String(kApp!._id)] })
      .expect(200);
    expect(bulk.body.data).toEqual({ changed: 1 });
    expect((await CampaignApplicationModel.findById(kApp!._id).lean())!.stage).toBe('NEW');

    const deliveries = await WebhookDeliveryModel.find({ event: 'candidate.stage_changed' }).lean();
    expect(deliveries).toHaveLength(2);
    const payload = JSON.parse(deliveries[0]!.body);
    expect(payload).toMatchObject({
      event: 'candidate.stage_changed',
      data: { campaignId: id, applicationId: a.applicationId, from: 'NEW', to: 'SHORTLISTED' },
    });
    expect(deliveries[0]).toMatchObject({ status: 'PENDING', attempts: 0 });

    // Notes (mentions kept as text) and a scorecard per reviewer.
    const note = await recruiter('post', `/campaigns/${id}/candidates/${a.applicationId}/notes`)
      .send({ body: 'Great answers, @owner please review. cc @ravi@acme.test' })
      .expect(201);
    expect(note.body.data.mentions).toEqual(['owner', 'ravi@acme.test']);
    await recruiter('put', `/campaigns/${id}/candidates/${a.applicationId}/scorecard`)
      .send({ ratings: { communication: 5 }, recommendation: 'YES' })
      .expect(400);
    await recruiter('put', `/campaigns/${id}/candidates/${a.applicationId}/scorecard`)
      .send({
        ratings: { communication: 5, 'problem-solving': 4, 'role-fit': 4 },
        recommendation: 'STRONG_YES',
      })
      .expect(200);
    await owner('put', `/campaigns/${id}/candidates/${a.applicationId}/scorecard`)
      .send({
        ratings: { communication: 3, 'problem-solving': 3, 'role-fit': 3 },
        recommendation: 'YES',
      })
      .expect(200);

    const detail = (
      await owner('get', `/campaigns/${id}/candidates/${a.applicationId}`).expect(200)
    ).body.data;
    expect(detail.row).toMatchObject({ stage: 'SHORTLISTED', scorecards: 2, notes: 1 });
    expect(detail.row.scorecardAverage).toBeCloseTo(3.67, 1);
    // SCORES: no report narrative or transcript for this campaign.
    expect(detail.report).toBeNull();
    expect(detail.stageHistory).toEqual([
      expect.objectContaining({ from: 'NEW', to: 'SHORTLISTED', note: 'Strong API design' }),
    ]);

    // Filters: stage and scorecard.
    results = OrgResults.parse(
      (await owner('get', `/campaigns/${id}/results?stage=ON_HOLD`).expect(200)).body.data,
    );
    expect(results.rows.map((r) => r.applicationId)).toEqual([b.applicationId]);
    results = OrgResults.parse(
      (await owner('get', `/campaigns/${id}/results?minScorecard=3.5`).expect(200)).body.data,
    );
    expect(results.rows.map((r) => r.applicationId)).toEqual([a.applicationId]);

    // CSV export, audited; viewers cannot export.
    const csv = await owner('get', `/campaigns/${id}/results.csv?stage=SHORTLISTED`).expect(200);
    const lines = csv.text.slice(1).split('\r\n').filter(Boolean);
    expect(lines[0]).toContain('Stage');
    expect(lines).toHaveLength(2);
    expect(await actions('org.results_exported')).toEqual([
      expect.objectContaining({ details: expect.objectContaining({ rows: 1 }) }),
    ]);
    expect(await actions('org.candidate_viewed')).toHaveLength(1);
    expect(await actions('org.stage_changed')).toHaveLength(2);

    // Report ready (the worker's last stage): invite completed and the webhook queued once.
    await campaignInterviewCompleted(a.interviewId);
    await campaignInterviewCompleted(a.interviewId);
    const completed = await WebhookDeliveryModel.find({
      event: 'campaign.candidate_completed',
    }).lean();
    expect(completed).toHaveLength(1);
    expect(JSON.parse(completed[0]!.body).data).toMatchObject({
      applicationId: a.applicationId,
      overall: 82,
      candidate: { email: 'asha@example.com' },
    });
    // The worker signs the stored body with the secret shown at creation.
    const body = completed[0]!.body;
    expect(verifyWebhookSignature(secret, webhookSignatureHeader(secret, body), body)).toBe(true);
  });
});

describe('webhooks and API keys', () => {
  it('queues signed pings, logs deliveries and authenticates hashed API keys', async () => {
    const admin = await adminAs(['SUPER_ADMIN']);
    await createOrg(admin);
    const owner = await orgAs('owner@acme.test');
    await owner('post', '/webhooks')
      .send({ url: 'ftp://x.test/', events: ['candidate.stage_changed'] })
      .expect(400);
    const hook = (
      await owner('post', '/webhooks')
        .send({ url: 'http://hooks.acme.test/cb', events: ['candidate.stage_changed'] })
        .expect(201)
    ).body.data.webhook;
    await owner('post', `/webhooks/${hook.id}/ping`).expect(202);
    const log = (await owner('get', `/webhooks/${hook.id}/deliveries`).expect(200)).body.data;
    expect(log).toEqual([expect.objectContaining({ event: 'ping', status: 'PENDING' })]);

    const { key, apiKey } = (
      await owner('post', '/api-keys').send({ name: 'Greenhouse' }).expect(201)
    ).body.data;
    expect(key).toMatch(/^cbk_[A-Za-z0-9]{8}_/);
    const stored = await OrgApiKeyModel.findById(apiKey.id).lean();
    expect(JSON.stringify(stored)).not.toContain(key);
    const api = (k: string) =>
      request(t.app).get('/api/v1/org-api/campaigns').set('Authorization', `Bearer ${k}`);
    await api(key).expect(200);
    await api(`${key.slice(0, -1)}x`).expect(401);
    await request(t.app).get('/api/v1/org-api/campaigns').expect(401);
    // Org session tokens are not API keys.
    await api(owner.accessToken).expect(401);
    await owner('post', `/api-keys/${apiKey.id}/revoke`).expect(200);
    await api(key).expect(401);
    expect(await actions('org.api_key_created')).toHaveLength(1);
    expect(await actions('org.webhook_created')).toHaveLength(1);
  });
});

describe('college cohort analytics', () => {
  it('aggregates readiness, participation and improvement per student across campaigns', async () => {
    const admin = await adminAs(['SUPER_ADMIN']);
    await createOrg(admin, { type: 'COLLEGE', name: 'City College', ownerEmail: 'tpo@city.test' });
    const tpo = await orgAs('tpo@city.test');
    const first = await orgCampaign(tpo, { name: 'Mock round 1' });
    const second = await orgCampaign(tpo, { name: 'Mock round 2' });
    for (const c of [first, second]) {
      await tpo('post', `/campaigns/${c.id}/invites`)
        .send({
          invites: [
            { email: 'asha@city.test', tags: { batch: '2026', branch: 'CSE', year: 2026 } },
            { email: 'ravi@city.test', tags: { batch: '2026', branch: 'ECE', year: 2026 } },
          ],
        })
        .expect(201);
    }
    const asha = await candidate('asha@city.test');
    const one = await joinConsented(asha, `/campaigns/${first.token}/join`);
    await scored(one.interviewId, 50);
    const two = await joinConsented(asha, `/campaigns/${second.token}/join`);
    await scored(two.interviewId, 74);

    const cohort = (await tpo('get', '/analytics/cohort').expect(200)).body.data;
    expect(cohort.participation).toEqual({ invited: 4, joined: 2, completed: 2, rate: 0.5 });
    expect(cohort.improvement).toMatchObject({ students: 1, averageDelta: 24, improved: 1 });
    expect(cohort.students[0]).toMatchObject({
      email: 'asha@city.test',
      firstOverall: 50,
      latestOverall: 74,
    });
    expect(cohort.tagValues.branch).toEqual(['CSE', 'ECE']);
    const ece = (await tpo('get', '/analytics/cohort?branch=ECE').expect(200)).body.data;
    expect(ece.participation).toMatchObject({ invited: 2, joined: 0 });

    const csv = await tpo('get', '/analytics/cohort.csv').expect(200);
    expect(csv.text).toContain('asha@city.test');
    expect(await actions('org.cohort_exported')).toHaveLength(1);

    // Employers do not have cohort analytics.
    await createOrg(admin, { ownerEmail: 'hr@acme.test' });
    const hr = await orgAs('hr@acme.test');
    await hr('get', '/analytics/cohort').expect(403);
  });
});

describe('identity capture', () => {
  it('needs consent and both photos before starting; reviewers verify by eye', async () => {
    const admin = await adminAs(['SUPER_ADMIN']);
    await createOrg(admin);
    const owner = await orgAs('owner@acme.test');
    const { id, token } = await orgCampaign(owner, { idCapture: true });
    const asha = await candidate('asha@example.com');
    const joined = await asha('post', `/campaigns/${token}/join`).send({}).expect(201);
    const interviewId = joined.body.data.interviewId as string;
    const s = await InterviewSessionModel.findById(interviewId).lean();
    const camp = await CampaignModel.findById(s!.campaignId).lean();
    await InterviewSessionModel.updateOne(
      { _id: s!._id },
      { $set: { state: 'READY', blueprintId: camp!.blueprintId } },
    );
    const upload = (kind: string, body: Buffer, type = 'image/jpeg') =>
      asha('put', `/interviews/${interviewId}/identity/${kind}`)
        .set('Content-Type', type)
        .send(body);

    // Before the consent: refused.
    await upload('selfie', JPEG).expect(409);
    const consents = SessionConsents.parse(
      (await asha('get', `/interviews/${interviewId}/consents`).expect(200)).body.data,
    );
    expect(consents.items.map((i) => i.type)).toContain('IDENTITY_CAPTURE');
    await asha('post', `/interviews/${interviewId}/consents`)
      .send({
        decisions: consents.items.map((i) => ({ consentTextId: i.text.id, accepted: true })),
      })
      .expect(200);

    let summary = (await asha('get', `/interviews/${interviewId}`).expect(200)).body.data;
    expect(summary.campaign.identity).toEqual({
      required: true,
      selfie: false,
      idDocument: false,
      complete: false,
    });
    const blocked = await asha('post', `/interviews/${interviewId}/start`).send({}).expect(409);
    expect(blocked.body.error.message).toMatch(/selfie/i);

    await upload('selfie', Buffer.from('not an image'), 'image/png').expect(415);
    await upload('selfie', JPEG).expect(200);
    await upload('id-document', JPEG).expect(200);
    summary = (await asha('get', `/interviews/${interviewId}`).expect(200)).body.data;
    expect(summary.campaign.identity.complete).toBe(true);
    const capture = await IdentityCaptureModel.findOne({ sessionId: interviewId }).lean();
    expect(capture!.retentionExpiresAt.getTime()).toBeGreaterThan(Date.now() + 80 * 24 * HOUR);

    const app = await CampaignApplicationModel.findOne({ sessionId: interviewId }).lean();
    const appId = String(app!._id);
    const detail = (await owner('get', `/campaigns/${id}/candidates/${appId}`).expect(200)).body
      .data;
    expect(detail.identity).toMatchObject({ status: 'CAPTURED' });
    const image = await owner(
      'get',
      detail.identity.imagePaths.selfie.replace(/^\/org/, ''),
    ).expect(200);
    expect(image.headers['content-type']).toBe('image/jpeg');
    await owner('post', `/campaigns/${id}/candidates/${appId}/identity/review`)
      .send({ decision: 'VERIFIED', note: 'Matches the ID' })
      .expect(200);
    const results = OrgResults.parse(
      (await owner('get', `/campaigns/${id}/results`).expect(200)).body.data,
    );
    expect(results.rows[0]!.identity).toBe('VERIFIED');
    expect(await actions('org.identity_viewed')).toHaveLength(1);
    expect(await actions('org.identity_reviewed')).toHaveLength(1);
    expect(await actions('identity.captured')).toHaveLength(2);
  });
});

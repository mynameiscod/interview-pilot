import { totpCode } from '@cbi/auth-core';
import {
  AuditLogModel,
  JobTargetModel,
  RefreshTokenModel,
  UserModel,
  UserProfileModel,
} from '@cbi/db';
import { CandidateDetail, DataExportBundle, MfaChallenge, type AdminRole } from '@cbi/shared-types';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { buildTestApp, TEST_ORIGIN } from '../../test-support/harness.js';
import {
  extractCode,
  refresh,
  signInWithEmail,
  useIntegrationServices,
} from '../../test-support/integration.js';

const { redis } = useIntegrationServices();
let t: Awaited<ReturnType<typeof buildTestApp>>;

beforeEach(async () => {
  t = await buildTestApp({ redis });
});

const as = (token: string) => ({
  get: (path: string) =>
    request(t.app)
      .get(`/api/v1${path}`)
      .set('Origin', TEST_ORIGIN)
      .set('Authorization', `Bearer ${token}`),
  post: (path: string) =>
    request(t.app)
      .post(`/api/v1${path}`)
      .set('Origin', TEST_ORIGIN)
      .set('Authorization', `Bearer ${token}`),
  delete: (path: string) =>
    request(t.app)
      .delete(`/api/v1${path}`)
      .set('Origin', TEST_ORIGIN)
      .set('Authorization', `Bearer ${token}`),
});

async function seedAdmin(email: string, roles: AdminRole[]) {
  const user = await UserModel.create({ primaryEmail: email, adminRoles: roles });
  await UserProfileModel.create({ userId: user._id });
  return String(user._id);
}

describe('data export', () => {
  it('returns the candidate’s data without secrets', async () => {
    const { accessToken, user } = await signInWithEmail(t.app, t.email.sent, 'asha@example.com');
    await as(accessToken)
      .post('/jobs')
      .send({ source: 'PASTE', text: 'Backend engineer. '.repeat(20) })
      .expect(201);
    const res = await as(accessToken).get('/users/me/export').expect(200);
    expect(res.headers['content-disposition']).toMatch(/attachment; filename="careerpilot-data-/);
    const bundle = DataExportBundle.parse(res.body.data);
    expect(bundle.account.id).toBe(user.id);
    expect(bundle.identities).toHaveLength(1);
    expect(bundle.jobDescriptions).toHaveLength(1);
    const text = JSON.stringify(bundle);
    for (const secret of ['tokenHash', 'codeHash', 'passwordHash', 'storageKey']) {
      expect(text).not.toContain(secret);
    }
    expect(await AuditLogModel.countDocuments({ action: 'privacy.data_exported' })).toBe(1);
  });
});

describe('account deletion', () => {
  it('locks the account at once and a sign-in within the grace period cancels it', async () => {
    const first = await signInWithEmail(t.app, t.email.sent, 'ravi@example.com');
    const res = await as(first.accessToken)
      .delete('/users/me')
      .send({ method: 'TYPED', confirmText: 'DELETE' })
      .expect(202);
    expect(res.body.data.graceDays).toBe(7);
    const user = await UserModel.findById(first.user.id).lean();
    expect(user!.status).toBe('DELETION_PENDING');
    // Every session ended: the old access token and refresh cookie no longer work.
    await as(first.accessToken).get('/users/me').expect(401);
    await refresh(first.agent).expect(401);

    await redis.flushdb(); // resend cooldown
    const again = await signInWithEmail(t.app, t.email.sent, 'ravi@example.com');
    expect(again.user.id).toBe(first.user.id);
    expect((await UserModel.findById(first.user.id).lean())!.status).toBe('ACTIVE');
    expect(await AuditLogModel.countDocuments({ action: 'privacy.deletion_cancelled' })).toBe(1);
  });

  it('accepts a re-verification code sent to the candidate’s own email', async () => {
    const { accessToken } = await signInWithEmail(t.app, t.email.sent, 'meera@example.com');
    await redis.flushdb();
    const sent = await as(accessToken)
      .post('/users/me/reauth/otp')
      .send({ channel: 'EMAIL' })
      .expect(202);
    const code = extractCode(t.email.sent.at(-1)!.text);
    await as(accessToken)
      .delete('/users/me')
      .send({ method: 'OTP', challengeId: sent.body.data.challengeId, code })
      .expect(202);
  });

  it('refuses staff accounts', async () => {
    await seedAdmin('ops@codebegun.com', ['SUPPORT_ADMIN']);
    const { accessToken } = await signInWithEmail(t.app, t.email.sent, 'ops@codebegun.com');
    await as(accessToken)
      .delete('/users/me')
      .send({ method: 'TYPED', confirmText: 'DELETE' })
      .expect(409);
  });
});

describe('signed-in devices', () => {
  it('lists devices and signs one out', async () => {
    const a = await signInWithEmail(t.app, t.email.sent, 'dev@example.com');
    await redis.flushdb();
    const b = await signInWithEmail(t.app, t.email.sent, 'dev@example.com');
    const list = (await as(b.accessToken).get('/auth/sessions').expect(200)).body.data;
    expect(list).toHaveLength(2);
    const other = list.find((s: { current: boolean }) => !s.current);
    await as(b.accessToken).delete(`/auth/sessions/${other.id}`).expect(204);
    await refresh(a.agent).expect(401);
    await refresh(b.agent).expect(200);
  });

  it('ends a session at its absolute lifetime however often it refreshes', async () => {
    const s = await signInWithEmail(t.app, t.email.sent, 'old@example.com');
    await RefreshTokenModel.updateMany(
      {},
      { $set: { familyCreatedAt: new Date(Date.now() - 91 * 24 * 3600 * 1000) } },
    );
    await refresh(s.agent).expect(401);
  });
});

describe('admin two-factor authentication', () => {
  it('requires enrolment for a super admin, then a code (or a recovery code) each sign-in', async () => {
    await seedAdmin('root@codebegun.com', ['SUPER_ADMIN']);
    const agent = request.agent(t.app);
    const otp = async () => {
      await redis.del(...(await redis.keys('cbi:otp:cooldown:*')));
      const req = await agent
        .post('/api/v1/admin/auth/otp/request')
        .set('Origin', TEST_ORIGIN)
        .send({ channel: 'EMAIL', destination: 'root@codebegun.com' })
        .expect(202);
      return agent
        .post('/api/v1/admin/auth/otp/verify')
        .set('Origin', TEST_ORIGIN)
        .send({
          challengeId: req.body.data.challengeId,
          code: extractCode(t.email.sent.at(-1)!.text),
        })
        .expect(200);
    };
    const enroll = MfaChallenge.parse((await otp()).body.data);
    expect(enroll.mode).toBe('ENROLL');
    const secret = enroll.enrollment!.secret;
    await agent
      .post('/api/v1/admin/auth/mfa/verify')
      .set('Origin', TEST_ORIGIN)
      .send({ mfaToken: enroll.mfaToken, code: '000000' })
      .expect(400);
    const enrolled = await agent
      .post('/api/v1/admin/auth/mfa/verify')
      .set('Origin', TEST_ORIGIN)
      .send({ mfaToken: enroll.mfaToken, code: totpCode(secret) })
      .expect(200);
    expect(enrolled.body.data.recoveryCodes).toHaveLength(10);
    const stored = await UserModel.findOne({ primaryEmail: 'root@codebegun.com' })
      .select('+mfa')
      .lean();
    expect(JSON.stringify(stored)).not.toContain(secret);

    const verify = MfaChallenge.parse((await otp()).body.data);
    expect(verify.mode).toBe('VERIFY');
    const recovery = enrolled.body.data.recoveryCodes[0];
    await agent
      .post('/api/v1/admin/auth/mfa/verify')
      .set('Origin', TEST_ORIGIN)
      .send({ mfaToken: verify.mfaToken, recoveryCode: recovery })
      .expect(200);
    // The token and the recovery code are single-use.
    await agent
      .post('/api/v1/admin/auth/mfa/verify')
      .set('Origin', TEST_ORIGIN)
      .send({ mfaToken: verify.mfaToken, recoveryCode: recovery })
      .expect(401);
  });
});

describe('candidates console', () => {
  it('finds a candidate, suspends (ending sessions) and reinstates them, all audited', async () => {
    const candidate = await signInWithEmail(t.app, t.email.sent, 'asha@example.com');
    await seedAdmin('ops@codebegun.com', ['OPERATIONS_ADMIN']);
    await redis.flushdb();
    const admin = await signInWithEmail(t.app, t.email.sent, 'ops@codebegun.com', 'admin');
    const found = await as(admin.accessToken)
      .get('/admin/candidates?q=asha@example.com')
      .expect(200);
    expect(found.body.data.items).toHaveLength(1);
    const id = found.body.data.items[0].id;
    CandidateDetail.parse((await as(admin.accessToken).get(`/admin/candidates/${id}`)).body.data);

    await as(admin.accessToken)
      .post(`/admin/candidates/${id}/suspend`)
      .send({ reason: 'Uploading other people’s resumes' })
      .expect(204);
    await as(candidate.accessToken).get('/users/me').expect(401);
    await refresh(candidate.agent).expect(401);
    await as(admin.accessToken)
      .post(`/admin/candidates/${id}/reinstate`)
      .send({ reason: 'Resolved with the candidate' })
      .expect(204);
    expect(await AuditLogModel.countDocuments({ action: 'candidate.suspended' })).toBe(1);
    expect(await AuditLogModel.countDocuments({ action: 'candidate.reinstated' })).toBe(1);
  });

  it('lets support read candidates but not suspend them', async () => {
    const candidate = await signInWithEmail(t.app, t.email.sent, 'asha@example.com');
    await seedAdmin('help@codebegun.com', ['SUPPORT_ADMIN']);
    await redis.flushdb();
    const admin = await signInWithEmail(t.app, t.email.sent, 'help@codebegun.com', 'admin');
    await as(admin.accessToken).get('/admin/candidates').expect(200);
    await as(admin.accessToken)
      .post(`/admin/candidates/${candidate.user.id}/suspend`)
      .send({ reason: 'Not allowed' })
      .expect(403);
  });
});

describe('job description deletion', () => {
  it('deletes an unused job description and hides it from the list', async () => {
    const { accessToken } = await signInWithEmail(t.app, t.email.sent, 'jd@example.com');
    const created = await as(accessToken)
      .post('/jobs')
      .send({ source: 'ROLE_ONLY', roleTitle: 'QA Engineer' })
      .expect(201);
    await as(accessToken).delete(`/jobs/${created.body.data.id}`).expect(204);
    await as(accessToken).get(`/jobs/${created.body.data.id}`).expect(404);
    expect(await JobTargetModel.countDocuments()).toBe(0);
  });

  it('enforces the daily quota', async () => {
    t = await buildTestApp({ redis, env: { INPUT_DAILY_LIMIT_JOBS: '1' } });
    const { accessToken } = await signInWithEmail(t.app, t.email.sent, 'quota@example.com');
    const body = { source: 'ROLE_ONLY', roleTitle: 'QA Engineer' };
    await as(accessToken).post('/jobs').send(body).expect(201);
    const res = await as(accessToken).post('/jobs').send(body).expect(429);
    expect(res.body.error.code).toBe('QUOTA_EXCEEDED');
  });
});

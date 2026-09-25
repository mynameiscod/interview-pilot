import { hashPassword } from '@cbi/auth-core';
import { AuditLogModel, UserModel, UserProfileModel } from '@cbi/db';
import type { AdminRole } from '@cbi/shared-types';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { buildTestApp, TEST_ORIGIN } from '../../test-support/harness.js';
import { useIntegrationServices } from '../../test-support/integration.js';

const { redis } = useIntegrationServices();

let t: Awaited<ReturnType<typeof buildTestApp>>;

beforeEach(async () => {
  t = await buildTestApp({ redis });
});

const PASSWORD = 'Blue-Tiger-Runs-42';

async function user(email: string, roles: AdminRole[] = ['SUPER_ADMIN'], password = PASSWORD) {
  const u = await UserModel.create({
    primaryEmail: email,
    adminRoles: roles,
    passwordHash: await hashPassword(password),
  });
  await UserProfileModel.create({ userId: u._id });
  return u;
}

const login = (email: string, password: string) =>
  request(t.app)
    .post('/api/v1/admin/auth/password/login')
    .set('Origin', TEST_ORIGIN)
    .send({ email, password });

describe('admin password sign-in', () => {
  it('signs a super admin in with email and password', async () => {
    const owner = await user('owner@codebegun.com');
    const res = await login('Owner@CodeBegun.com', PASSWORD).expect(200);
    expect(res.body.data.user).toMatchObject({
      id: String(owner._id),
      adminRoles: ['SUPER_ADMIN'],
    });
    expect(res.headers['set-cookie']?.[0]).toMatch(/cbi_admin_rt=/);
    const me = await request(t.app)
      .get('/api/v1/admin/me')
      .set('Origin', TEST_ORIGIN)
      .set('Authorization', `Bearer ${res.body.data.accessToken}`)
      .expect(200);
    expect(me.body.data).toMatchObject({ hasPassword: true });
    expect(me.body.data.permissions).toContain('system.manage');
  });

  it('answers the same for a wrong password, an unknown email and a non-admin', async () => {
    await user('owner@codebegun.com');
    await user('candidate@example.com', []);
    for (const [email, pw] of [
      ['owner@codebegun.com', 'Wrong-Password-99'],
      ['nobody@codebegun.com', PASSWORD],
      ['candidate@example.com', PASSWORD],
    ] as const) {
      const res = await login(email, pw).expect(401);
      expect(res.body.error).toMatchObject({
        code: 'INVALID_CREDENTIALS',
        message: 'The email or password is incorrect.',
      });
    }
    expect(await AuditLogModel.countDocuments({ action: 'auth.login_failed' })).toBe(3);
  });

  it('pauses after repeated failures, for real and unknown emails alike', async () => {
    await user('owner@codebegun.com');
    for (const email of ['owner@codebegun.com', 'ghost@codebegun.com']) {
      for (let i = 0; i < 5; i++) await login(email, 'Wrong-Password-99').expect(401);
      const locked = await login(email, email.startsWith('owner') ? PASSWORD : 'x').expect(429);
      expect(locked.body.error.code).toBe('ACCOUNT_LOCKED');
    }
  });

  it('changes the password only with the current one, and not for candidates', async () => {
    await user('owner@codebegun.com');
    const session = (await login('owner@codebegun.com', PASSWORD).expect(200)).body.data;
    const change = (body: object) =>
      request(t.app)
        .post('/api/v1/admin/auth/password')
        .set('Origin', TEST_ORIGIN)
        .set('Authorization', `Bearer ${session.accessToken}`)
        .send(body);
    await change({ currentPassword: 'nope', newPassword: 'Green-Owl-Sings-77' }).expect(400);
    await change({ currentPassword: PASSWORD, newPassword: 'short' }).expect(400);
    await change({ currentPassword: PASSWORD, newPassword: 'Green-Owl-Sings-77' }).expect(200);
    await login('owner@codebegun.com', PASSWORD).expect(401);
    await login('owner@codebegun.com', 'Green-Owl-Sings-77').expect(200);
    expect(await AuditLogModel.countDocuments({ action: 'auth.password_changed' })).toBe(1);
    // Candidates have no password sign-in at all.
    await request(t.app)
      .post('/api/v1/auth/password/login')
      .set('Origin', TEST_ORIGIN)
      .send({ email: 'owner@codebegun.com', password: PASSWORD })
      .expect(404);
  });
});

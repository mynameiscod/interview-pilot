import { AuditLogModel, UserModel, UserProfileModel } from '@cbi/db';
import { AdminMeResponse, AuditLogPage, type AdminRole } from '@cbi/shared-types';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { buildTestApp, TEST_ORIGIN } from '../../test-support/harness.js';
import {
  refresh,
  signInWithEmail,
  useIntegrationServices,
} from '../../test-support/integration.js';

const { redis } = useIntegrationServices();
let t: Awaited<ReturnType<typeof buildTestApp>>;

beforeEach(async () => {
  t = await buildTestApp({ redis });
});

async function seedAdmin(email: string, roles: AdminRole[]) {
  const user = await UserModel.create({ primaryEmail: email, adminRoles: roles });
  await UserProfileModel.create({ userId: user._id });
  return String(user._id);
}

async function adminSession(email: string) {
  const session = await signInWithEmail(t.app, t.email.sent, email, 'admin');
  const as = (method: 'get' | 'post' | 'put', path: string) =>
    request(t.app)
      [method](`/api/v1/admin${path}`)
      .set('Origin', TEST_ORIGIN)
      .set('Authorization', `Bearer ${session.accessToken}`);
  return { ...session, as };
}

describe('admin sign-in', () => {
  it('gives non-admins an identical response but never sends or accepts a code', async () => {
    await signInWithEmail(t.app, t.email.sent, 'candidate@example.com'); // candidate account exists
    await redis.flushdb(); // the resend cooldown is per address across both apps
    const before = t.email.sent.length;
    const res = await request(t.app)
      .post('/api/v1/admin/auth/otp/request')
      .send({ channel: 'EMAIL', destination: 'candidate@example.com' })
      .expect(202);
    expect(Object.keys(res.body.data).sort()).toEqual(
      ['challengeId', 'expiresAt', 'resendAvailableAt', 'sentTo'].sort(),
    );
    expect(t.email.sent.length).toBe(before);
    for (const code of ['000000', '123456']) {
      const verify = await request(t.app)
        .post('/api/v1/admin/auth/otp/verify')
        .send({ challengeId: res.body.data.challengeId, code })
        .expect(400);
      expect(verify.body.error.code).toBe('OTP_INVALID');
    }
  });

  it('signs a seeded super admin in with a separately scoped cookie and returns permissions', async () => {
    await seedAdmin('root@codebegun.com', ['SUPER_ADMIN']);
    const { response, as } = await adminSession('root@codebegun.com');
    expect(response.headers['set-cookie']![0]).toMatch(
      /^cbi_admin_rt=.*Path=\/api\/v1\/admin\/auth/,
    );
    const me = AdminMeResponse.parse((await as('get', '/me').expect(200)).body.data);
    expect(me.adminRoles).toEqual(['SUPER_ADMIN']);
    expect(me.permissions).toContain('admin_users.manage');
    expect(me.email).toBe('root@codebegun.com');
  });

  it('admin tokens cannot be used on candidate endpoints and vice versa', async () => {
    await seedAdmin('root@codebegun.com', ['SUPER_ADMIN']);
    const { accessToken } = await adminSession('root@codebegun.com');
    await request(t.app)
      .get('/api/v1/users/me')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(401);
  });

  it('rotates admin refresh tokens independently of candidate sessions', async () => {
    await seedAdmin('root@codebegun.com', ['SUPER_ADMIN']);
    const { agent } = await adminSession('root@codebegun.com');
    await refresh(agent, 'admin').expect(200);
    await refresh(agent, 'candidate').expect(401);
  });
});

describe('admin user management', () => {
  it('lets a super admin invite an admin, who can then sign in', async () => {
    await seedAdmin('root@codebegun.com', ['SUPER_ADMIN']);
    const root = await adminSession('root@codebegun.com');
    const invited = await root
      .as('post', '/users')
      .send({ email: 'Ops@CodeBegun.com', roles: ['OPERATIONS_ADMIN'] })
      .expect(201);
    expect(invited.body.data).toMatchObject({
      inviteEmailSent: true,
      admin: { email: 'ops@codebegun.com', roles: ['OPERATIONS_ADMIN'], emailVerified: false },
    });
    expect(t.email.sent.at(-1)).toMatchObject({ to: 'ops@codebegun.com' });
    expect(await AuditLogModel.countDocuments({ action: 'admin.user_invited' })).toBe(1);

    const ops = await adminSession('ops@codebegun.com');
    const me = (await ops.as('get', '/me').expect(200)).body.data;
    expect(me.email).toBe('ops@codebegun.com');
    const list = (await root.as('get', '/users').expect(200)).body.data;
    expect(list.map((u: { email: string }) => u.email)).toEqual([
      'root@codebegun.com',
      'ops@codebegun.com',
    ]);
  });

  it('grants admin roles to an existing candidate account instead of creating a duplicate', async () => {
    const candidate = await signInWithEmail(t.app, t.email.sent, 'staff@codebegun.com');
    await seedAdmin('root@codebegun.com', ['SUPER_ADMIN']);
    const root = await adminSession('root@codebegun.com');
    const res = await root
      .as('post', '/users')
      .send({ email: 'staff@codebegun.com', roles: ['SUPPORT_ADMIN'] })
      .expect(201);
    expect(res.body.data.admin.id).toBe(candidate.user.id);
    await root
      .as('post', '/users')
      .send({ email: 'staff@codebegun.com', roles: ['SUPPORT_ADMIN'] })
      .expect(409);
  });

  it('enforces the permission matrix', async () => {
    await seedAdmin('root@codebegun.com', ['SUPER_ADMIN']);
    await seedAdmin('ops@codebegun.com', ['OPERATIONS_ADMIN']);
    await seedAdmin('content@codebegun.com', ['CONTENT_ADMIN']);
    const ops = await adminSession('ops@codebegun.com');
    const content = await adminSession('content@codebegun.com');

    await ops.as('get', '/users').expect(200);
    await ops.as('get', '/audit-logs').expect(200);
    const denied = await ops
      .as('post', '/users')
      .send({ email: 'x@codebegun.com', roles: ['SUPPORT_ADMIN'] })
      .expect(403);
    expect(denied.body.error.code).toBe('FORBIDDEN');
    await content.as('get', '/users').expect(403);
    await content.as('get', '/audit-logs').expect(403);
  });

  it('applies role changes to live sessions immediately and audits before/after', async () => {
    await seedAdmin('root@codebegun.com', ['SUPER_ADMIN']);
    const opsId = await seedAdmin('ops@codebegun.com', ['OPERATIONS_ADMIN']);
    const root = await adminSession('root@codebegun.com');
    const ops = await adminSession('ops@codebegun.com');
    await ops.as('get', '/audit-logs').expect(200);

    await root
      .as('put', `/users/${opsId}/roles`)
      .send({ roles: ['CONTENT_ADMIN'], reason: 'Moved to content team' })
      .expect(200);
    await ops.as('get', '/audit-logs').expect(403);

    const entry = await AuditLogModel.findOne({ action: 'admin.user_roles_changed' }).lean();
    expect(entry!.details).toEqual({
      before: ['OPERATIONS_ADMIN'],
      after: ['CONTENT_ADMIN'],
      reason: 'Moved to content team',
    });
  });

  it('revoking access ends admin sessions but keeps the person able to use the candidate app', async () => {
    await seedAdmin('root@codebegun.com', ['SUPER_ADMIN']);
    const opsId = await seedAdmin('ops@codebegun.com', ['OPERATIONS_ADMIN']);
    const root = await adminSession('root@codebegun.com');
    const ops = await adminSession('ops@codebegun.com');
    await root
      .as('post', `/users/${opsId}/revoke-access`)
      .send({ reason: 'Left the company' })
      .expect(204);
    await ops.as('get', '/me').expect(403);
    await refresh(ops.agent, 'admin').expect(401);
    await redis.flushdb();
    const candidate = await signInWithEmail(t.app, t.email.sent, 'ops@codebegun.com');
    expect(candidate.user.id).toBe(opsId);
  });

  it('prevents admins from demoting or revoking themselves', async () => {
    const rootId = await seedAdmin('root@codebegun.com', ['SUPER_ADMIN']);
    const secondId = await seedAdmin('second@codebegun.com', ['SUPER_ADMIN']);
    const root = await adminSession('root@codebegun.com');
    const self = await root
      .as('put', `/users/${rootId}/roles`)
      .send({ roles: ['OPERATIONS_ADMIN'], reason: 'test' })
      .expect(409);
    expect(self.body.error.message).toMatch(/own super admin/);
    const revoke = await root
      .as('post', `/users/${rootId}/revoke-access`)
      .send({ reason: 'test' })
      .expect(409);
    expect(revoke.body.error.message).toMatch(/own admin access/);
    // Demoting another super admin is fine while the actor remains one.
    await root
      .as('put', `/users/${secondId}/roles`)
      .send({ roles: ['FINANCE_ADMIN'], reason: 'Finance only' })
      .expect(200);
  });

  it('validates role payloads and unknown targets', async () => {
    await seedAdmin('root@codebegun.com', ['SUPER_ADMIN']);
    const root = await adminSession('root@codebegun.com');
    await root.as('post', '/users').send({ email: 'x@codebegun.com', roles: [] }).expect(400);
    await root
      .as('post', '/users')
      .send({ email: 'x@codebegun.com', roles: ['GOD'] })
      .expect(400);
    await root
      .as('put', '/users/000000000000000000000000/roles')
      .send({ roles: ['SUPPORT_ADMIN'], reason: 'test' })
      .expect(404);
    await root
      .as('put', '/users/not-an-id/roles')
      .send({ roles: ['SUPPORT_ADMIN'], reason: 'test' })
      .expect(404);
  });
});

describe('audit log', () => {
  it('is append-only at the model layer', async () => {
    await AuditLogModel.create({ actorType: 'SYSTEM', action: 'test', outcome: 'SUCCESS' });
    await expect(AuditLogModel.updateOne({}, { $set: { action: 'x' } })).rejects.toThrow(
      /append-only/,
    );
    await expect(AuditLogModel.deleteMany({})).rejects.toThrow(/append-only/);
  });

  it('pages newest-first with a cursor and filters by action', async () => {
    await seedAdmin('root@codebegun.com', ['SUPER_ADMIN']);
    const root = await adminSession('root@codebegun.com');
    const total = await AuditLogModel.countDocuments();
    const first = AuditLogPage.parse(
      (await root.as('get', '/audit-logs?limit=1').expect(200)).body.data,
    );
    expect(first.items).toHaveLength(1);
    expect(first.items[0]!.action).toBe('auth.login_succeeded');
    const second = AuditLogPage.parse(
      (await root.as('get', `/audit-logs?limit=100&before=${first.nextCursor}`).expect(200)).body
        .data,
    );
    expect(second.items).toHaveLength(total - 1);
    expect(second.nextCursor).toBeNull();
    const filtered = AuditLogPage.parse(
      (await root.as('get', '/audit-logs?action=auth.otp_requested').expect(200)).body.data,
    );
    expect(filtered.items.every((i) => i.action === 'auth.otp_requested')).toBe(true);
    // Audit entries never contain OTP codes or raw IPs.
    const raw = JSON.stringify(await AuditLogModel.find().lean());
    expect(raw).not.toMatch(/"ip":/);
    expect(raw).not.toMatch(/\b\d{6}\b(?![0-9a-f])/);
    await root.as('get', '/audit-logs?before=bogus').expect(400);
  });
});

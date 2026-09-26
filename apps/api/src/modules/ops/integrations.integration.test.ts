import { AuditLogModel, IntegrationConfigModel, UserModel, UserProfileModel } from '@cbi/db';
import { IntegrationSummary, type AdminRole } from '@cbi/shared-types';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { buildTestApp, TEST_ORIGIN } from '../../test-support/harness.js';
import { signInWithEmail, useIntegrationServices } from '../../test-support/integration.js';

const { redis } = useIntegrationServices();

let t: Awaited<ReturnType<typeof buildTestApp>>;

beforeEach(async () => {
  t = await buildTestApp({ redis });
});

type Method = 'get' | 'post' | 'put';

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

const BUNNY = {
  provider: 'bunny',
  settings: { zone: 'cbi-private', regionHost: 'sg.storage.bunnycdn.com' },
  secrets: { accessKey: 'bunny-storage-password-1234' },
  reason: 'production storage',
};

describe('integrations (admin-managed provider credentials)', () => {
  it('lets only super admins change them; operations can view', async () => {
    const ops = await adminAs(['OPERATIONS_ADMIN']);
    const finance = await adminAs(['FINANCE_ADMIN']);
    const list = (await ops('get', '/integrations').expect(200)).body.data as IntegrationSummary[];
    expect(list.map((i) => i.kind)).toEqual(['email', 'payments', 'storage', 'sms', 'judge']);
    // Test providers come from the environment (the harness), not the admin site.
    expect(list.find((i) => i.kind === 'storage')).toMatchObject({ source: 'env', ready: true });
    await ops('put', '/integrations/storage').send(BUNNY).expect(403);
    await ops('post', '/integrations/storage/test').send({}).expect(403);
    await finance('get', '/integrations').expect(403);
  });

  it('stores secrets encrypted, never returns them and switches the provider at runtime', async () => {
    const root = await adminAs(['SUPER_ADMIN']);
    expect(t.container.integrations.storage.name).not.toBe('bunny');

    const res = await root('put', '/integrations/storage').send(BUNNY).expect(200);
    const saved = IntegrationSummary.parse(res.body.data);
    expect(saved).toMatchObject({
      source: 'admin',
      provider: 'bunny',
      ready: true,
      settings: { zone: 'cbi-private', regionHost: 'sg.storage.bunnycdn.com' },
      secrets: { accessKey: { set: true, last4: '1234' } },
    });
    expect(JSON.stringify(res.body)).not.toContain('bunny-storage-password');
    // Encrypted at rest, and the audit entry names the field, never its value.
    const stored = await IntegrationConfigModel.findOne({ kind: 'storage' }).lean();
    expect(JSON.stringify(stored)).not.toContain('bunny-storage-password');
    expect(stored!.secrets.accessKey).toMatchObject({ keyId: expect.any(String), last4: '1234' });
    const audit = await AuditLogModel.findOne({ action: 'integration.updated' }).lean();
    expect(audit!.details).toMatchObject({ provider: 'bunny', secretsChanged: ['accessKey'] });
    expect(JSON.stringify(audit)).not.toContain('bunny-storage-password');
    // The running API now uses Bunny.
    expect(t.container.integrations.storage.name).toBe('bunny');

    // Leaving a secret out keeps it; null clears it (then it is not ready).
    await root('put', '/integrations/storage')
      .send({ ...BUNNY, secrets: {}, settings: { zone: 'cbi-private-2' }, reason: 'rename' })
      .expect(200)
      .expect((r) => expect(r.body.data.secrets.accessKey.set).toBe(true));
    const cleared = await root('put', '/integrations/storage')
      .send({ ...BUNNY, secrets: { accessKey: null }, reason: 'rotate' })
      .expect(200);
    expect(cleared.body.data).toMatchObject({ ready: false, missing: ['accessKey'] });
    await expect(t.container.integrations.storage.get('a/b.txt')).rejects.toThrow('not configured');

    // Reset: the environment file applies again.
    await root('post', '/integrations/storage/reset').send({ reason: 'use env' }).expect(200);
    expect(t.container.integrations.status('storage').source).toBe('env');
    expect(await IntegrationConfigModel.countDocuments({ kind: 'storage' })).toBe(0);
  });

  it('validates providers, settings and secret names', async () => {
    const root = await adminAs(['SUPER_ADMIN']);
    await root('put', '/integrations/storage')
      .send({ ...BUNNY, provider: 'dropbox' })
      .expect(400);
    await root('put', '/integrations/storage')
      .send({ ...BUNNY, secrets: { password: 'x' } })
      .expect(400);
    await root('put', '/integrations/judge')
      .send({ provider: 'judge0', settings: { baseUrl: 'ftp://judge' }, reason: 'judge' })
      .expect(400);
    await root('get', '/integrations/nope').expect(404);
  });

  it('turning email off makes email sign-in answer NOT_CONFIGURED', async () => {
    const root = await adminAs(['SUPER_ADMIN']);
    await root('put', '/integrations/email')
      .send({ provider: 'disabled', settings: {}, reason: 'maintenance' })
      .expect(200);
    const providers = await request(t.app)
      .get('/api/v1/auth/providers')
      .set('Origin', TEST_ORIGIN)
      .expect(200);
    expect(providers.body.data.email.enabled).toBe(false);
    const res = await request(t.app)
      .post('/api/v1/auth/otp/request')
      .set('Origin', TEST_ORIGIN)
      .send({ channel: 'EMAIL', destination: 'new@example.com' })
      .expect(503);
    expect(res.body.error.code).toBe('NOT_CONFIGURED');
  });

  it('tests a connection and records the result', async () => {
    const root = await adminAs(['SUPER_ADMIN']);
    const sentBefore = t.email.sent.length;
    const ok = await root('post', '/integrations/email/test')
      .send({ to: 'ops@codebegun.com' })
      .expect(200);
    expect(ok.body.data).toEqual({ ok: true, message: 'Test email sent to ops@codebegun.com.' });
    expect(t.email.sent.length).toBe(sentBefore + 1);
    await root('post', '/integrations/email/test').send({}).expect(400);

    const judge = await root('post', '/integrations/judge/test').send({}).expect(200);
    expect(judge.body.data.ok).toBe(true);

    await root('put', '/integrations/payments')
      .send({ provider: 'disabled', settings: {}, reason: 'off' })
      .expect(200);
    const off = await root('post', '/integrations/payments/test').send({}).expect(200);
    expect(off.body.data).toEqual({ ok: false, message: 'This integration is turned off.' });
    const rec = await IntegrationConfigModel.findOne({ kind: 'payments' }).lean();
    expect(rec!.lastTest).toMatchObject({ ok: false });
    expect(await AuditLogModel.countDocuments({ action: 'integration.tested' })).toBe(3);
  });
});

import { createAccessTokenIssuer } from '@cbi/auth-core';
import { createLogger } from '@cbi/config';
import type { AdminRole, MaintenanceSetting, SessionAudience } from '@cbi/shared-types';
import express, { type Express } from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import type { UserState } from '../modules/auth/user-state.js';
import { errorHandler } from './error-handler.js';
import { blockedDuringMaintenance, maintenanceGuard } from './maintenance.js';

const tokens = createAccessTokenIssuer({
  secret: 'maintenance-test-secret-0123456789abcdef',
  ttlSec: 600,
});
const logger = createLogger({ service: 'api-test', level: 'silent' });

function tinyApp(opts: {
  setting?: MaintenanceSetting | Error;
  users?: Record<string, UserState>;
}) {
  const maintenance = vi.fn(async () => {
    if (opts.setting instanceof Error) throw opts.setting;
    return opts.setting ?? { enabled: true, message: 'Back at 10 pm IST' };
  });
  const users = opts.users ?? {};
  const app: Express = express();
  app.use((req, _res, next) => {
    (req as unknown as { log: typeof logger }).log = logger;
    next();
  });
  const v1 = express.Router();
  v1.use(
    maintenanceGuard({
      maintenance,
      tokens,
      userState: { get: async (id) => users[id] ?? null, invalidate: async () => undefined },
    }),
  );
  v1.all('/{*rest}', (_req, res) => {
    res.json({ data: 'ok' });
  });
  app.use('/api/v1', v1);
  app.use(errorHandler);
  return { app, maintenance };
}

async function bearer(userId: string, audience: SessionAudience, roles: AdminRole[] = []) {
  const { token } = await tokens.sign({
    userId,
    audience,
    sessionId: 'sid-1',
    tokenVersion: 0,
    adminRoles: roles,
  });
  return `Bearer ${token}`;
}

const active = (adminRoles: AdminRole[] = [], tokenVersion = 0): UserState => ({
  status: 'ACTIVE',
  tokenVersion,
  adminRoles,
});

describe('which requests maintenance mode refuses', () => {
  it('refuses candidate writes and keeps reads open', () => {
    expect(blockedDuringMaintenance('POST', '/interviews')).toBe(true);
    expect(blockedDuringMaintenance('POST', '/interviews/abc/start')).toBe(true);
    expect(blockedDuringMaintenance('PATCH', '/users/me/profile')).toBe(true);
    expect(blockedDuringMaintenance('DELETE', '/resumes/abc')).toBe(true);
    expect(blockedDuringMaintenance('PUT', '/interviews/abc/setup')).toBe(true);
    expect(blockedDuringMaintenance('POST', '/payments/orders')).toBe(true);
    expect(blockedDuringMaintenance('POST', '/campaigns/tok/join')).toBe(true);
    expect(blockedDuringMaintenance('GET', '/reports/abc')).toBe(false);
    expect(blockedDuringMaintenance('HEAD', '/interviews')).toBe(false);
    expect(blockedDuringMaintenance('OPTIONS', '/interviews')).toBe(false);
  });

  it('keeps auth, admin, payment callbacks, analytics and running interviews open', () => {
    for (const path of [
      '/auth/otp/request',
      '/auth/otp/verify',
      '/auth/refresh',
      '/auth/logout',
      '/admin/settings/maintenance',
      '/admin/auth/otp/verify',
      '/payments/verify',
      '/payments/webhooks/razorpay',
      '/payments/mock/checkout',
      '/analytics/events',
      '/interviews/abc/end',
      '/interviews/abc/mode',
      '/interviews/abc/voice/transcribe',
      '/interviews/abc/coding/q1/submit',
      '/interviews/abc/media/segments/3',
      '/interviews/abc/media/finalize',
    ]) {
      expect(blockedDuringMaintenance('POST', path), path).toBe(false);
    }
    // Look-alikes are not exempt.
    expect(blockedDuringMaintenance('POST', '/administrators')).toBe(true);
    expect(blockedDuringMaintenance('POST', '/payments/verify/extra')).toBe(true);
    expect(blockedDuringMaintenance('POST', '/interviews/abc/start')).toBe(true);
  });
});

describe('maintenanceGuard', () => {
  it('answers 503 MAINTENANCE with the notice and a Retry-After', async () => {
    const { app } = tinyApp({ users: { cand1: active() } });
    const res = await request(app)
      .post('/api/v1/interviews')
      .set('Authorization', await bearer('cand1', 'candidate'))
      .send({})
      .expect(503);
    expect(res.headers['retry-after']).toBe('120');
    expect(res.body.error).toMatchObject({
      code: 'MAINTENANCE',
      message: 'Back at 10 pm IST',
      details: { maintenance: { enabled: true, message: 'Back at 10 pm IST' } },
    });
  });

  it('uses a default message when the notice is empty', async () => {
    const { app } = tinyApp({ setting: { enabled: true, message: '' } });
    const res = await request(app)
      .delete('/api/v1/resumes/abc')
      .set('Authorization', await bearer('cand1', 'candidate'))
      .expect(503);
    expect(res.body.error.message).toMatch(/maintenance/i);
  });

  it('lets everything through when maintenance is off, without reading it for reads', async () => {
    const { app, maintenance } = tinyApp({ setting: { enabled: false, message: '' } });
    await request(app)
      .post('/api/v1/interviews')
      .set('Authorization', await bearer('cand1', 'candidate'))
      .send({})
      .expect(200);
    await request(app).get('/api/v1/reports/abc').expect(200);
    await request(app).post('/api/v1/auth/otp/request').send({}).expect(200);
    expect(maintenance).toHaveBeenCalledTimes(1);
  });

  it('keeps reads and exempt writes open during maintenance', async () => {
    const { app, maintenance } = tinyApp({});
    await request(app).get('/api/v1/reports/abc').expect(200);
    await request(app).post('/api/v1/auth/otp/verify').send({}).expect(200);
    await request(app).post('/api/v1/payments/webhooks/razorpay').send({}).expect(200);
    await request(app).put('/api/v1/admin/flags/x').send({}).expect(200);
    expect(maintenance).not.toHaveBeenCalled();
  });

  it('lets admins through on candidate routes, with either token audience', async () => {
    const { app } = tinyApp({
      users: {
        admin1: active(['SUPER_ADMIN']),
        cand1: active([]),
        old: active(['SUPER_ADMIN'], 3),
      },
    });
    await request(app)
      .post('/api/v1/interviews')
      .set('Authorization', await bearer('admin1', 'candidate'))
      .send({})
      .expect(200);
    await request(app)
      .post('/api/v1/interviews')
      .set('Authorization', await bearer('admin1', 'admin', ['SUPER_ADMIN']))
      .send({})
      .expect(200);
    // Candidates, revoked tokens and garbage tokens are refused.
    await request(app)
      .post('/api/v1/interviews')
      .set('Authorization', await bearer('cand1', 'candidate'))
      .send({})
      .expect(503);
    await request(app)
      .post('/api/v1/interviews')
      .set('Authorization', await bearer('old', 'candidate'))
      .send({})
      .expect(503);
    await request(app)
      .post('/api/v1/interviews')
      .set('Authorization', 'Bearer not-a-token')
      .send({})
      .expect(503);
  });

  it('fails open when the setting cannot be read', async () => {
    const { app } = tinyApp({ setting: new Error('mongo down') });
    await request(app)
      .post('/api/v1/interviews')
      .set('Authorization', await bearer('cand1', 'candidate'))
      .send({})
      .expect(200);
  });

  it('leaves unauthenticated writes to the route (401) without reading the setting', async () => {
    const { app, maintenance } = tinyApp({});
    await request(app).post('/api/v1/interviews').send({}).expect(200);
    expect(maintenance).not.toHaveBeenCalled();
  });
});

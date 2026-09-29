import { CSRF_HEADER } from '@cbi/shared-types';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { sessionKey } from '../../middleware/rate-limit.js';
import { buildTestApp, TEST_ORIGIN } from '../../test-support/harness.js';
import { cancelPendingDeletion } from './account.service.js';
import { actorTypeFor } from './auth.routes.js';
import { mfaRequiredFor } from './mfa.service.js';
import { refreshExpiry } from './session.service.js';

const DAY = 24 * 3600 * 1000;

describe('absolute session lifetime', () => {
  const signIn = new Date('2026-01-01T00:00:00Z');

  it('slides the refresh expiry while the session is young', () => {
    const now = new Date(signIn.getTime() + 10 * DAY);
    expect(refreshExpiry(now, 30 * DAY, signIn, 90 * DAY)).toEqual(
      new Date(now.getTime() + 30 * DAY),
    );
  });

  it('never extends past the cap measured from sign-in, however often it refreshes', () => {
    const now = new Date(signIn.getTime() + 80 * DAY);
    expect(refreshExpiry(now, 30 * DAY, signIn, 90 * DAY)).toEqual(
      new Date(signIn.getTime() + 90 * DAY),
    );
  });
});

describe('audit actor for sign-out', () => {
  it('records admin sign-outs as ADMIN and candidate ones as USER', () => {
    expect(actorTypeFor('admin')).toBe('ADMIN');
    expect(actorTypeFor('candidate')).toBe('USER');
  });
});

describe('admin 2FA policy', () => {
  it('requires 2FA for super admins by default and for everyone with "all"', () => {
    expect(mfaRequiredFor(['SUPER_ADMIN'], 'super_admin')).toBe(true);
    expect(mfaRequiredFor(['SUPPORT_ADMIN'], 'super_admin')).toBe(false);
    expect(mfaRequiredFor(['SUPPORT_ADMIN', 'SUPER_ADMIN'], 'super_admin')).toBe(true);
    expect(mfaRequiredFor(['SUPPORT_ADMIN'], 'all')).toBe(true);
    expect(mfaRequiredFor([], 'all')).toBe(false);
  });
});

describe('cancelling a deletion by signing in', () => {
  const pending = (daysLeft: number) => ({
    status: 'DELETION_PENDING' as const,
    deletion: {
      requestedAt: new Date(),
      scheduledFor: new Date(Date.now() + daysLeft * DAY),
      method: 'TYPED' as const,
      completedAt: null,
    },
  });

  it('restores the account inside the grace period (candidate app only)', () => {
    const user = pending(3);
    expect(cancelPendingDeletion(user as never, 'candidate')).toBe(true);
    expect(user.status).toBe('ACTIVE');
    expect(user.deletion).toBeUndefined();
    expect(cancelPendingDeletion(pending(3) as never, 'admin')).toBe(false);
  });

  it('does nothing once the grace period has ended or for other states', () => {
    expect(cancelPendingDeletion(pending(-1) as never, 'candidate')).toBe(false);
    expect(
      cancelPendingDeletion({ status: 'SUSPENDED', deletion: undefined } as never, 'candidate'),
    ).toBe(false);
  });
});

describe('refresh rate limits', () => {
  it('keys per session when a cookie is present, else per IP', () => {
    expect(sessionKey('cbi_rt=abc', '10.0.0.1')).toMatch(/^session:[0-9a-f]{32}$/);
    expect(sessionKey('cbi_rt=abc', '10.0.0.1')).toBe(sessionKey('cbi_rt=abc', '10.0.0.2'));
    expect(sessionKey('cbi_rt=abc', '1.1.1.1')).not.toBe(sessionKey('cbi_rt=xyz', '1.1.1.1'));
    expect(sessionKey(undefined, '10.0.0.1')).not.toMatch(/^session:/);
  });

  it('lets many sessions behind one IP refresh without using up the sign-in limit', async () => {
    const { app } = await buildTestApp();
    // 40 different devices behind one campus NAT (more than the old shared limit of 30).
    for (let i = 0; i < 40; i++) {
      const res = await request(app)
        .post('/api/v1/auth/refresh')
        .set('Origin', TEST_ORIGIN)
        .set(CSRF_HEADER, '1')
        .set('Cookie', `device=${i}`);
      expect(res.status).toBe(401);
    }
    // Google sign-in has its own counter and is not rate limited by the refreshes.
    const google = await request(app)
      .post('/api/v1/auth/google')
      .set('Origin', TEST_ORIGIN)
      .send({});
    expect(google.status).not.toBe(429);
  });

  it('limits one session that refreshes in a loop', async () => {
    const { app } = await buildTestApp();
    const statuses: number[] = [];
    for (let i = 0; i < 21; i++) {
      const res = await request(app)
        .post('/api/v1/auth/refresh')
        .set('Origin', TEST_ORIGIN)
        .set(CSRF_HEADER, '1')
        .set('Cookie', 'device=same');
      statuses.push(res.status);
    }
    expect(statuses.slice(0, 20).every((s) => s === 401)).toBe(true);
    expect(statuses[20]).toBe(429);
  });
});

describe('new endpoints require sign-in', () => {
  it.each([
    ['get', '/api/v1/auth/sessions'],
    ['delete', '/api/v1/auth/sessions/00000000-0000-0000-0000-000000000000'],
    ['get', '/api/v1/admin/auth/mfa'],
    ['post', '/api/v1/admin/auth/mfa/enroll'],
    ['get', '/api/v1/users/me/export'],
    ['delete', '/api/v1/users/me'],
    ['post', '/api/v1/users/me/reauth/otp'],
    ['get', '/api/v1/admin/candidates'],
    ['post', '/api/v1/admin/candidates/abc/suspend'],
    ['delete', '/api/v1/jobs/abc'],
  ] as const)('%s %s → 401', async (method, path) => {
    const { app } = await buildTestApp();
    const res = await request(app)[method](path).set('Origin', TEST_ORIGIN);
    expect(res.status).toBe(401);
  });

  it('validates the second sign-in step before touching any state', async () => {
    const { app } = await buildTestApp();
    const res = await request(app)
      .post('/api/v1/admin/auth/mfa/verify')
      .set('Origin', TEST_ORIGIN)
      .send({ mfaToken: 'short' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
  });
});

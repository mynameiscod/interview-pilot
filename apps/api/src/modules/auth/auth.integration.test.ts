import {
  AuditLogModel,
  AuthIdentityModel,
  OtpChallengeModel,
  RefreshTokenModel,
  UserModel,
} from '@cbi/db';
import { CSRF_HEADER, SessionResponse } from '@cbi/shared-types';
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

const post = (path: string) => request(t.app).post(`/api/v1${path}`).set('Origin', TEST_ORIGIN);

async function requestEmailOtp(email: string) {
  const res = await post('/auth/otp/request').send({ channel: 'EMAIL', destination: email });
  return { res, code: () => extractCode(t.email.sent.at(-1)!.text) };
}

describe('email OTP sign-in', () => {
  it('creates an account on first sign-in and returns a session with an httpOnly refresh cookie', async () => {
    const { response, user } = await signInWithEmail(t.app, t.email.sent, 'Asha.K@Example.com');
    SessionResponse.parse(response.body.data);
    expect(user.email).toBe('asha.k@example.com');
    expect(user.onboardingCompleted).toBe(false);
    expect(user.identities).toEqual([
      expect.objectContaining({ provider: 'EMAIL', display: 'a***k@example.com' }),
    ]);
    const cookie = response.headers['set-cookie']![0]!;
    expect(cookie).toMatch(/^cbi_rt=/);
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/Path=\/api\/v1\/auth/);
    expect(cookie).toMatch(/SameSite=Lax/);
    expect(response.headers['cache-control']).toBe('no-store');
  });

  it('signs the same person into the same account next time (no duplicates)', async () => {
    const first = await signInWithEmail(t.app, t.email.sent, 'ravi@example.com');
    await redis.flushdb(); // clear resend cooldown
    const second = await signInWithEmail(t.app, t.email.sent, 'RAVI@example.com');
    expect(second.user.id).toBe(first.user.id);
    expect(await UserModel.countDocuments()).toBe(1);
    expect(await AuditLogModel.countDocuments({ action: 'auth.account_created' })).toBe(1);
    expect(await AuditLogModel.countDocuments({ action: 'auth.login_succeeded' })).toBe(1);
  });

  it('never stores the code in clear and masks the destination in the response', async () => {
    const { res, code } = await requestEmailOtp('meera@example.com');
    expect(res.status).toBe(202);
    expect(res.body.data.sentTo).toBe('m***a@example.com');
    const challenge = await OtpChallengeModel.findById(res.body.data.challengeId).lean();
    expect(challenge!.codeHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(challenge)).not.toContain(code());
  });

  it('rejects wrong codes, reports remaining attempts, and locks after the maximum', async () => {
    const { res, code } = await requestEmailOtp('lock@example.com');
    const challengeId = res.body.data.challengeId;
    const wrong = code() === '000000' ? '111111' : '000000';
    const first = await post('/auth/otp/verify').send({ challengeId, code: wrong }).expect(400);
    expect(first.body.error).toMatchObject({
      code: 'OTP_INVALID',
      details: { remainingAttempts: 4 },
    });
    for (let i = 0; i < 4; i++) {
      await post('/auth/otp/verify').send({ challengeId, code: wrong }).expect(400);
    }
    const locked = await post('/auth/otp/verify').send({ challengeId, code: code() }).expect(429);
    expect(locked.body.error.code).toBe('OTP_TOO_MANY_ATTEMPTS');
    expect(await AuditLogModel.countDocuments({ action: 'auth.otp_verify_failed' })).toBe(6);
  });

  it('does not accept a code twice', async () => {
    const { res, code } = await requestEmailOtp('once@example.com');
    const body = { challengeId: res.body.data.challengeId, code: code() };
    await post('/auth/otp/verify').send(body).expect(200);
    const again = await post('/auth/otp/verify').send(body).expect(400);
    expect(again.body.error.code).toBe('OTP_INVALID');
  });

  it('rejects expired codes', async () => {
    const { res, code } = await requestEmailOtp('late@example.com');
    await OtpChallengeModel.updateOne(
      { _id: res.body.data.challengeId },
      { $set: { expiresAt: new Date(Date.now() - 1000) } },
    );
    const late = await post('/auth/otp/verify')
      .send({ challengeId: res.body.data.challengeId, code: code() })
      .expect(400);
    expect(late.body.error.code).toBe('OTP_EXPIRED');
  });

  it('enforces a resend cooldown per destination', async () => {
    await requestEmailOtp('wait@example.com');
    const { res } = await requestEmailOtp('WAIT@example.com');
    expect(res.status).toBe(429);
    expect(res.body.error.code).toBe('OTP_COOLDOWN');
    expect(res.body.error.details.retryAfterSec).toBeGreaterThan(0);
    expect(t.email.sent).toHaveLength(1);
  });

  it('reports delivery failure honestly and lets the person retry immediately', async () => {
    t.email.failNextSend();
    const { res } = await requestEmailOtp('down@example.com');
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('PROVIDER_UNAVAILABLE');
    const retry = await requestEmailOtp('down@example.com');
    expect(retry.res.status).toBe(202);
  });

  it('validates the destination', async () => {
    const res = await post('/auth/otp/request').send({ channel: 'EMAIL', destination: 'nope' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
  });
});

describe('mobile OTP sign-in', () => {
  it('normalizes Indian numbers to E.164 and signs in', async () => {
    const requested = await post('/auth/otp/request')
      .send({ channel: 'MOBILE', destination: '98765 43210' })
      .expect(202);
    expect(requested.body.data.sentTo).toBe('+91 ******3210');
    expect(t.sms.sent[0]!.to).toBe('+919876543210');
    const verified = await post('/auth/otp/verify')
      .send({ challengeId: requested.body.data.challengeId, code: t.sms.sent[0]!.code })
      .expect(200);
    expect(verified.body.data.user.mobile).toBe('+919876543210');
    expect(verified.body.data.user.email).toBeNull();
  });

  it('reports mobile sign-in as unavailable when SMS is disabled', async () => {
    const disabled = await buildTestApp({ redis, env: { SMS_PROVIDER: 'disabled' } });
    const res = await request(disabled.app)
      .post('/api/v1/auth/otp/request')
      .send({ channel: 'MOBILE', destination: '9876543210' });
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('FEATURE_DISABLED');
    const providers = await request(disabled.app).get('/api/v1/auth/providers').expect(200);
    expect(providers.body.data.mobile.enabled).toBe(false);
  });
});

describe('sessions', () => {
  it('requires the CSRF header to refresh', async () => {
    const { agent } = await signInWithEmail(t.app, t.email.sent, 'csrf@example.com');
    const res = await agent.post('/api/v1/auth/refresh').set('Origin', TEST_ORIGIN).expect(403);
    expect(res.body.error.code).toBe('CSRF_REJECTED');
  });

  it('rotates the refresh token on every refresh', async () => {
    const { agent, response } = await signInWithEmail(t.app, t.email.sent, 'rotate@example.com');
    const first = response.headers['set-cookie']![0]!.split(';')[0];
    const refreshed = await refresh(agent).expect(200);
    SessionResponse.parse(refreshed.body.data);
    const second = refreshed.headers['set-cookie']![0]!.split(';')[0];
    expect(second).not.toBe(first);
    expect(await RefreshTokenModel.countDocuments({ usedAt: { $exists: true } })).toBe(1);
  });

  it('treats reuse of an old refresh token as theft and ends the whole session family', async () => {
    const { agent, response } = await signInWithEmail(t.app, t.email.sent, 'theft@example.com');
    const stolen = response.headers['set-cookie']![0]!.split(';')[0]!;
    await refresh(agent).expect(200); // legitimate rotation
    // Move the rotation outside the grace window.
    await RefreshTokenModel.updateMany(
      { usedAt: { $exists: true } },
      { $set: { usedAt: new Date(Date.now() - 60_000) } },
    );

    const attacker = await request(t.app)
      .post('/api/v1/auth/refresh')
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, '1')
      .set('Cookie', stolen)
      .expect(401);
    expect(attacker.body.error.code).toBe('UNAUTHENTICATED');
    // The legitimate holder's newer token is revoked too.
    await refresh(agent).expect(401);
    expect(
      await AuditLogModel.countDocuments({ action: 'auth.refresh_token_reuse_detected' }),
    ).toBe(1);
  });

  it('tolerates a duplicate refresh inside the grace window without killing the session', async () => {
    const { agent, response } = await signInWithEmail(t.app, t.email.sent, 'tabs@example.com');
    const original = response.headers['set-cookie']![0]!.split(';')[0]!;
    await refresh(agent).expect(200);
    await request(t.app)
      .post('/api/v1/auth/refresh')
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, '1')
      .set('Cookie', original)
      .expect(401);
    await refresh(agent).expect(200);
  });

  it('logout ends this session only', async () => {
    const phone = await signInWithEmail(t.app, t.email.sent, 'two@example.com');
    await redis.flushdb();
    const laptop = await signInWithEmail(t.app, t.email.sent, 'two@example.com');
    await phone.agent
      .post('/api/v1/auth/logout')
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, '1')
      .expect(204);
    await refresh(phone.agent).expect(401);
    await refresh(laptop.agent).expect(200);
  });

  it('logout-all ends every session and invalidates live access tokens', async () => {
    const phone = await signInWithEmail(t.app, t.email.sent, 'all@example.com');
    await redis.flushdb();
    const laptop = await signInWithEmail(t.app, t.email.sent, 'all@example.com');
    await request(t.app)
      .get('/api/v1/users/me')
      .set('Authorization', `Bearer ${phone.accessToken}`)
      .expect(200);
    await laptop.agent
      .post('/api/v1/auth/logout-all')
      .set('Origin', TEST_ORIGIN)
      .set(CSRF_HEADER, '1')
      .set('Authorization', `Bearer ${laptop.accessToken}`)
      .expect(204);
    await request(t.app)
      .get('/api/v1/users/me')
      .set('Authorization', `Bearer ${phone.accessToken}`)
      .expect(401);
    await refresh(phone.agent).expect(401);
    await refresh(laptop.agent).expect(401);
  });

  it('rejects missing, malformed and cross-audience tokens', async () => {
    await request(t.app).get('/api/v1/users/me').expect(401);
    await request(t.app)
      .get('/api/v1/users/me')
      .set('Authorization', 'Bearer nonsense')
      .expect(401);
    const { accessToken } = await signInWithEmail(t.app, t.email.sent, 'cand@example.com');
    const res = await request(t.app)
      .get('/api/v1/admin/me')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(401);
    expect(res.body.error.code).toBe('UNAUTHENTICATED');
  });

  it('blocks suspended accounts immediately', async () => {
    const { accessToken, user, agent } = await signInWithEmail(
      t.app,
      t.email.sent,
      'sus@example.com',
    );
    await UserModel.updateOne({ _id: user.id }, { $set: { status: 'SUSPENDED' } });
    await t.container.userState.invalidate(user.id);
    const res = await request(t.app)
      .get('/api/v1/users/me')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(403);
    expect(res.body.error.code).toBe('ACCOUNT_SUSPENDED');
    await refresh(agent).expect(403);
  });
});

describe('Google sign-in', () => {
  it('creates an account with Google and EMAIL identities', async () => {
    const idToken = await t.google.sign({ sub: 'g-1', email: 'Priya@Gmail.com', name: 'Priya S' });
    const res = await post('/auth/google').send({ idToken }).expect(200);
    expect(res.body.data.user.email).toBe('priya@gmail.com');
    expect(res.body.data.user.profile.displayName).toBe('Priya S');
    expect(
      res.body.data.user.identities.map((i: { provider: string }) => i.provider).sort(),
    ).toEqual(['EMAIL', 'GOOGLE']);
  });

  it('links Google to an existing email account instead of creating a duplicate', async () => {
    const { user } = await signInWithEmail(t.app, t.email.sent, 'kiran@gmail.com');
    const idToken = await t.google.sign({ sub: 'g-2', email: 'kiran@gmail.com' });
    const res = await post('/auth/google').send({ idToken }).expect(200);
    expect(res.body.data.user.id).toBe(user.id);
    expect(await UserModel.countDocuments()).toBe(1);
  });

  it('rejects tokens for another client id and unverified emails', async () => {
    const wrongAud = await t.google.sign(
      { sub: 'g-3', email: 'x@gmail.com' },
      { audience: 'other' },
    );
    await post('/auth/google').send({ idToken: wrongAud }).expect(401);
    const unverified = await t.google.sign({
      sub: 'g-4',
      email: 'y@gmail.com',
      email_verified: false,
    });
    await post('/auth/google').send({ idToken: unverified }).expect(401);
    expect(await UserModel.countDocuments()).toBe(0);
  });

  it('is reported as disabled when no client id is configured', async () => {
    const noGoogle = await buildTestApp({ redis, env: { GOOGLE_CLIENT_ID: '' } });
    const providers = await request(noGoogle.app).get('/api/v1/auth/providers').expect(200);
    expect(providers.body.data.google.enabled).toBe(false);
  });
});

describe('account linking', () => {
  it('adds a verified mobile number to the signed-in account', async () => {
    const { accessToken, user } = await signInWithEmail(t.app, t.email.sent, 'link@example.com');
    const auth = { Authorization: `Bearer ${accessToken}` };
    const requested = await post('/auth/link/otp/request')
      .set(auth)
      .send({ channel: 'MOBILE', destination: '+91 99887 76655' })
      .expect(202);
    const res = await post('/auth/link/otp/verify')
      .set(auth)
      .send({ challengeId: requested.body.data.challengeId, code: t.sms.sent.at(-1)!.code })
      .expect(200);
    expect(res.body.data.id).toBe(user.id);
    expect(res.body.data.mobile).toBe('+919988776655');
    expect(await AuthIdentityModel.countDocuments({ userId: user.id })).toBe(2);
  });

  it('refuses to link an identity that belongs to someone else', async () => {
    await signInWithEmail(t.app, t.email.sent, 'owner@example.com');
    const other = await signInWithEmail(t.app, t.email.sent, 'other@example.com');
    await redis.flushdb(); // owner@ just received a code; skip its resend cooldown
    const auth = { Authorization: `Bearer ${other.accessToken}` };
    const requested = await post('/auth/link/otp/request')
      .set(auth)
      .send({ channel: 'EMAIL', destination: 'owner@example.com' })
      .expect(202);
    const res = await post('/auth/link/otp/verify')
      .set(auth)
      .send({
        challengeId: requested.body.data.challengeId,
        code: extractCode(t.email.sent.at(-1)!.text),
      })
      .expect(409);
    expect(res.body.error.code).toBe('IDENTITY_IN_USE');
  });

  it('will not verify a link challenge for a different user', async () => {
    const a = await signInWithEmail(t.app, t.email.sent, 'a@example.com');
    const b = await signInWithEmail(t.app, t.email.sent, 'b@example.com');
    const requested = await post('/auth/link/otp/request')
      .set({ Authorization: `Bearer ${a.accessToken}` })
      .send({ channel: 'EMAIL', destination: 'a2@example.com' })
      .expect(202);
    await post('/auth/link/otp/verify')
      .set({ Authorization: `Bearer ${b.accessToken}` })
      .send({
        challengeId: requested.body.data.challengeId,
        code: extractCode(t.email.sent.at(-1)!.text),
      })
      .expect(400);
  });
});

describe('onboarding profile', () => {
  it('saves the profile and marks onboarding complete', async () => {
    const { accessToken } = await signInWithEmail(t.app, t.email.sent, 'new@example.com');
    const auth = { Authorization: `Bearer ${accessToken}` };
    const res = await request(t.app)
      .patch('/api/v1/users/me/profile')
      .set('Origin', TEST_ORIGIN)
      .set(auth)
      .send({
        displayName: '  Anil Kumar ',
        preferredInterviewLanguage: 'te',
        experienceLevel: 'FRESHER',
        currentRole: 'Student',
        productUpdatesOptIn: true,
      })
      .expect(200);
    expect(res.body.data.onboardingCompleted).toBe(true);
    expect(res.body.data.profile).toEqual({
      displayName: 'Anil Kumar',
      preferredInterviewLanguage: 'te',
      experienceLevel: 'FRESHER',
      currentRole: 'Student',
      productUpdatesOptIn: true,
    });
    const cleared = await request(t.app)
      .patch('/api/v1/users/me/profile')
      .set(auth)
      .send({ displayName: 'Anil', preferredInterviewLanguage: 'auto', experienceLevel: null })
      .expect(200);
    expect(cleared.body.data.profile.experienceLevel).toBeNull();
    expect(cleared.body.data.profile.currentRole).toBe('Student');
  });

  it('validates input', async () => {
    const { accessToken } = await signInWithEmail(t.app, t.email.sent, 'bad@example.com');
    const res = await request(t.app)
      .patch('/api/v1/users/me/profile')
      .set({ Authorization: `Bearer ${accessToken}` })
      .send({ displayName: ' ', preferredInterviewLanguage: 'klingon' })
      .expect(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
  });
});

describe('rate limiting', () => {
  it('limits OTP requests per IP with Redis-backed counters', async () => {
    const limited = await buildTestApp({ redis, rateLimitRedis: redis });
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) {
      const res = await request(limited.app)
        .post('/api/v1/auth/otp/request')
        .send({ channel: 'EMAIL', destination: `user${i}@example.com` });
      statuses.push(res.status);
    }
    expect(statuses.slice(0, 10).every((s) => s === 202)).toBe(true);
    expect(statuses[10]).toBe(429);
  });
});

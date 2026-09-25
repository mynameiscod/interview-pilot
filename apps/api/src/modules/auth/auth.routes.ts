import {
  GoogleLoginBody,
  OtpRequestBody,
  OtpVerifyBody,
  type AdminRole,
  type AuthProvidersResponse,
  type SessionAudience,
  type SessionResponse,
} from '@cbi/shared-types';
import { Router, type Request, type Response } from 'express';
import type { Container } from '../../container.js';
import { AppError } from '../../lib/errors.js';
import { clientContext } from '../../lib/request-context.js';
import { authenticate, requireAuth, requireCsrfHeader } from '../../middleware/authenticate.js';
import type { UserDocument } from '@cbi/db';
import { clearRefreshCookie, readRefreshCookie, setRefreshCookie } from './cookies.js';

/**
 * Sign-in endpoints. Mounted twice: `/auth` (candidate app) and `/admin/auth`
 * (admin app). The audience keeps the two sessions, cookies and tokens apart.
 */
export function authRouter(audience: SessionAudience, c: Container): Router {
  const router = Router();
  const { limiters } = c;
  const signedIn = authenticate(audience, c);

  async function respondWithSession(
    req: Request,
    res: Response,
    user: UserDocument,
    method: string,
    created: boolean,
  ) {
    const ctx = clientContext(req);
    const session = await c.sessions.issue(
      {
        id: String(user._id),
        tokenVersion: user.tokenVersion,
        adminRoles: user.adminRoles as AdminRole[],
      },
      audience,
      ctx,
    );
    setRefreshCookie(res, audience, c.cookies, session.refreshToken, session.refreshTokenExpiresAt);
    await c.audit.record(
      {
        actorType: audience === 'admin' ? 'ADMIN' : 'USER',
        actorId: String(user._id),
        action: created ? 'auth.account_created' : 'auth.login_succeeded',
        details: { audience, method },
      },
      ctx,
    );
    const body: { data: SessionResponse } = {
      data: {
        accessToken: session.accessToken,
        accessTokenExpiresAt: session.accessTokenExpiresAt.toISOString(),
        user: await c.accounts.loadMe(String(user._id)),
      },
    };
    res.set('Cache-Control', 'no-store').json(body);
  }

  router.get('/providers', (_req, res) => {
    const body: { data: AuthProvidersResponse } = {
      data: {
        google: { enabled: c.google !== null },
        email: { enabled: c.integrations.ready('email') },
        mobile: { enabled: c.integrations.ready('sms') },
      },
    };
    res.json(body);
  });

  router.post('/otp/request', limiters.otpRequest, async (req, res) => {
    const body = OtpRequestBody.parse(req.body);
    const result = await c.otp.request({
      audience,
      purpose: 'LOGIN',
      channel: body.channel,
      rawDestination: body.destination,
      ctx: clientContext(req),
    });
    res.status(202).json({ data: result });
  });

  router.post('/otp/verify', limiters.otpVerify, async (req, res) => {
    const body = OtpVerifyBody.parse(req.body);
    const verified = await c.otp.verify({
      audience,
      purpose: 'LOGIN',
      challengeId: body.challengeId,
      code: body.code,
      ctx: clientContext(req),
    });
    const { user, created } = await c.accounts.loginWithVerifiedContact(
      verified.channel,
      verified.destination,
      audience,
    );
    await respondWithSession(req, res, user, `otp_${verified.channel.toLowerCase()}`, created);
  });

  router.post('/google', limiters.auth, async (req, res) => {
    if (!c.google) throw new AppError(503, 'FEATURE_DISABLED', 'Google sign-in is not available.');
    const body = GoogleLoginBody.parse(req.body);
    const claims = await c.google(body.idToken);
    const { user, created } = await c.accounts.loginWithGoogle(claims, audience);
    await respondWithSession(req, res, user, 'google', created);
  });

  router.post('/refresh', limiters.auth, requireCsrfHeader, async (req, res) => {
    const raw = readRefreshCookie(req, audience, c.cookies);
    if (!raw) throw AppError.unauthenticated('No active session.');
    try {
      const session = await c.sessions.rotate(raw, audience, clientContext(req));
      setRefreshCookie(
        res,
        audience,
        c.cookies,
        session.refreshToken,
        session.refreshTokenExpiresAt,
      );
      const body: { data: SessionResponse } = {
        data: {
          accessToken: session.accessToken,
          accessTokenExpiresAt: session.accessTokenExpiresAt.toISOString(),
          user: await c.accounts.loadMe(session.userId),
        },
      };
      res.set('Cache-Control', 'no-store').json(body);
    } catch (err) {
      clearRefreshCookie(res, audience, c.cookies);
      throw err;
    }
  });

  router.post('/logout', requireCsrfHeader, async (req, res) => {
    const raw = readRefreshCookie(req, audience, c.cookies);
    if (raw) {
      const userId = await c.sessions.revokeByToken(raw, audience);
      if (userId) {
        await c.audit.record(
          { actorType: 'USER', actorId: userId, action: 'auth.logout', details: { audience } },
          clientContext(req),
        );
      }
    }
    clearRefreshCookie(res, audience, c.cookies);
    res.status(204).end();
  });

  router.post('/logout-all', signedIn, requireCsrfHeader, async (req, res) => {
    const auth = requireAuth(req);
    await c.sessions.revokeAll(auth.userId, 'LOGOUT_ALL');
    await c.audit.record(
      { actorType: 'USER', actorId: auth.userId, action: 'auth.logout_all', details: { audience } },
      clientContext(req),
    );
    clearRefreshCookie(res, audience, c.cookies);
    res.status(204).end();
  });

  if (audience === 'candidate') {
    // Account linking: add another verified way to sign in to the current account.
    router.post('/link/otp/request', signedIn, limiters.otpRequest, async (req, res) => {
      const body = OtpRequestBody.parse(req.body);
      const result = await c.otp.request({
        audience,
        purpose: 'LINK',
        channel: body.channel,
        rawDestination: body.destination,
        userId: requireAuth(req).userId,
        ctx: clientContext(req),
      });
      res.status(202).json({ data: result });
    });

    router.post('/link/otp/verify', signedIn, limiters.otpVerify, async (req, res) => {
      const { userId } = requireAuth(req);
      const body = OtpVerifyBody.parse(req.body);
      const verified = await c.otp.verify({
        audience,
        purpose: 'LINK',
        challengeId: body.challengeId,
        code: body.code,
        userId,
        ctx: clientContext(req),
      });
      await c.accounts.linkIdentity(userId, verified.channel, verified.destination);
      await c.audit.record(
        {
          actorType: 'USER',
          actorId: userId,
          action: 'auth.identity_linked',
          details: { provider: verified.channel },
        },
        clientContext(req),
      );
      res.json({ data: await c.accounts.loadMe(userId) });
    });

    router.post('/link/google', signedIn, limiters.auth, async (req, res) => {
      if (!c.google)
        throw new AppError(503, 'FEATURE_DISABLED', 'Google sign-in is not available.');
      const { userId } = requireAuth(req);
      const claims = await c.google(GoogleLoginBody.parse(req.body).idToken);
      await c.accounts.linkIdentity(userId, 'GOOGLE', claims.sub, { email: claims.email });
      await c.audit.record(
        {
          actorType: 'USER',
          actorId: userId,
          action: 'auth.identity_linked',
          details: { provider: 'GOOGLE' },
        },
        clientContext(req),
      );
      res.json({ data: await c.accounts.loadMe(userId) });
    });
  }

  return router;
}

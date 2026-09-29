import {
  ChangePasswordBody,
  MfaCodeBody,
  MfaVerifyBody,
  PasswordLoginBody,
  GoogleLoginBody,
  OtpRequestBody,
  OtpVerifyBody,
  type AdminRole,
  type AuditActorType,
  type AuthProvidersResponse,
  type MfaSessionResponse,
  type SessionAudience,
  type SessionResponse,
} from '@cbi/shared-types';
import { Router, type Request, type Response } from 'express';
import type { Container } from '../../container.js';
import { AppError } from '../../lib/errors.js';
import { clientContext } from '../../lib/request-context.js';
import { authenticate, requireAuth, requireCsrfHeader } from '../../middleware/authenticate.js';
import { OrgMemberModel, OrgModel, UserModel, type UserDocument } from '@cbi/db';
import { clearRefreshCookie, readRefreshCookie, setRefreshCookie } from './cookies.js';
import { resolveMessageLocale } from './locale.js';

/** Audit actor for a signed-in person acting in one of the apps. */
export const actorTypeFor = (audience: SessionAudience): AuditActorType =>
  audience === 'admin' ? 'ADMIN' : audience === 'org' ? 'ORG_MEMBER' : 'USER';

/** Whether the member's organisation requires an authenticator app (org sign-in). */
async function orgRequiresMfa(userId: string): Promise<boolean> {
  const member = await OrgMemberModel.findOne(
    { userId, status: { $in: ['INVITED', 'ACTIVE'] } },
    { orgId: 1 },
  ).lean();
  if (!member) return false;
  const org = await OrgModel.findById(member.orgId, { mfaRequired: 1 }).lean();
  return org?.mfaRequired ?? false;
}

/**
 * Sign-in endpoints. Mounted three times: `/auth` (candidate app),
 * `/admin/auth` (admin console) and `/org/auth` (org portal, served by the
 * admin web app). The audience keeps the sessions, cookies and tokens apart.
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
    opts: { deletionCancelled?: boolean; mfaDone?: boolean; recoveryCodes?: string[] | null } = {},
  ) {
    const ctx = clientContext(req);
    const userId = String(user._id);
    // Admin sign-in needs a second factor when one is set up or required for the role;
    // org sign-in when one is set up or the organisation requires it.
    if (audience !== 'candidate' && !opts.mfaDone) {
      const challenge = await c.mfa.beginSignIn(
        { id: userId, account: user.primaryEmail ?? userId, roles: user.adminRoles as AdminRole[] },
        method,
        audience === 'org' ? { audience, required: await orgRequiresMfa(userId) } : {},
      );
      if (challenge) {
        await c.audit.record(
          {
            actorType: actorTypeFor(audience),
            actorId: userId,
            action: 'auth.mfa_challenged',
            details: { method, mode: challenge.mode },
          },
          ctx,
        );
        res.set('Cache-Control', 'no-store').json({ data: challenge });
        return;
      }
    }
    if (opts.deletionCancelled) {
      await c.userState.invalidate(userId);
      await c.audit.record(
        {
          actorType: 'USER',
          actorId: userId,
          action: 'privacy.deletion_cancelled',
          resourceType: 'user',
          resourceId: userId,
        },
        ctx,
      );
    }
    const session = await c.sessions.issue(
      {
        id: userId,
        tokenVersion: user.tokenVersion,
        adminRoles: user.adminRoles as AdminRole[],
      },
      audience,
      ctx,
    );
    setRefreshCookie(res, audience, c.cookies, session.refreshToken, session.refreshTokenExpiresAt);
    await c.audit.record(
      {
        actorType: actorTypeFor(audience),
        actorId: userId,
        action: created ? 'auth.account_created' : 'auth.login_succeeded',
        details: { audience, method },
      },
      ctx,
    );
    const data: SessionResponse = {
      accessToken: session.accessToken,
      accessTokenExpiresAt: session.accessTokenExpiresAt.toISOString(),
      user: await c.accounts.loadMe(userId),
    };
    const body: { data: SessionResponse | MfaSessionResponse } = {
      data: opts.mfaDone ? { ...data, recoveryCodes: opts.recoveryCodes ?? null } : data,
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
      lang: resolveMessageLocale({
        requested: body.lang,
        acceptLanguage: req.headers['accept-language'],
      }),
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
    const { user, created, deletionCancelled } = await c.accounts.loginWithVerifiedContact(
      verified.channel,
      verified.destination,
      audience,
    );
    await respondWithSession(req, res, user, `otp_${verified.channel.toLowerCase()}`, created, {
      deletionCancelled,
    });
  });

  if (audience === 'admin') {
    // Admin console only: email + password (set on the server or in the console).
    router.post('/password/login', limiters.otpVerify, async (req, res) => {
      const body = PasswordLoginBody.parse(req.body);
      const user = await c.passwords.login(body.email, body.password, clientContext(req));
      await respondWithSession(req, res, user, 'password', false);
    });
    router.post('/password', signedIn, limiters.auth, async (req, res) => {
      const body = ChangePasswordBody.parse(req.body);
      res.json({
        data: await c.passwords.change(requireAuth(req).userId, body, clientContext(req)),
      });
    });
  }

  if (audience !== 'candidate') {
    // Second sign-in step (authenticator or recovery code); the challenge token is single-use.
    router.post('/mfa/verify', limiters.otpVerify, async (req, res) => {
      const body = MfaVerifyBody.parse(req.body);
      const done = await c.mfa.completeSignIn(body, clientContext(req), audience);
      const user = await UserModel.findById(done.userId);
      if (!user || user.status !== 'ACTIVE') {
        throw new AppError(403, 'ACCOUNT_SUSPENDED', 'This account is suspended.');
      }
      if (audience === 'admin' && user.adminRoles.length === 0) {
        throw AppError.forbidden('This account does not have admin access.');
      }
      if (audience === 'org') {
        await c.userState.invalidate(done.userId);
        const state = await c.userState.get(done.userId);
        if (!state?.org || state.org.orgStatus !== 'ACTIVE') {
          throw AppError.forbidden('This account is not a member of an organisation.');
        }
      }
      await respondWithSession(req, res, user, done.method, false, {
        mfaDone: true,
        recoveryCodes: done.recoveryCodes,
      });
    });

    // Two-factor status (account page); org members follow their organisation's setting.
    router.get('/mfa', signedIn, async (req, res) => {
      const auth = requireAuth(req);
      const required = audience === 'org' ? await orgRequiresMfa(auth.userId) : undefined;
      res
        .set('Cache-Control', 'no-store')
        .json({ data: await c.mfa.status(auth.userId, auth.adminRoles, required) });
    });
  }

  if (audience === 'admin') {
    router.post('/mfa/enroll', signedIn, limiters.auth, async (req, res) => {
      const auth = requireAuth(req);
      const me = await c.accounts.loadMe(auth.userId);
      res
        .set('Cache-Control', 'no-store')
        .json({ data: await c.mfa.startEnrollment(auth.userId, me.email ?? auth.userId) });
    });
    router.post('/mfa/enroll/confirm', signedIn, limiters.otpVerify, async (req, res) => {
      const { code } = MfaCodeBody.parse(req.body);
      res.set('Cache-Control', 'no-store').json({
        data: await c.mfa.confirmEnrollment(requireAuth(req).userId, code, clientContext(req)),
      });
    });
    router.post('/mfa/recovery-codes', signedIn, limiters.otpVerify, async (req, res) => {
      const { code } = MfaCodeBody.parse(req.body);
      res.set('Cache-Control', 'no-store').json({
        data: await c.mfa.regenerateRecoveryCodes(
          requireAuth(req).userId,
          code,
          clientContext(req),
        ),
      });
    });
    router.post('/mfa/disable', signedIn, limiters.otpVerify, async (req, res) => {
      const auth = requireAuth(req);
      const { code } = MfaCodeBody.parse(req.body);
      await c.mfa.disable(auth.userId, auth.adminRoles, code, clientContext(req));
      res.status(204).end();
    });
  }

  router.post('/google', limiters.auth, async (req, res) => {
    if (!c.google) throw new AppError(503, 'FEATURE_DISABLED', 'Google sign-in is not available.');
    const body = GoogleLoginBody.parse(req.body);
    const claims = await c.google(body.idToken);
    const { user, created, deletionCancelled } = await c.accounts.loginWithGoogle(claims, audience);
    await respondWithSession(req, res, user, 'google', created, { deletionCancelled });
  });

  // Refresh has its own limits (a high per-IP one for shared campus NATs, and one per
  // session), so busy networks cannot use up the sign-in limit and vice versa.
  router.post(
    '/refresh',
    limiters.refresh,
    limiters.refreshSession,
    requireCsrfHeader,
    async (req, res) => {
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
    },
  );

  router.post('/logout', requireCsrfHeader, async (req, res) => {
    const raw = readRefreshCookie(req, audience, c.cookies);
    if (raw) {
      const userId = await c.sessions.revokeByToken(raw, audience);
      if (userId) {
        await c.audit.record(
          {
            actorType: actorTypeFor(audience),
            actorId: userId,
            action: 'auth.logout',
            details: { audience },
          },
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
      {
        actorType: actorTypeFor(audience),
        actorId: auth.userId,
        action: 'auth.logout_all',
        details: { audience },
      },
      clientContext(req),
    );
    clearRefreshCookie(res, audience, c.cookies);
    res.status(204).end();
  });

  // Signed-in devices for this app; each can be signed out on its own.
  router.get('/sessions', signedIn, async (req, res) => {
    const auth = requireAuth(req);
    res
      .set('Cache-Control', 'no-store')
      .json({ data: await c.sessions.list(auth.userId, audience, auth.sessionId) });
  });

  router.delete('/sessions/:id', signedIn, async (req, res) => {
    const auth = requireAuth(req);
    const familyId = String(req.params.id);
    if (!/^[0-9a-f-]{36}$/i.test(familyId)) throw AppError.notFound('Session not found');
    if (!(await c.sessions.revokeFamilyOf(auth.userId, audience, familyId))) {
      throw AppError.notFound('Session not found');
    }
    await c.audit.record(
      {
        actorType: actorTypeFor(audience),
        actorId: auth.userId,
        action: 'auth.session_revoked',
        details: { audience, current: familyId === auth.sessionId },
      },
      clientContext(req),
    );
    if (familyId === auth.sessionId) clearRefreshCookie(res, audience, c.cookies);
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
        lang: resolveMessageLocale({
          requested: body.lang,
          acceptLanguage: req.headers['accept-language'],
        }),
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

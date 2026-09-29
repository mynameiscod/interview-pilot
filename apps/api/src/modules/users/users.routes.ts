import { UserModel, UserProfileModel } from '@cbi/db';
import { DeleteAccountBody, ReauthOtpRequestBody, UpdateProfileBody } from '@cbi/shared-types';
import { Router } from 'express';
import type { Container } from '../../container.js';
import { clientContext } from '../../lib/request-context.js';
import { authenticate, requireAuth } from '../../middleware/authenticate.js';
import { clearRefreshCookie } from '../auth/cookies.js';

/** The profile fields a PATCH sets: omitted fields are left unchanged. */
export function profileUpdate(body: UpdateProfileBody) {
  const $set: Record<string, unknown> = {
    displayName: body.displayName,
    preferredInterviewLanguage: body.preferredInterviewLanguage,
  };
  if (body.productUpdatesOptIn !== undefined) $set.productUpdatesOptIn = body.productUpdatesOptIn;
  const $unset: Record<string, ''> = {};
  // Optional fields: omitted = unchanged, null = cleared.
  for (const field of ['experienceLevel', 'currentRole'] as const) {
    const value = body[field];
    if (value === null) $unset[field] = '';
    else if (value !== undefined) $set[field] = value;
  }
  return { $set, ...(Object.keys($unset).length > 0 ? { $unset } : {}) };
}

/** The signed-in candidate's own account. Every query is scoped to the token's user id. */
export function usersRouter(c: Container): Router {
  const router = Router();
  router.use(authenticate('candidate', c));

  router.get('/me', async (req, res) => {
    res.set('Cache-Control', 'no-store').json({
      data: await c.accounts.loadMe(requireAuth(req).userId),
    });
  });

  router.patch('/me/profile', async (req, res) => {
    const { userId } = requireAuth(req);
    const body = UpdateProfileBody.parse(req.body);
    await UserProfileModel.updateOne({ userId }, profileUpdate(body), { upsert: true });
    await UserModel.updateOne(
      { _id: userId, onboardingCompletedAt: { $exists: false } },
      { $set: { onboardingCompletedAt: new Date() } },
    );
    res.json({ data: await c.accounts.loadMe(userId) });
  });

  // ---- Data rights (DPDP Act 2023) -----------------------------------------

  /** A copy of everything held about the candidate, as a JSON download. */
  router.get('/me/export', c.limiters.dataExport, async (req, res) => {
    const { userId } = requireAuth(req);
    const bundle = await c.privacy.exportData(
      userId,
      `${req.protocol}://${req.get('host') ?? 'localhost'}`,
      clientContext(req),
    );
    const day = bundle.generatedAt.slice(0, 10);
    res
      .set('Cache-Control', 'no-store')
      .set('Content-Disposition', `attachment; filename="careerpilot-data-${day}.json"`)
      .json({ data: bundle });
  });

  /** Re-verification code (to the candidate's own contact) before deleting the account. */
  router.post('/me/reauth/otp', c.limiters.otpRequest, async (req, res) => {
    const { channel } = ReauthOtpRequestBody.parse(req.body);
    res.status(202).json({
      data: await c.privacy.requestReauth(requireAuth(req).userId, channel, clientContext(req)),
    });
  });

  /** Locks the account now and erases it after the grace period (sign-in cancels). */
  router.delete('/me', c.limiters.otpVerify, async (req, res) => {
    const body = DeleteAccountBody.parse(req.body);
    const result = await c.privacy.requestDeletion(
      requireAuth(req).userId,
      body,
      clientContext(req),
    );
    clearRefreshCookie(res, 'candidate', c.cookies);
    res.status(202).json({ data: result });
  });

  return router;
}

import { UserModel, UserProfileModel } from '@cbi/db';
import { UpdateProfileBody } from '@cbi/shared-types';
import { Router } from 'express';
import type { Container } from '../../container.js';
import { authenticate, requireAuth } from '../../middleware/authenticate.js';

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
    const $set: Record<string, unknown> = {
      displayName: body.displayName,
      preferredInterviewLanguage: body.preferredInterviewLanguage,
      productUpdatesOptIn: body.productUpdatesOptIn,
    };
    const $unset: Record<string, ''> = {};
    // Optional fields: omitted = unchanged, null = cleared.
    for (const field of ['experienceLevel', 'currentRole'] as const) {
      const value = body[field];
      if (value === null) $unset[field] = '';
      else if (value !== undefined) $set[field] = value;
    }
    await UserProfileModel.updateOne(
      { userId },
      { $set, ...(Object.keys($unset).length > 0 ? { $unset } : {}) },
      { upsert: true },
    );
    await UserModel.updateOne(
      { _id: userId, onboardingCompletedAt: { $exists: false } },
      { $set: { onboardingCompletedAt: new Date() } },
    );
    res.json({ data: await c.accounts.loadMe(userId) });
  });

  return router;
}

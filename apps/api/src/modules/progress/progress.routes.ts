import {
  CreateDrillBody,
  UnsubscribeBody,
  UpdateGoalsBody,
  UpdatePlanItemBody,
} from '@cbi/shared-types';
import { Router } from 'express';
import type { Container } from '../../container.js';
import { clientContext } from '../../lib/request-context.js';
import { authenticate, requireAuth } from '../../middleware/authenticate.js';

const user = (req: Parameters<typeof requireAuth>[0]) => requireAuth(req).userId;

/** `/users/me/progress`: the progress hub, goals and the plan checklist. */
export function progressRouter(c: Container): Router {
  const router = Router();
  router.use(authenticate('candidate', c), (_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });
  router.get('/', async (req, res) => {
    res.json({ data: await c.progress.overview(user(req)) });
  });
  router.put('/goals', async (req, res) => {
    const body = UpdateGoalsBody.parse(req.body);
    res.json({ data: await c.progress.updateGoals(user(req), body, clientContext(req)) });
  });
  router.put('/plan-items', async (req, res) => {
    const body = UpdatePlanItemBody.parse(req.body);
    res.json({ data: await c.progress.updatePlanItem(user(req), body) });
  });
  return router;
}

/** `/drills`: short practice sessions on one skill (started like an interview). */
export function drillsRouter(c: Container): Router {
  const router = Router();
  router.use(authenticate('candidate', c), (_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });
  router.post('/', async (req, res) => {
    const body = CreateDrillBody.parse(req.body);
    const drill = await c.drills.create(user(req), body, clientContext(req));
    res.status(201).json({ data: await c.interviews.summary(drill) });
  });
  router.get('/:id', async (req, res) => {
    res.json({ data: await c.drills.result(user(req), String(req.params.id)) });
  });
  return router;
}

/** `/email/unsubscribe`: public, authorised by the signed token from the email. */
export function emailRouter(c: Container): Router {
  const router = Router();
  router.post('/unsubscribe', async (req, res) => {
    const { token } = UnsubscribeBody.parse(req.body);
    res
      .set('Cache-Control', 'no-store')
      .json({ data: await c.emailPreferences.unsubscribe(token, clientContext(req)) });
  });
  return router;
}

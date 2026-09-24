import {
  CreateInterviewBody,
  InterviewListQuery,
  UpdateInterviewSetupBody,
} from '@cbi/shared-types';
import { Router } from 'express';
import type { Container } from '../../container.js';
import { clientContext } from '../../lib/request-context.js';
import { authenticate, requireAuth } from '../../middleware/authenticate.js';

/** `/interviews`: the candidate's own interview sessions (pre-interview states in Phase 3). */
export function interviewsRouter(c: Container): Router {
  const router = Router();
  const svc = c.interviews;
  router.use(authenticate('candidate', c), (_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });
  const user = (req: Parameters<typeof requireAuth>[0]) => requireAuth(req).userId;
  const id = (value: unknown) => String(value);

  router.post('/', async (req, res) => {
    const body = CreateInterviewBody.parse(req.body);
    res.status(201).json({ data: await svc.create(user(req), body, clientContext(req)) });
  });
  router.get('/', async (req, res) => {
    const { limit } = InterviewListQuery.parse(req.query);
    res.json({ data: await svc.list(user(req), limit) });
  });
  router.get('/:id', async (req, res) => {
    res.json({ data: await svc.get(user(req), id(req.params.id)) });
  });
  router.post('/:id/analyze', c.limiters.analysis, async (req, res) => {
    res
      .status(202)
      .json({ data: await svc.analyze(user(req), id(req.params.id), clientContext(req)) });
  });
  router.patch('/:id/setup', async (req, res) => {
    const body = UpdateInterviewSetupBody.parse(req.body);
    res.json({ data: await svc.updateSetup(user(req), id(req.params.id), body) });
  });
  router.post('/:id/cancel', async (req, res) => {
    res.json({ data: await svc.cancel(user(req), id(req.params.id), clientContext(req)) });
  });
  return router;
}

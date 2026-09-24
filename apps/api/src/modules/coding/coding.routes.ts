import { CreateProblemVersionBody, ProblemActivationBody, SaveCodeBody } from '@cbi/shared-types';
import { Router, type RequestHandler } from 'express';
import type { Container } from '../../container.js';
import { clientContext } from '../../lib/request-context.js';
import { authenticate, requireAuth, requirePermission } from '../../middleware/authenticate.js';

const noStore: RequestHandler = (_req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
};

/** Coding workspace endpoints under `/interviews/:id/coding/:questionId`. */
export function codingInterviewRouter(c: Container): Router {
  const router = Router();
  router.use(authenticate('candidate', c), noStore);
  const ids = (req: { params: Record<string, unknown> }) =>
    [String(req.params.id), String(req.params.questionId)] as const;

  router.get('/:id/coding/:questionId', async (req, res) => {
    res.json({ data: await c.coding.workspace(requireAuth(req).userId, ...ids(req)) });
  });

  router.put('/:id/coding/:questionId', async (req, res) => {
    const body = SaveCodeBody.parse(req.body);
    res.json({ data: await c.coding.save(requireAuth(req).userId, ...ids(req), body) });
  });

  router.post('/:id/coding/:questionId/run', c.limiters.coding, async (req, res) => {
    const body = SaveCodeBody.parse(req.body);
    res.json({ data: await c.coding.run(requireAuth(req).userId, ...ids(req), body) });
  });

  router.post('/:id/coding/:questionId/submit', c.limiters.coding, async (req, res) => {
    const body = SaveCodeBody.parse(req.body);
    res.json({
      data: await c.coding.submit(requireAuth(req).userId, ...ids(req), body, clientContext(req)),
    });
  });

  return router;
}

/** Admin problem bank (inside the admin router; library permissions). */
export function codingAdminRouter(c: Container): Router {
  const router = Router();

  router.get('/problems', requirePermission('library.read'), async (_req, res) => {
    res.set('Cache-Control', 'no-store').json({ data: await c.coding.listProblems() });
  });

  router.post('/problems', requirePermission('library.manage'), async (req, res) => {
    const body = CreateProblemVersionBody.parse(req.body);
    res.status(201).json({
      data: await c.coding.createProblemVersion(body, requireAuth(req).userId, clientContext(req)),
    });
  });

  for (const [path, active] of [
    ['activate', true],
    ['deactivate', false],
  ] as const) {
    router.post(`/problems/:id/${path}`, requirePermission('library.manage'), async (req, res) => {
      const { reason } = ProblemActivationBody.parse(req.body);
      res.json({
        data: await c.coding.setProblemActive(
          String(req.params.id),
          active,
          reason,
          requireAuth(req).userId,
          clientContext(req),
        ),
      });
    });
  }

  return router;
}

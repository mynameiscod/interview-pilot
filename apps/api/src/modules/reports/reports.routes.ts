import { CompareQuery, FeedbackBody, LibraryReasonBody } from '@cbi/shared-types';
import { Router } from 'express';
import type { Container } from '../../container.js';
import { clientContext } from '../../lib/request-context.js';
import { authenticate, requireAuth, requirePermission } from '../../middleware/authenticate.js';

/** `/reports`: the candidate's readiness reports, history and comparisons. */
export function reportsRouter(c: Container): Router {
  const router = Router();
  router.use(authenticate('candidate', c), (_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });
  const user = (req: Parameters<typeof requireAuth>[0]) => requireAuth(req).userId;

  router.get('/', async (req, res) => {
    res.json({ data: await c.reports.history(user(req)) });
  });
  // Registered before /:sessionId so "compare" is not read as a session id.
  router.get('/compare', async (req, res) => {
    const { sessions } = CompareQuery.parse(req.query);
    res.json({ data: await c.reports.compare(user(req), sessions) });
  });
  router.get('/:sessionId', async (req, res) => {
    res.json({ data: await c.reports.get(user(req), String(req.params.sessionId)) });
  });
  router.get('/:sessionId/pdf', async (req, res) => {
    const { body, fileName } = await c.reports.pdf(user(req), String(req.params.sessionId));
    res
      .set('Content-Type', 'application/pdf')
      .set('Content-Disposition', `attachment; filename="${fileName}"`)
      .set('X-Content-Type-Options', 'nosniff')
      .send(body);
  });
  return router;
}

/** `/feedback`: how useful and accurate the candidate found an interview and its report. */
export function feedbackRouter(c: Container): Router {
  const router = Router();
  router.use(authenticate('candidate', c));
  router.post('/', async (req, res) => {
    const body = FeedbackBody.parse(req.body);
    res.json({
      data: await c.reports.saveFeedback(requireAuth(req).userId, body, clientContext(req)),
    });
  });
  router.get('/:sessionId', async (req, res) => {
    res.json({
      data: await c.reports.getFeedback(requireAuth(req).userId, String(req.params.sessionId)),
    });
  });
  return router;
}

/** `/admin/interviews/:id/reprocess`, mounted inside the admin router. */
export function interviewsAdminRouter(c: Container): Router {
  const router = Router();
  router.post(
    '/interviews/:id/reprocess',
    requirePermission('interviews.manage'),
    async (req, res) => {
      const { reason } = LibraryReasonBody.parse(req.body);
      res.status(202).json({
        data: await c.reports.reprocess(
          String(req.params.id),
          requireAuth(req).userId,
          reason,
          clientContext(req),
        ),
      });
    },
  );
  return router;
}

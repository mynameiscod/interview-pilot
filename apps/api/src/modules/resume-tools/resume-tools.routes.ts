import { ResumeToolsBody } from '@cbi/shared-types';
import { Router, type RequestHandler } from 'express';
import type { Container } from '../../container.js';
import { authenticate, requireAuth } from '../../middleware/authenticate.js';

const noStore: RequestHandler = (_req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
};

/**
 * `/resume-tools`: the resume ↔ job description match score (free,
 * deterministic) and AI tailoring suggestions. No interview is needed.
 */
export function resumeToolsRouter(c: Container): Router {
  const router = Router();
  router.use(authenticate('candidate', c), noStore);

  router.post('/match', c.limiters.resumeMatch, async (req, res) => {
    const body = ResumeToolsBody.parse(req.body);
    res.json({ data: await c.resumeTools.match(requireAuth(req).userId, body) });
  });
  router.post('/tailorings', c.limiters.resumeTailor, async (req, res) => {
    const body = ResumeToolsBody.parse(req.body);
    const { created, tailoring } = await c.resumeTools.requestTailoring(
      requireAuth(req).userId,
      body,
    );
    res.status(created ? 202 : 200).json({ data: tailoring });
  });
  router.get('/tailorings/:id', async (req, res) => {
    res.json({
      data: await c.resumeTools.getTailoring(requireAuth(req).userId, String(req.params.id)),
    });
  });
  return router;
}

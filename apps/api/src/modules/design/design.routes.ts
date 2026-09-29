import {
  CreateDesignPromptVersionBody,
  ProblemActivationBody,
  SaveDesignBody,
} from '@cbi/shared-types';
import { Router, type RequestHandler } from 'express';
import type { Container } from '../../container.js';
import { clientContext } from '../../lib/request-context.js';
import { authenticate, requireAuth, requirePermission } from '../../middleware/authenticate.js';

const noStore: RequestHandler = (_req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
};

/** Design workspace endpoints under `/interviews/:id/design/:questionId`. */
export function designInterviewRouter(c: Container): Router {
  const router = Router();
  router.use(authenticate('candidate', c), noStore);
  const ids = (req: { params: Record<string, unknown> }) =>
    [String(req.params.id), String(req.params.questionId)] as const;

  router.get('/:id/design/:questionId', async (req, res) => {
    res.json({ data: await c.design.workspace(requireAuth(req).userId, ...ids(req)) });
  });

  router.put('/:id/design/:questionId', async (req, res) => {
    const body = SaveDesignBody.parse(req.body);
    res.json({ data: await c.design.save(requireAuth(req).userId, ...ids(req), body) });
  });

  router.post('/:id/design/:questionId/submit', c.limiters.coding, async (req, res) => {
    const body = SaveDesignBody.parse(req.body);
    res.json({
      data: await c.design.submit(requireAuth(req).userId, ...ids(req), body, clientContext(req)),
    });
  });

  return router;
}

/** Admin design bank (inside the admin router; library permissions). */
export function designAdminRouter(c: Container): Router {
  const router = Router();

  router.get('/design-prompts', requirePermission('library.read'), async (_req, res) => {
    res.set('Cache-Control', 'no-store').json({ data: await c.design.listPrompts() });
  });

  router.post('/design-prompts', requirePermission('library.manage'), async (req, res) => {
    const body = CreateDesignPromptVersionBody.parse(req.body);
    res.status(201).json({
      data: await c.design.createPromptVersion(body, requireAuth(req).userId, clientContext(req)),
    });
  });

  for (const [path, active] of [
    ['activate', true],
    ['deactivate', false],
  ] as const) {
    router.post(
      `/design-prompts/:id/${path}`,
      requirePermission('library.manage'),
      async (req, res) => {
        const { reason } = ProblemActivationBody.parse(req.body);
        res.json({
          data: await c.design.setPromptActive(
            String(req.params.id),
            active,
            reason,
            requireAuth(req).userId,
            clientContext(req),
          ),
        });
      },
    );
  }

  return router;
}

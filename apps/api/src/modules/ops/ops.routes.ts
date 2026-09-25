import {
  CostQuery,
  CreateShareBody,
  DateRangeQuery,
  FailedJobsQuery,
  RetryJobBody,
  RollupBody,
  SettingKey,
  TestIntegrationBody,
  TrackEventsBody,
  UpdateIntegrationBody,
  UpdateFlagBody,
  UpdateSettingBody,
} from '@cbi/shared-types';
import { Router, type RequestHandler, type Response } from 'express';
import type { Container } from '../../container.js';
import { AppError } from '../../lib/errors.js';
import { clientContext } from '../../lib/request-context.js';
import { parseKind } from './integrations.service.js';
import { authenticate, requireAuth, requirePermission } from '../../middleware/authenticate.js';

const noStore = (res: Response) => res.set('Cache-Control', 'no-store');

/** Authenticates when a bearer token is sent; anonymous otherwise. */
function optionalCandidate(c: Container): RequestHandler {
  const auth = authenticate('candidate', c);
  return (req, res, next) => (req.headers.authorization ? auth(req, res, next) : next());
}

/** Public and candidate endpoints: `/analytics`, `/flags`, `/system/status`, `/proof`. */
export function opsPublicRouter(c: Container): Router {
  const router = Router();
  const optional = optionalCandidate(c);

  router.post('/analytics/events', c.limiters.analytics, optional, async (req, res) => {
    const body = TrackEventsBody.parse(req.body);
    res.status(202).json({ data: await c.analytics.track(body, req.auth?.userId ?? null) });
  });
  router.get('/flags', optional, async (req, res) => {
    noStore(res).json({ data: await c.flags.clientFlags(req.auth?.userId ?? null) });
  });
  router.get('/system/status', async (_req, res) => {
    res
      .set('Cache-Control', 'public, max-age=30')
      .json({ data: { maintenance: await c.settings.get('maintenance') } });
  });
  router.get('/proof/:token', async (req, res) => {
    noStore(res)
      .set('X-Robots-Tag', 'noindex')
      .json({ data: await c.proof.view(String(req.params.token)) });
  });
  return router;
}

/** `/reports/:sessionId/shares` and `/reports/shares/:id` (candidate). */
export function shareLinksRouter(c: Container): Router {
  const router = Router();
  router.use(authenticate('candidate', c), (_req, res, next) => {
    noStore(res);
    next();
  });
  const user = (req: Parameters<typeof requireAuth>[0]) => requireAuth(req).userId;
  router.delete('/shares/:id', async (req, res) => {
    res.json({
      data: await c.proof.revoke(user(req), String(req.params.id), clientContext(req)),
    });
  });
  router.get('/:sessionId/shares', async (req, res) => {
    res.json({ data: await c.proof.list(user(req), String(req.params.sessionId)) });
  });
  router.post('/:sessionId/shares', async (req, res) => {
    const body = CreateShareBody.parse(req.body ?? {});
    res.status(201).json({
      data: await c.proof.create(user(req), String(req.params.sessionId), body, clientContext(req)),
    });
  });
  return router;
}

/** Admin analytics and operations, mounted inside the admin router. */
export function opsAdminRouter(c: Container): Router {
  const router = Router();
  const actor = (req: Parameters<typeof requireAuth>[0]) => requireAuth(req).userId;

  router.get('/analytics/dashboard', requirePermission('analytics.read'), async (req, res) => {
    noStore(res).json({ data: await c.analytics.dashboard(DateRangeQuery.parse(req.query)) });
  });
  router.get('/analytics/costs', requirePermission('analytics.read'), async (req, res) => {
    noStore(res).json({ data: await c.analytics.costs(CostQuery.parse(req.query)) });
  });
  router.post('/analytics/rollup', requirePermission('queues.manage'), async (req, res) => {
    const body = RollupBody.parse(req.body);
    res.json({ data: await c.analytics.rollup(body, actor(req), clientContext(req)) });
  });

  router.get('/system/health', requirePermission('system.read'), async (_req, res) => {
    noStore(res).json({ data: await c.system.health() });
  });
  router.get('/system/queues', requirePermission('system.read'), async (_req, res) => {
    noStore(res).json({ data: await c.system.queues() });
  });
  router.get('/system/queues/:name/failed', requirePermission('system.read'), async (req, res) => {
    const { limit } = FailedJobsQuery.parse(req.query);
    noStore(res).json({ data: await c.system.failed(String(req.params.name), limit) });
  });
  router.post(
    '/system/queues/:name/jobs/:jobId/retry',
    requirePermission('queues.manage'),
    async (req, res) => {
      const { reason } = RetryJobBody.parse(req.body);
      res.json({
        data: await c.system.retry(
          String(req.params.name),
          String(req.params.jobId),
          reason,
          actor(req),
          clientContext(req),
        ),
      });
    },
  );

  router.get('/flags', requirePermission('system.read'), async (_req, res) => {
    noStore(res).json({ data: await c.flags.list() });
  });
  router.put('/flags/:key', requirePermission('system.manage'), async (req, res) => {
    const body = UpdateFlagBody.parse(req.body);
    res.json({
      data: await c.flags.update(String(req.params.key), body, actor(req), clientContext(req)),
    });
  });

  // ---- Integrations: provider credentials (write-only secrets) -----------------------------
  router.get('/integrations', requirePermission('system.read'), async (_req, res) => {
    noStore(res).json({ data: await c.integrationsAdmin.list() });
  });
  router.get('/integrations/:kind', requirePermission('system.read'), async (req, res) => {
    noStore(res).json({ data: await c.integrationsAdmin.get(parseKind(String(req.params.kind))) });
  });
  router.put('/integrations/:kind', requirePermission('system.manage'), async (req, res) => {
    const kind = parseKind(String(req.params.kind));
    const body = UpdateIntegrationBody.parse(req.body);
    noStore(res).json({
      data: await c.integrationsAdmin.update(kind, body, actor(req), clientContext(req)),
    });
  });
  router.post('/integrations/:kind/test', requirePermission('system.manage'), async (req, res) => {
    const kind = parseKind(String(req.params.kind));
    const body = TestIntegrationBody.parse(req.body ?? {});
    noStore(res).json({
      data: await c.integrationsAdmin.test(kind, body, actor(req), clientContext(req)),
    });
  });
  router.post('/integrations/:kind/reset', requirePermission('system.manage'), async (req, res) => {
    const kind = parseKind(String(req.params.kind));
    const { reason } = RetryJobBody.parse(req.body);
    noStore(res).json({
      data: await c.integrationsAdmin.reset(kind, reason, actor(req), clientContext(req)),
    });
  });

  router.get('/settings', requirePermission('system.read'), async (_req, res) => {
    noStore(res).json({ data: await c.settings.list() });
  });
  router.put('/settings/:key', requirePermission('system.manage'), async (req, res) => {
    const key = SettingKey.safeParse(req.params.key);
    if (!key.success) throw AppError.notFound('Setting not found');
    const { value, reason } = UpdateSettingBody.parse(req.body);
    res.json({
      data: await c.settings.update(key.data, value, reason, actor(req), clientContext(req)),
    });
  });
  return router;
}

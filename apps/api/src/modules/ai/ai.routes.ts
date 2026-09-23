import {
  ActivatePromptBody,
  AddAiModelPriceBody,
  AiFeature,
  AiUsageEntriesQuery,
  AiUsageQuery,
  CreateAiModelBody,
  CreatePromptVersionBody,
  PromptListQuery,
  RemoveAiProviderCredentialBody,
  SetAiProviderCredentialBody,
  UpdateAiModelBody,
  UpdateAiProviderBody,
  UpsertAiRouteBody,
} from '@cbi/shared-types';
import { Router } from 'express';
import type { Container } from '../../container.js';
import { AppError } from '../../lib/errors.js';
import { clientContext } from '../../lib/request-context.js';
import { requireAuth, requirePermission } from '../../middleware/authenticate.js';

/**
 * `/admin/ai/*` and `/admin/prompts/*`. Mounted inside the admin router, so
 * admin authentication and the admin rate limit already apply.
 */
export function aiAdminRouter(c: Container): Router {
  const router = Router();
  const svc = c.aiAdmin;
  const actor = (req: Parameters<typeof requireAuth>[0]) => requireAuth(req).userId;
  const id = (value: unknown) => String(value);

  // ---- Providers & secrets --------------------------------------------------
  router.get('/ai/providers', requirePermission('ai.read'), async (_req, res) => {
    res.json({ data: await svc.listProviders() });
  });
  router.patch('/ai/providers/:id', requirePermission('ai.manage'), async (req, res) => {
    const body = UpdateAiProviderBody.parse(req.body);
    res.json({
      data: await svc.updateProvider(id(req.params.id), body, actor(req), clientContext(req)),
    });
  });
  router.put('/ai/providers/:id/credential', requirePermission('ai.manage'), async (req, res) => {
    const body = SetAiProviderCredentialBody.parse(req.body);
    const result = await svc.setCredential(
      id(req.params.id),
      body.apiKey,
      body.reason,
      actor(req),
      clientContext(req),
    );
    res.set('Cache-Control', 'no-store').json({ data: result });
  });
  router.delete(
    '/ai/providers/:id/credential',
    requirePermission('ai.manage'),
    async (req, res) => {
      const body = RemoveAiProviderCredentialBody.parse(req.body);
      res.json({
        data: await svc.removeCredential(
          id(req.params.id),
          body.reason,
          actor(req),
          clientContext(req),
        ),
      });
    },
  );

  // ---- Models & pricing -------------------------------------------------------
  router.get('/ai/models', requirePermission('ai.read'), async (_req, res) => {
    res.json({ data: await svc.listModels() });
  });
  router.post('/ai/models', requirePermission('ai.manage'), async (req, res) => {
    const body = CreateAiModelBody.parse(req.body);
    res.status(201).json({ data: await svc.createModel(body, actor(req), clientContext(req)) });
  });
  router.patch('/ai/models/:id', requirePermission('ai.manage'), async (req, res) => {
    const body = UpdateAiModelBody.parse(req.body);
    res.json({
      data: await svc.updateModel(id(req.params.id), body, actor(req), clientContext(req)),
    });
  });
  router.post('/ai/models/:id/prices', requirePermission('ai.manage'), async (req, res) => {
    const body = AddAiModelPriceBody.parse(req.body);
    res
      .status(201)
      .json({ data: await svc.addPrice(id(req.params.id), body, actor(req), clientContext(req)) });
  });
  // Makes a real (billed) provider call, so it sits behind the stricter limiter.
  router.post(
    '/ai/models/:id/test',
    requirePermission('ai.manage'),
    c.limiters.aiTest,
    async (req, res) => {
      res.json({ data: await svc.testModel(id(req.params.id), actor(req), clientContext(req)) });
    },
  );

  // ---- Routing ----------------------------------------------------------------
  router.get('/ai/routes', requirePermission('ai.read'), async (_req, res) => {
    res.json({ data: await svc.listRoutes() });
  });
  router.put('/ai/routes/:feature', requirePermission('ai.manage'), async (req, res) => {
    const feature = AiFeature.safeParse(req.params.feature);
    if (!feature.success) throw AppError.notFound('Unknown feature');
    const body = UpsertAiRouteBody.parse(req.body);
    res.json({ data: await svc.upsertRoute(feature.data, body, actor(req), clientContext(req)) });
  });

  // ---- Usage, cost & health ---------------------------------------------------
  router.get('/ai/usage', requirePermission('ai_usage.read'), async (req, res) => {
    res.json({ data: await svc.usageReport(AiUsageQuery.parse(req.query)) });
  });
  router.get('/ai/usage/entries', requirePermission('ai_usage.read'), async (req, res) => {
    res.json({ data: await svc.usageEntries(AiUsageEntriesQuery.parse(req.query)) });
  });
  router.get('/ai/health', requirePermission('ai.read'), async (_req, res) => {
    res.json({ data: await svc.health() });
  });

  // ---- Prompt registry ----------------------------------------------------------
  router.get('/prompts', requirePermission('prompts.read'), async (req, res) => {
    res.json({ data: await svc.listPrompts(PromptListQuery.parse(req.query)) });
  });
  router.post('/prompts', requirePermission('prompts.manage'), async (req, res) => {
    const body = CreatePromptVersionBody.parse(req.body);
    res
      .status(201)
      .json({ data: await svc.createPromptVersion(body, actor(req), clientContext(req)) });
  });
  router.post('/prompts/:id/activate', requirePermission('prompts.manage'), async (req, res) => {
    const body = ActivatePromptBody.parse(req.body);
    res.json({
      data: await svc.activatePrompt(
        id(req.params.id),
        body.reason,
        actor(req),
        clientContext(req),
      ),
    });
  });

  return router;
}

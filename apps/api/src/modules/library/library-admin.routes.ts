import {
  BlueprintListQuery,
  CreateBlueprintVersionBody,
  CreateTemplateVersionBody,
  LibraryReasonBody,
  PromoteBlueprintBody,
  UpsertCompanyBody,
  UpsertRoleBody,
} from '@cbi/shared-types';
import { Router } from 'express';
import type { Container } from '../../container.js';
import { clientContext } from '../../lib/request-context.js';
import { requireAuth, requirePermission } from '../../middleware/authenticate.js';

/**
 * `/admin/roles`, `/admin/blueprints`, `/admin/companies`, `/admin/templates`.
 * Mounted inside the admin router (admin authentication and rate limit apply).
 */
export function libraryAdminRouter(c: Container): Router {
  const router = Router();
  const svc = c.libraryAdmin;
  const read = requirePermission('library.read');
  const manage = requirePermission('library.manage');
  const actor = (req: Parameters<typeof requireAuth>[0]) => requireAuth(req).userId;
  const id = (value: unknown) => String(value);

  // ---- Roles & blueprints ---------------------------------------------------------
  router.get('/roles', read, async (_req, res) => {
    res.json({ data: await svc.listRoles() });
  });
  router.post('/roles', manage, async (req, res) => {
    const body = UpsertRoleBody.parse(req.body);
    res.status(201).json({ data: await svc.createRole(body, actor(req), clientContext(req)) });
  });
  router.put('/roles/:id', manage, async (req, res) => {
    const body = UpsertRoleBody.parse(req.body);
    res.json({
      data: await svc.updateRole(id(req.params.id), body, actor(req), clientContext(req)),
    });
  });
  router.get('/roles/:id/blueprints', read, async (req, res) => {
    res.json({ data: await svc.listRoleBlueprints(id(req.params.id)) });
  });
  router.post('/roles/:id/blueprints', manage, async (req, res) => {
    const body = CreateBlueprintVersionBody.parse(req.body);
    res.status(201).json({
      data: await svc.createBlueprintVersion(
        id(req.params.id),
        body,
        actor(req),
        clientContext(req),
      ),
    });
  });
  router.get('/blueprints', read, async (req, res) => {
    res.json({ data: await svc.listBlueprints(BlueprintListQuery.parse(req.query)) });
  });
  router.get('/blueprints/:id', read, async (req, res) => {
    res.json({ data: await svc.getBlueprint(id(req.params.id)) });
  });
  router.post('/blueprints/:id/activate', manage, async (req, res) => {
    const { reason } = LibraryReasonBody.parse(req.body);
    res.json({
      data: await svc.activateBlueprint(id(req.params.id), reason, actor(req), clientContext(req)),
    });
  });
  router.post('/blueprints/:id/promote', manage, async (req, res) => {
    const body = PromoteBlueprintBody.parse(req.body);
    res.status(201).json({
      data: await svc.promoteBlueprint(id(req.params.id), body, actor(req), clientContext(req)),
    });
  });

  // ---- Companies ------------------------------------------------------------------------
  router.get('/companies', read, async (_req, res) => {
    res.json({ data: await svc.listCompanies() });
  });
  router.post('/companies', manage, async (req, res) => {
    const body = UpsertCompanyBody.parse(req.body);
    res.status(201).json({ data: await svc.createCompany(body, actor(req), clientContext(req)) });
  });
  router.put('/companies/:id', manage, async (req, res) => {
    const body = UpsertCompanyBody.parse(req.body);
    res.json({
      data: await svc.updateCompany(id(req.params.id), body, actor(req), clientContext(req)),
    });
  });

  // ---- Templates ------------------------------------------------------------------------
  router.get('/templates', read, async (_req, res) => {
    res.json({ data: await svc.listTemplates() });
  });
  router.post('/templates', manage, async (req, res) => {
    const body = CreateTemplateVersionBody.parse(req.body);
    res
      .status(201)
      .json({ data: await svc.createTemplateVersion(body, actor(req), clientContext(req)) });
  });
  router.post('/templates/:id/activate', manage, async (req, res) => {
    const { reason } = LibraryReasonBody.parse(req.body);
    res.json({
      data: await svc.activateTemplate(id(req.params.id), reason, actor(req), clientContext(req)),
    });
  });

  return router;
}

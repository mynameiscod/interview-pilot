import { AuditLogModel, mongoose } from '@cbi/db';
import {
  AuditLogQuery,
  InviteAdminBody,
  permissionsFor,
  RevokeAdminAccessBody,
  UpdateAdminRolesBody,
  type AdminMeResponse,
  type AuditActorType,
  type AuditLogEntry,
} from '@cbi/shared-types';
import { Router } from 'express';
import type { Container } from '../../container.js';
import { AppError } from '../../lib/errors.js';
import { clientContext } from '../../lib/request-context.js';
import { authenticate, requireAuth, requirePermission } from '../../middleware/authenticate.js';
import { aiAdminRouter } from '../ai/ai.routes.js';
import { libraryAdminRouter } from '../library/library-admin.routes.js';
import { paymentsAdminRouter } from '../payments/payments.routes.js';
import { interviewsAdminRouter } from '../reports/reports.routes.js';

/** Admin-only endpoints (behind `/admin`, excluding `/admin/auth`). */
export function adminRouter(c: Container): Router {
  const router = Router();
  router.use(authenticate('admin', c), c.limiters.admin);

  router.get('/me', async (req, res) => {
    const auth = requireAuth(req);
    const me = await c.accounts.loadMe(auth.userId);
    const body: { data: AdminMeResponse } = {
      data: { ...me, permissions: [...permissionsFor(auth.adminRoles)] },
    };
    res.set('Cache-Control', 'no-store').json(body);
  });

  // ---- Admin users -------------------------------------------------------
  router.get('/users', requirePermission('admin_users.read'), async (_req, res) => {
    res.json({ data: await c.adminUsers.list() });
  });

  router.post('/users', requirePermission('admin_users.manage'), async (req, res) => {
    const body = InviteAdminBody.parse(req.body);
    const result = await c.adminUsers.invite(body, requireAuth(req).userId, clientContext(req));
    res.status(201).json({ data: result });
  });

  router.put('/users/:id/roles', requirePermission('admin_users.manage'), async (req, res) => {
    const body = UpdateAdminRolesBody.parse(req.body);
    const result = await c.adminUsers.updateRoles(
      String(req.params.id),
      body,
      requireAuth(req).userId,
      clientContext(req),
    );
    res.json({ data: result });
  });

  router.post(
    '/users/:id/revoke-access',
    requirePermission('admin_users.manage'),
    async (req, res) => {
      const body = RevokeAdminAccessBody.parse(req.body);
      await c.adminUsers.revokeAccess(
        String(req.params.id),
        body.reason,
        requireAuth(req).userId,
        clientContext(req),
      );
      res.status(204).end();
    },
  );

  // ---- Audit log ---------------------------------------------------------
  router.get('/audit-logs', requirePermission('audit.read'), async (req, res) => {
    const query = AuditLogQuery.parse(req.query);
    for (const [field, value] of [
      ['actorId', query.actorId],
      ['before', query.before],
    ] as const) {
      if (value && !mongoose.isValidObjectId(value)) {
        throw AppError.validation(`Invalid ${field}`);
      }
    }
    const filter: Record<string, unknown> = {};
    if (query.action) filter.action = query.action;
    if (query.actorId) filter.actorId = query.actorId;
    if (query.resourceId) filter.resourceId = query.resourceId;
    if (query.before) filter._id = { $lt: new mongoose.Types.ObjectId(query.before) };

    const rows = await AuditLogModel.find(filter)
      .sort({ _id: -1 })
      .limit(query.limit + 1)
      .lean();
    const page = rows.slice(0, query.limit);
    const items: AuditLogEntry[] = page.map((r) => ({
      id: String(r._id),
      at: r.at.toISOString(),
      actorType: r.actorType as AuditActorType,
      actorId: r.actorId ? String(r.actorId) : null,
      action: r.action,
      resourceType: r.resourceType ?? null,
      resourceId: r.resourceId ?? null,
      outcome: r.outcome as 'SUCCESS' | 'FAILURE',
      requestId: r.requestId ?? null,
      details: (r.details as Record<string, unknown> | undefined) ?? null,
    }));
    res.json({
      data: {
        items,
        nextCursor: rows.length > query.limit ? String(page[page.length - 1]!._id) : null,
      },
    });
  });

  // ---- AI provider layer and prompt registry -----------------------------
  router.use(aiAdminRouter(c));
  router.use(libraryAdminRouter(c));
  router.use(interviewsAdminRouter(c));
  router.use(paymentsAdminRouter(c));

  return router;
}

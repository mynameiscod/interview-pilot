import {
  AuditLogExportQuery,
  AuditLogQuery,
  CandidateSearchQuery,
  InviteAdminBody,
  SuspendCandidateBody,
  permissionsFor,
  ResetAdminMfaBody,
  RevokeAdminAccessBody,
  UpdateAdminRolesBody,
  type AdminMeResponse,
} from '@cbi/shared-types';
import { Router } from 'express';
import type { Container } from '../../container.js';
import { clientContext } from '../../lib/request-context.js';
import { authenticate, requireAuth, requirePermission } from '../../middleware/authenticate.js';
import { aiAdminRouter } from '../ai/ai.routes.js';
import { libraryAdminRouter } from '../library/library-admin.routes.js';
import { creditsAdminRouter } from '../credits/credits.routes.js';
import { paymentsAdminRouter } from '../payments/payments.routes.js';
import { mediaAdminRouter } from '../media/media.routes.js';
import { codingAdminRouter } from '../coding/coding.routes.js';
import { interviewsAdminRouter } from '../reports/reports.routes.js';
import { campaignsAdminRouter } from '../campaigns/campaigns.routes.js';
import { opsAdminRouter } from '../ops/ops.routes.js';
import { orgsAdminRouter } from '../orgs/orgs.routes.js';
import { createAuditLogService } from './audit-log.service.js';

/** Admin-only endpoints (behind `/admin`, excluding `/admin/auth`). */
export function adminRouter(c: Container): Router {
  const router = Router();
  router.use(authenticate('admin', c), c.limiters.admin);

  router.get('/me', async (req, res) => {
    const auth = requireAuth(req);
    const me = await c.accounts.loadMe(auth.userId);
    const body: { data: AdminMeResponse } = {
      data: {
        ...me,
        permissions: [...permissionsFor(auth.adminRoles)],
        hasPassword: await c.passwords.hasPassword(auth.userId),
        mfaEnabled: await c.mfa.enabled(auth.userId),
      },
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

  router.post('/users/:id/reset-mfa', requirePermission('admin_users.manage'), async (req, res) => {
    const body = ResetAdminMfaBody.parse(req.body);
    res.json({
      data: await c.adminUsers.resetMfa(
        String(req.params.id),
        body,
        requireAuth(req).userId,
        clientContext(req),
      ),
    });
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

  // ---- Candidates (support console) --------------------------------------
  router.get('/candidates', requirePermission('candidates.read'), async (req, res) => {
    const query = CandidateSearchQuery.parse(req.query);
    res.set('Cache-Control', 'no-store').json({
      data: await c.candidatesAdmin.search(query, requireAuth(req).userId, clientContext(req)),
    });
  });

  router.get('/candidates/:id', requirePermission('candidates.read'), async (req, res) => {
    res.set('Cache-Control', 'no-store').json({
      data: await c.candidatesAdmin.detail(
        String(req.params.id),
        requireAuth(req).userId,
        clientContext(req),
      ),
    });
  });

  router.post(
    '/candidates/:id/suspend',
    requirePermission('candidates.manage'),
    async (req, res) => {
      const { reason } = SuspendCandidateBody.parse(req.body);
      await c.candidatesAdmin.suspend(
        String(req.params.id),
        reason,
        requireAuth(req).userId,
        clientContext(req),
      );
      res.status(204).end();
    },
  );

  router.post(
    '/candidates/:id/reinstate',
    requirePermission('candidates.manage'),
    async (req, res) => {
      const { reason } = SuspendCandidateBody.parse(req.body);
      await c.candidatesAdmin.reinstate(
        String(req.params.id),
        reason,
        requireAuth(req).userId,
        clientContext(req),
      );
      res.status(204).end();
    },
  );

  // ---- Audit log ---------------------------------------------------------
  const auditLog = createAuditLogService({ audit: c.audit });
  router.get('/audit-logs', requirePermission('audit.read'), async (req, res) => {
    res.json({ data: await auditLog.list(AuditLogQuery.parse(req.query)) });
  });
  // Every matching entry, streamed. Stricter than viewing (SUPER_ADMIN) and itself audited.
  router.get(
    '/audit-logs/export.csv',
    requirePermission('audit.read'),
    requirePermission('audit.export'),
    async (req, res) => {
      const query = AuditLogExportQuery.parse(req.query);
      const day = new Date().toISOString().slice(0, 10);
      try {
        await auditLog.exportCsv(query, res, requireAuth(req).userId, clientContext(req), () => {
          res
            .status(200)
            .set('Cache-Control', 'no-store')
            .set('Content-Type', 'text/csv; charset=utf-8')
            .set('Content-Disposition', `attachment; filename="audit-log-${day}.csv"`)
            .set('X-Content-Type-Options', 'nosniff');
        });
      } catch (err) {
        // Once rows are on the wire the JSON error envelope cannot follow: cut the download.
        if (!res.headersSent) throw err;
        req.log.error({ err }, 'audit log export failed mid-stream');
        res.destroy();
      }
    },
  );

  // ---- AI provider layer and prompt registry -----------------------------
  router.use(aiAdminRouter(c));
  router.use(libraryAdminRouter(c));
  router.use(interviewsAdminRouter(c));
  router.use(paymentsAdminRouter(c));
  router.use(creditsAdminRouter(c));
  router.use(mediaAdminRouter(c));
  router.use(codingAdminRouter(c));
  router.use(campaignsAdminRouter(c));
  router.use(opsAdminRouter(c));
  router.use(orgsAdminRouter(c));

  return router;
}

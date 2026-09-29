import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  AVAILABLE_INTERVIEW_MODES,
  BulkStageChangeBody,
  CampaignListQuery,
  CampaignStatusBody,
  CohortQuery,
  CreateApiKeyBody,
  CreateCampaignBody,
  CreateInvitesBody,
  CreateOrgBody,
  CreateWebhookBody,
  IDENTITY_IMAGE_MAX_BYTES,
  IdentityReviewBody,
  InviteListQuery,
  InviteOrgMemberBody,
  InvitePreviewBody,
  JoinCampaignBody,
  NoteBody,
  OrgListQuery,
  OrgResultsExportQuery,
  OrgResultsQuery,
  OrgStatusBody,
  OrgWalletAdjustBody,
  orgPermissionsFor,
  RotateInviteBody,
  ScorecardBody,
  StageChangeBody,
  UpdateCampaignBody,
  UpdateOrgBody,
  UpdateOrgMemberBody,
  UpdateScorecardCriteriaBody,
  UpdateWebhookBody,
  type ApiCampaign,
  type OrgMeResponse,
} from '@cbi/shared-types';
import { InterviewTemplateModel, RoleModel, type CampaignRecord } from '@cbi/db';
import express, { Router, type Request, type RequestHandler, type Response } from 'express';
import type { Container } from '../../container.js';
import { AppError } from '../../lib/errors.js';
import { clientContext } from '../../lib/request-context.js';
import {
  authenticate,
  requireAuth,
  requireOrg,
  requireOrgPermission,
  requirePermission,
} from '../../middleware/authenticate.js';
import { kindFromPath } from './identity.service.js';
import type { OrgActor } from './orgs.service.js';

const noStore = (res: Response) => res.set('Cache-Control', 'no-store');
const id = (value: unknown) => String(value);

/** Streams a download; after the first byte an error cuts the connection instead of "succeeding". */
async function streamTo(res: Response, source: Readable) {
  try {
    await pipeline(source, res);
  } catch (err) {
    if (!res.headersSent) throw err;
    res.req.log.warn({ err }, 'download interrupted');
    res.destroy();
  }
}

// ---- CodeBegun admins: /admin/orgs ---------------------------------------------------------------

/** Organisations, mounted inside the admin router (`orgs.read` / `orgs.manage`). */
export function orgsAdminRouter(c: Container): Router {
  const router = Router();
  const actor = (req: Request): OrgActor => ({ userId: requireAuth(req).userId, type: 'ADMIN' });

  router.get('/orgs', requirePermission('orgs.read'), async (req, res) => {
    res.json({ data: await c.orgs.list(OrgListQuery.parse(req.query)) });
  });
  router.post('/orgs', requirePermission('orgs.manage'), async (req, res) => {
    const body = CreateOrgBody.parse(req.body);
    res
      .status(201)
      .json({ data: await c.orgs.create(body, requireAuth(req).userId, clientContext(req)) });
  });
  router.get('/orgs/:id', requirePermission('orgs.read'), async (req, res) => {
    res.json({ data: await c.orgs.get(id(req.params.id)) });
  });
  router.put('/orgs/:id', requirePermission('orgs.manage'), async (req, res) => {
    const body = UpdateOrgBody.parse(req.body);
    res.json({
      data: await c.orgs.update(
        id(req.params.id),
        body,
        requireAuth(req).userId,
        clientContext(req),
      ),
    });
  });
  router.post('/orgs/:id/status', requirePermission('orgs.manage'), async (req, res) => {
    const body = OrgStatusBody.parse(req.body);
    res.json({
      data: await c.orgs.setStatus(
        id(req.params.id),
        body,
        requireAuth(req).userId,
        clientContext(req),
      ),
    });
  });
  router.post('/orgs/:id/wallet', requirePermission('orgs.manage'), async (req, res) => {
    const body = OrgWalletAdjustBody.parse(req.body);
    res.json({
      data: await c.orgs.adjustWallet(
        id(req.params.id),
        body,
        requireAuth(req).userId,
        clientContext(req),
      ),
    });
  });
  router.get('/orgs/:id/members', requirePermission('orgs.read'), async (req, res) => {
    await c.orgs.byId(id(req.params.id));
    res.json({ data: await c.orgs.members(id(req.params.id)) });
  });
  router.post('/orgs/:id/members', requirePermission('orgs.manage'), async (req, res) => {
    const body = InviteOrgMemberBody.parse(req.body);
    res.status(201).json({
      data: await c.orgs.inviteMember(id(req.params.id), body, actor(req), clientContext(req)),
    });
  });
  router.put('/orgs/:id/members/:memberId', requirePermission('orgs.manage'), async (req, res) => {
    const { role } = UpdateOrgMemberBody.parse(req.body);
    res.json({
      data: await c.orgs.changeRole(
        id(req.params.id),
        id(req.params.memberId),
        role,
        actor(req),
        clientContext(req),
      ),
    });
  });
  router.delete(
    '/orgs/:id/members/:memberId',
    requirePermission('orgs.manage'),
    async (req, res) => {
      await c.orgs.removeMember(
        id(req.params.id),
        id(req.params.memberId),
        actor(req),
        clientContext(req),
      );
      res.status(204).end();
    },
  );
  return router;
}

// ---- Org portal: /org --------------------------------------------------------------------------

/**
 * The org portal API (org sessions only). Every campaign is loaded through
 * the member's organisation, so another organisation's ids answer 404.
 */
export function orgPortalRouter(c: Container): Router {
  const router = Router();
  router.use(authenticate('org', c), c.limiters.admin, (_req, res, next) => {
    noStore(res);
    next();
  });
  const member = (req: Request) => {
    const { orgId, userId } = requireOrg(req);
    return { orgId, userId };
  };
  const scope = (req: Request) => ({ orgId: requireOrg(req).orgId });
  const ownCampaign = (req: Request): Promise<CampaignRecord> =>
    c.campaigns.byId(id(req.params.id), scope(req));
  const actor = (req: Request): OrgActor => ({
    userId: requireOrg(req).userId,
    type: 'ORG_MEMBER',
  });
  const can = requireOrgPermission;

  router.get('/me', async (req, res) => {
    const { orgId, role, userId } = requireOrg(req);
    const [me, org, mfaEnabled] = await Promise.all([
      c.accounts.loadMe(userId),
      c.orgs.byId(orgId),
      c.mfa.enabled(userId),
    ]);
    const body: { data: OrgMeResponse } = {
      data: {
        ...me,
        org: { id: orgId, name: org.name, type: org.type, mfaRequired: org.mfaRequired },
        orgRole: role,
        orgPermissions: orgPermissionsFor(role),
        mfaEnabled,
      },
    };
    res.json(body);
  });

  router.get('/organisation', can('org.read'), async (req, res) => {
    res.json({ data: await c.orgs.get(requireOrg(req).orgId) });
  });
  router.put('/organisation/scorecard', can('org.members.manage'), async (req, res) => {
    const body = UpdateScorecardCriteriaBody.parse(req.body);
    res.json({
      data: await c.orgs.updateCriteria(
        requireOrg(req).orgId,
        body,
        actor(req),
        clientContext(req),
      ),
    });
  });

  // ---- Members
  router.get('/members', can('org.read'), async (req, res) => {
    res.json({ data: await c.orgs.members(requireOrg(req).orgId) });
  });
  router.post('/members', can('org.members.manage'), async (req, res) => {
    const body = InviteOrgMemberBody.parse(req.body);
    res.status(201).json({
      data: await c.orgs.inviteMember(requireOrg(req).orgId, body, actor(req), clientContext(req)),
    });
  });
  router.put('/members/:memberId', can('org.members.manage'), async (req, res) => {
    const { role } = UpdateOrgMemberBody.parse(req.body);
    res.json({
      data: await c.orgs.changeRole(
        requireOrg(req).orgId,
        id(req.params.memberId),
        role,
        actor(req),
        clientContext(req),
      ),
    });
  });
  router.delete('/members/:memberId', can('org.members.manage'), async (req, res) => {
    await c.orgs.removeMember(
      requireOrg(req).orgId,
      id(req.params.memberId),
      actor(req),
      clientContext(req),
    );
    res.status(204).end();
  });

  // ---- What a campaign can be built from (active roles with a blueprint, active templates)
  router.get('/library', can('org.read'), async (_req, res) => {
    const [roles, templates] = await Promise.all([
      RoleModel.find({ active: true, activeBlueprintId: { $ne: null } }, { title: 1 })
        .sort({ title: 1 })
        .lean(),
      InterviewTemplateModel.find(
        { status: 'ACTIVE' },
        { key: 1, 'content.name': 1, 'content.modes': 1 },
      )
        .sort({ key: 1 })
        .lean(),
    ]);
    res.json({
      data: {
        roles: roles.map((r) => ({ id: String(r._id), title: r.title })),
        templates: templates.map((t) => ({
          key: t.key,
          name: t.content.name,
          modes: t.content.modes.filter((m) => AVAILABLE_INTERVIEW_MODES.includes(m)),
        })),
      },
    });
  });

  // ---- Campaigns (the campaign service, scoped to the organisation)
  router.get('/campaigns', can('org.read'), async (req, res) => {
    res.json({ data: await c.campaigns.list(CampaignListQuery.parse(req.query), scope(req)) });
  });
  router.post('/campaigns', can('org.campaigns.manage'), async (req, res) => {
    const body = CreateCampaignBody.parse(req.body);
    res.status(201).json({
      data: await c.campaigns.create(body, member(req).userId, clientContext(req), scope(req)),
    });
  });
  router.get('/campaigns/:id', can('org.read'), async (req, res) => {
    res.json({ data: await c.campaigns.get(id(req.params.id), scope(req)) });
  });
  router.put('/campaigns/:id', can('org.campaigns.manage'), async (req, res) => {
    const body = UpdateCampaignBody.parse(req.body);
    res.json({
      data: await c.campaigns.update(
        id(req.params.id),
        body,
        member(req).userId,
        clientContext(req),
        scope(req),
      ),
    });
  });
  router.post('/campaigns/:id/status', can('org.campaigns.manage'), async (req, res) => {
    const body = CampaignStatusBody.parse(req.body);
    res.json({
      data: await c.campaigns.setStatus(
        id(req.params.id),
        body,
        member(req).userId,
        clientContext(req),
        scope(req),
      ),
    });
  });
  router.post('/campaigns/:id/rotate-invite', can('org.campaigns.manage'), async (req, res) => {
    const { reason } = RotateInviteBody.parse(req.body);
    res.json({
      data: await c.campaigns.rotateInvite(
        id(req.params.id),
        reason,
        member(req).userId,
        clientContext(req),
        scope(req),
      ),
    });
  });

  // ---- Invites
  router.get('/campaigns/:id/invites', can('org.read'), async (req, res) => {
    const query = InviteListQuery.parse(req.query);
    res.json({ data: await c.invites.list(await ownCampaign(req), query) });
  });
  router.post('/campaigns/:id/invites/preview', can('org.campaigns.manage'), async (req, res) => {
    const { csv } = InvitePreviewBody.parse(req.body);
    res.json({ data: await c.invites.preview(await ownCampaign(req), csv) });
  });
  router.post('/campaigns/:id/invites', can('org.campaigns.manage'), async (req, res) => {
    const body = CreateInvitesBody.parse(req.body);
    res.status(201).json({
      data: await c.invites.create(
        await ownCampaign(req),
        body,
        member(req).userId,
        clientContext(req),
      ),
    });
  });
  router.post(
    '/campaigns/:id/invites/:inviteId/revoke',
    can('org.campaigns.manage'),
    async (req, res) => {
      res.json({
        data: await c.invites.revoke(
          await ownCampaign(req),
          id(req.params.inviteId),
          member(req).userId,
          clientContext(req),
        ),
      });
    },
  );
  router.post(
    '/campaigns/:id/invites/:inviteId/retry',
    can('org.campaigns.manage'),
    async (req, res) => {
      res.json({
        data: await c.invites.retry(
          await ownCampaign(req),
          id(req.params.inviteId),
          member(req).userId,
          clientContext(req),
        ),
      });
    },
  );

  // ---- Results and pipeline
  router.get('/campaigns/:id/results', can('org.read'), async (req, res) => {
    const query = OrgResultsQuery.parse(req.query);
    res.json({ data: await c.pipeline.results(await ownCampaign(req), query) });
  });
  router.get('/campaigns/:id/results.csv', can('org.export'), async (req, res) => {
    const query = OrgResultsExportQuery.parse(req.query);
    const { chunks, fileName } = await c.pipeline.exportCsv(
      await ownCampaign(req),
      query,
      member(req),
      clientContext(req),
    );
    res
      .set('Content-Type', 'text/csv; charset=utf-8')
      .set('Content-Disposition', `attachment; filename="${fileName}"`);
    await streamTo(res, Readable.from(chunks));
  });
  router.post('/campaigns/:id/candidates/stage', can('org.pipeline.manage'), async (req, res) => {
    const body = BulkStageChangeBody.parse(req.body);
    res.json({
      data: await c.pipeline.setStage(
        await ownCampaign(req),
        body.applicationIds,
        body,
        member(req),
        clientContext(req),
      ),
    });
  });
  router.get('/campaigns/:id/candidates/:appId', can('org.read'), async (req, res) => {
    res.json({
      data: await c.pipeline.detail(
        await ownCampaign(req),
        id(req.params.appId),
        member(req),
        clientContext(req),
      ),
    });
  });
  router.post(
    '/campaigns/:id/candidates/:appId/stage',
    can('org.pipeline.manage'),
    async (req, res) => {
      const campaign = await ownCampaign(req);
      const app = await c.pipeline.applicationOf(campaign, id(req.params.appId));
      const body = StageChangeBody.parse(req.body);
      res.json({
        data: await c.pipeline.setStage(
          campaign,
          [String(app._id)],
          body,
          member(req),
          clientContext(req),
        ),
      });
    },
  );
  router.post('/campaigns/:id/candidates/:appId/notes', can('org.review'), async (req, res) => {
    const body = NoteBody.parse(req.body);
    res.status(201).json({
      data: await c.pipeline.addNote(
        await ownCampaign(req),
        id(req.params.appId),
        body,
        member(req),
        clientContext(req),
      ),
    });
  });
  router.put('/campaigns/:id/candidates/:appId/scorecard', can('org.review'), async (req, res) => {
    const body = ScorecardBody.parse(req.body);
    res.json({
      data: await c.pipeline.saveScorecard(
        await ownCampaign(req),
        id(req.params.appId),
        body,
        member(req),
        clientContext(req),
      ),
    });
  });
  router.get(
    '/campaigns/:id/candidates/:appId/identity/:kind',
    can('org.read'),
    async (req, res) => {
      const campaign = await ownCampaign(req);
      const app = await c.pipeline.applicationOf(campaign, id(req.params.appId));
      const { stream, mimeType } = await c.identity.openImage(
        app,
        kindFromPath(id(req.params.kind)),
        member(req),
        clientContext(req),
      );
      res.set('Content-Type', mimeType).set('Content-Disposition', 'inline');
      await streamTo(res, stream);
    },
  );
  router.post(
    '/campaigns/:id/candidates/:appId/identity/review',
    can('org.pipeline.manage'),
    async (req, res) => {
      const campaign = await ownCampaign(req);
      const app = await c.pipeline.applicationOf(campaign, id(req.params.appId));
      await c.identity.decide(
        app,
        IdentityReviewBody.parse(req.body),
        member(req),
        clientContext(req),
      );
      res.json({ data: await c.identity.review(app) });
    },
  );

  // ---- College cohort analytics
  router.get('/analytics/cohort', can('org.read'), async (req, res) => {
    res.json({
      data: await c.pipeline.cohort(requireOrg(req).orgId, CohortQuery.parse(req.query)),
    });
  });
  router.get('/analytics/cohort.csv', can('org.export'), async (req, res) => {
    const { lines, fileName } = await c.pipeline.cohortCsv(
      requireOrg(req).orgId,
      CohortQuery.parse(req.query),
      member(req).userId,
      clientContext(req),
    );
    res
      .set('Content-Type', 'text/csv; charset=utf-8')
      .set('Content-Disposition', `attachment; filename="${fileName}"`);
    await streamTo(res, Readable.from(lines));
  });

  // ---- Webhooks and API keys
  const integrations = can('org.integrations.manage');
  router.get('/webhooks', integrations, async (req, res) => {
    res.json({ data: await c.orgIntegrations.webhooks(requireOrg(req).orgId) });
  });
  router.post('/webhooks', integrations, async (req, res) => {
    const body = CreateWebhookBody.parse(req.body);
    res.status(201).json({
      data: await c.orgIntegrations.createWebhook(
        requireOrg(req).orgId,
        body,
        member(req).userId,
        clientContext(req),
      ),
    });
  });
  router.put('/webhooks/:webhookId', integrations, async (req, res) => {
    const body = UpdateWebhookBody.parse(req.body);
    res.json({
      data: await c.orgIntegrations.updateWebhook(
        requireOrg(req).orgId,
        id(req.params.webhookId),
        body,
        member(req).userId,
        clientContext(req),
      ),
    });
  });
  router.delete('/webhooks/:webhookId', integrations, async (req, res) => {
    await c.orgIntegrations.deleteWebhook(
      requireOrg(req).orgId,
      id(req.params.webhookId),
      member(req).userId,
      clientContext(req),
    );
    res.status(204).end();
  });
  router.post('/webhooks/:webhookId/ping', integrations, async (req, res) => {
    res.status(202).json({
      data: await c.orgIntegrations.pingWebhook(
        requireOrg(req).orgId,
        id(req.params.webhookId),
        member(req).userId,
        clientContext(req),
      ),
    });
  });
  router.get('/webhooks/:webhookId/deliveries', integrations, async (req, res) => {
    res.json({
      data: await c.orgIntegrations.deliveries(requireOrg(req).orgId, id(req.params.webhookId)),
    });
  });
  router.get('/api-keys', integrations, async (req, res) => {
    res.json({ data: await c.orgIntegrations.apiKeys(requireOrg(req).orgId) });
  });
  router.post('/api-keys', integrations, async (req, res) => {
    const body = CreateApiKeyBody.parse(req.body);
    res.status(201).json({
      data: await c.orgIntegrations.createApiKey(
        requireOrg(req).orgId,
        body,
        member(req).userId,
        clientContext(req),
      ),
    });
  });
  router.post('/api-keys/:keyId/revoke', integrations, async (req, res) => {
    res.json({
      data: await c.orgIntegrations.revokeApiKey(
        requireOrg(req).orgId,
        id(req.params.keyId),
        member(req).userId,
        clientContext(req),
      ),
    });
  });
  return router;
}

// ---- Org API (API keys): /org-api --------------------------------------------------------------

/**
 * Read-only results for ATS integrations, authenticated with an org API key
 * (`Authorization: Bearer cbk_…`). Scope `results:read`; the organisation's
 * own campaigns only; the same consent filter as the portal.
 */
export function orgApiRouter(c: Container): Router {
  const router = Router();
  const apiKeyAuth: RequestHandler = async (req, _res, next) => {
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) throw AppError.unauthenticated('Missing API key.');
    req.apiKey = await c.orgIntegrations.authenticateApiKey(header.slice(7).trim());
    if (!req.apiKey.scopes.includes('results:read')) throw AppError.forbidden();
    next();
  };
  router.use(apiKeyAuth, c.limiters.orgApi, (_req, res, next) => {
    noStore(res);
    next();
  });
  const scope = (req: Request) => ({ orgId: req.apiKey!.orgId });

  router.get('/campaigns', async (req, res) => {
    const page = await c.campaigns.list(CampaignListQuery.parse(req.query), scope(req));
    const items: ApiCampaign[] = page.items.map((s) => ({
      id: s.id,
      name: s.name,
      status: s.status,
      roleTitle: s.role.title,
      joined: s.joined,
      createdAt: s.createdAt,
    }));
    res.json({ data: { ...page, items } });
  });
  router.get('/campaigns/:id/results', async (req, res) => {
    const campaign = await c.campaigns.byId(id(req.params.id), scope(req));
    const query = OrgResultsQuery.parse(req.query);
    const results = await c.pipeline.results(campaign, query);
    await c.audit.record(
      {
        actorType: 'API_KEY',
        actorId: null,
        action: 'org.api_results_read',
        resourceType: 'campaign',
        resourceId: String(campaign._id),
        details: { orgId: req.apiKey!.orgId, apiKeyId: req.apiKey!.id, rows: results.rows.length },
      },
      clientContext(req),
    );
    res.json({ data: results });
  });
  return router;
}

// ---- Candidates: invite landing and identity capture -------------------------------------------

/** `/campaign-invites/:token`: a personal invite link (public landing, join signed in). */
export function campaignInvitesRouter(c: Container): Router {
  const router = Router();
  const auth = authenticate('candidate', c);
  const optionalAuth: typeof auth = (req, res, next) =>
    req.headers.authorization ? auth(req, res, next) : next();

  router.get('/:token', optionalAuth, async (req, res) => {
    noStore(res).json({
      data: await c.campaigns.publicViewByInvite(id(req.params.token), req.auth?.userId ?? null),
    });
  });
  router.post('/:token/join', auth, async (req, res) => {
    const body = JoinCampaignBody.parse(req.body ?? {});
    const result = await c.campaigns.joinByInvite(
      requireAuth(req).userId,
      id(req.params.token),
      body,
      clientContext(req),
    );
    noStore(res)
      .status(result.created ? 201 : 200)
      .json({ data: result });
  });
  return router;
}

/** Identity photos arrive as the raw request body (JPEG or PNG). */
const imageBody = express.raw({
  type: ['image/jpeg', 'image/png'],
  limit: IDENTITY_IMAGE_MAX_BYTES,
});

/** `PUT /interviews/:id/identity/:kind` (selfie, id-document, interview-frame). */
export function identityInterviewRouter(c: Container): Router {
  const router = Router();
  router.put(
    '/:id/identity/:kind',
    authenticate('candidate', c),
    c.limiters.upload,
    imageBody,
    async (req, res) => {
      const status = await c.identity.upload(
        requireAuth(req).userId,
        id(req.params.id),
        kindFromPath(id(req.params.kind)),
        Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0),
        req.get('content-type'),
        clientContext(req),
      );
      noStore(res).json({ data: status });
    },
  );
  return router;
}

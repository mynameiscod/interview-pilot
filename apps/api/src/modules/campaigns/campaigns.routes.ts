import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  AdminInterviewQuery,
  CampaignListQuery,
  CampaignResultsExportQuery,
  CampaignResultsQuery,
  CampaignStatusBody,
  CreateCampaignBody,
  JoinCampaignBody,
  ReviewFlagBody,
  ReviseScoreBody,
  RotateInviteBody,
  UpdateCampaignBody,
} from '@cbi/shared-types';
import { Router, type Response } from 'express';
import type { Container } from '../../container.js';
import { clientContext } from '../../lib/request-context.js';
import { authenticate, requireAuth, requirePermission } from '../../middleware/authenticate.js';

const noStore = (res: Response) => res.set('Cache-Control', 'no-store');

/**
 * Streams a download. Errors before the first byte reach the error handler
 * as usual; after that the status is already sent, so the connection is cut
 * (the client sees an incomplete download rather than a truncated "success").
 */
async function streamTo(res: Response, source: Readable) {
  try {
    await pipeline(source, res);
  } catch (err) {
    if (!res.headersSent) throw err;
    res.req.log.warn({ err }, 'download interrupted');
    res.destroy();
  }
}

/**
 * `/campaigns/:token`: the invite landing page (public; a signed-in
 * candidate also learns whether they already joined) and joining.
 */
export function campaignsRouter(c: Container): Router {
  const router = Router();
  const auth = authenticate('candidate', c);
  const optionalAuth: typeof auth = (req, res, next) =>
    req.headers.authorization ? auth(req, res, next) : next();

  router.get('/:token', optionalAuth, async (req, res) => {
    noStore(res).json({
      data: await c.campaigns.publicView(String(req.params.token), req.auth?.userId ?? null),
    });
  });
  router.post('/:token/join', auth, async (req, res) => {
    const body = JoinCampaignBody.parse(req.body ?? {});
    const result = await c.campaigns.join(
      requireAuth(req).userId,
      String(req.params.token),
      body,
      clientContext(req),
    );
    noStore(res)
      .status(result.created ? 201 : 200)
      .json({ data: result });
  });
  return router;
}

/** `/admin/campaigns` and `/admin/interviews` (review), mounted inside the admin router. */
export function campaignsAdminRouter(c: Container): Router {
  const router = Router();
  const actor = (req: Parameters<typeof requireAuth>[0]) => requireAuth(req).userId;
  const id = (value: unknown) => String(value);

  // ---- Campaigns ------------------------------------------------------------------------------
  router.get('/campaigns', requirePermission('campaigns.read'), async (req, res) => {
    const query = CampaignListQuery.parse(req.query);
    res.json({ data: await c.campaigns.list(query) });
  });
  router.post('/campaigns', requirePermission('campaigns.manage'), async (req, res) => {
    const body = CreateCampaignBody.parse(req.body);
    noStore(res)
      .status(201)
      .json({ data: await c.campaigns.create(body, actor(req), clientContext(req)) });
  });
  router.get('/campaigns/:id', requirePermission('campaigns.read'), async (req, res) => {
    res.json({ data: await c.campaigns.get(id(req.params.id)) });
  });
  router.put('/campaigns/:id', requirePermission('campaigns.manage'), async (req, res) => {
    const body = UpdateCampaignBody.parse(req.body);
    res.json({
      data: await c.campaigns.update(id(req.params.id), body, actor(req), clientContext(req)),
    });
  });
  router.post('/campaigns/:id/status', requirePermission('campaigns.manage'), async (req, res) => {
    const body = CampaignStatusBody.parse(req.body);
    res.json({
      data: await c.campaigns.setStatus(id(req.params.id), body, actor(req), clientContext(req)),
    });
  });
  router.post(
    '/campaigns/:id/rotate-invite',
    requirePermission('campaigns.manage'),
    async (req, res) => {
      const { reason } = RotateInviteBody.parse(req.body);
      noStore(res).json({
        data: await c.campaigns.rotateInvite(
          id(req.params.id),
          reason,
          actor(req),
          clientContext(req),
        ),
      });
    },
  );
  router.get('/campaigns/:id/results', requirePermission('campaigns.read'), async (req, res) => {
    const query = CampaignResultsQuery.parse(req.query);
    noStore(res).json({ data: await c.campaigns.results(id(req.params.id), query) });
  });
  // Exports carry candidates' personal data: managers only, and audited.
  router.get(
    '/campaigns/:id/results.csv',
    requirePermission('campaigns.manage'),
    async (req, res) => {
      const query = CampaignResultsExportQuery.parse(req.query);
      const { chunks, fileName } = await c.campaigns.exportCsv(
        id(req.params.id),
        query,
        actor(req),
        clientContext(req),
      );
      noStore(res)
        .set('Content-Type', 'text/csv; charset=utf-8')
        .set('Content-Disposition', `attachment; filename="${fileName}"`);
      // Rows are written as the cursor yields them, never built up in memory.
      await streamTo(res, Readable.from(chunks));
    },
  );
  // Packages are built by the worker: start one, poll it, then download the file.
  router.post('/campaigns/:id/exports', requirePermission('campaigns.manage'), async (req, res) => {
    noStore(res)
      .status(202)
      .json({
        data: await c.campaigns.startExport(id(req.params.id), actor(req), clientContext(req)),
      });
  });
  router.get(
    '/campaigns/:id/exports/:exportId',
    requirePermission('campaigns.manage'),
    async (req, res) => {
      noStore(res).json({
        data: await c.campaigns.exportStatus(id(req.params.id), id(req.params.exportId)),
      });
    },
  );
  router.get(
    '/campaigns/:id/exports/:exportId/download',
    requirePermission('campaigns.manage'),
    async (req, res) => {
      const { stream, fileName, sizeBytes } = await c.campaigns.openExport(
        id(req.params.id),
        id(req.params.exportId),
        actor(req),
        clientContext(req),
      );
      noStore(res)
        .set('Content-Type', 'application/zip')
        .set('Content-Disposition', `attachment; filename="${fileName}"`);
      if (sizeBytes !== null) res.set('Content-Length', String(sizeBytes));
      await streamTo(res, stream);
    },
  );

  // ---- Interview review -----------------------------------------------------------------------
  router.get('/interviews', requirePermission('interviews.read'), async (req, res) => {
    const query = AdminInterviewQuery.parse(req.query);
    noStore(res).json({ data: await c.review.list(query) });
  });
  router.get('/interviews/:id', requirePermission('interviews.read'), async (req, res) => {
    noStore(res).json({
      data: await c.review.detail(id(req.params.id), actor(req), clientContext(req)),
    });
  });
  router.post('/interviews/:id/flag', requirePermission('interviews.review'), async (req, res) => {
    const body = ReviewFlagBody.parse(req.body);
    res.json({
      data: await c.review.flag(id(req.params.id), body, actor(req), clientContext(req)),
    });
  });
  router.post(
    '/interviews/:id/revise-score',
    requirePermission('interviews.review'),
    async (req, res) => {
      const body = ReviseScoreBody.parse(req.body);
      res.status(201).json({
        data: await c.review.revise(id(req.params.id), body, actor(req), clientContext(req)),
      });
    },
  );
  return router;
}

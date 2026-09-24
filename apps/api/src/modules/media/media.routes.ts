import {
  ActivateConsentTextBody,
  AdminMediaQuery,
  ConsentDecisionBody,
  CreateConsentTextBody,
  FinalizeMediaBody,
  MEDIA_LIMITS,
  PurgeMediaBody,
} from '@cbi/shared-types';
import express, { Router, type RequestHandler } from 'express';
import type { Container } from '../../container.js';
import { clientContext } from '../../lib/request-context.js';
import { authenticate, requireAuth, requirePermission } from '../../middleware/authenticate.js';

const noStore: RequestHandler = (_req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
};

/** Recording segments are sent as the raw request body (one MediaRecorder chunk). */
const segmentBody = express.raw({
  type: ['video/webm', 'video/mp4'],
  limit: MEDIA_LIMITS.segmentMaxBytes,
});

/** Consent and recording endpoints under `/interviews/:id`. */
export function mediaInterviewRouter(c: Container): Router {
  const router = Router();
  router.use(authenticate('candidate', c), noStore);

  router.get('/:id/consents', async (req, res) => {
    res.json({ data: await c.consent.forSession(requireAuth(req).userId, String(req.params.id)) });
  });

  router.post('/:id/consents', async (req, res) => {
    const body = ConsentDecisionBody.parse(req.body);
    res.json({
      data: await c.consent.decide(
        requireAuth(req).userId,
        String(req.params.id),
        body,
        clientContext(req),
      ),
    });
  });

  router.post('/:id/media/segments/:idx', c.limiters.media, segmentBody, async (req, res) => {
    const result = await c.media.uploadSegment(
      requireAuth(req).userId,
      String(req.params.id),
      Number(req.params.idx),
      Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0),
      req.get('content-type'),
    );
    res.status(result.duplicate ? 200 : 201).json({ data: result });
  });

  router.post('/:id/media/finalize', async (req, res) => {
    const body = FinalizeMediaBody.parse(req.body);
    res.json({
      data: await c.media.finalize(requireAuth(req).userId, String(req.params.id), body),
    });
  });

  router.get('/:id/media', async (req, res) => {
    res.json({ data: await c.media.mine(requireAuth(req).userId, String(req.params.id)) });
  });

  router.get('/:id/media/playback-url', async (req, res) => {
    res.json({
      data: await c.media.myPlayback(requireAuth(req).userId, String(req.params.id)),
    });
  });

  router.delete('/:id/media', async (req, res) => {
    res.json({
      data: await c.media.deleteMine(
        requireAuth(req).userId,
        String(req.params.id),
        clientContext(req),
      ),
    });
  });

  return router;
}

/** `GET /media/play/:assetId?exp&sig`: signed, short-lived playback (no auth header, for `<video>`). */
export function mediaPlaybackRouter(c: Container): Router {
  const router = Router();
  router.get('/play/:assetId', async (req, res) => {
    await c.media.stream(
      String(req.params.assetId),
      String(req.query.exp ?? ''),
      String(req.query.sig ?? ''),
      res,
    );
  });
  return router;
}

/** `GET /users/me/consents`: the candidate's consent history. */
export function userConsentsRouter(c: Container): Router {
  const router = Router();
  router.use(authenticate('candidate', c), noStore);
  router.get('/me/consents', async (req, res) => {
    res.json({ data: await c.consent.history(requireAuth(req).userId) });
  });
  return router;
}

/** Admin recordings, integrity observations and consent texts (inside the admin router). */
export function mediaAdminRouter(c: Container): Router {
  const router = Router();
  const readMedia = requirePermission('media.read');
  const manageMedia = requirePermission('media.manage');

  router.get('/media', readMedia, async (req, res) => {
    const query = AdminMediaQuery.parse(req.query);
    res.set('Cache-Control', 'no-store').json({ data: await c.media.adminList(query) });
  });

  router.get('/media/:id', readMedia, async (req, res) => {
    res
      .set('Cache-Control', 'no-store')
      .json({ data: await c.media.adminGet(String(req.params.id)) });
  });

  router.post('/media/:id/playback', readMedia, async (req, res) => {
    res.set('Cache-Control', 'no-store').json({
      data: await c.media.adminPlayback(
        String(req.params.id),
        requireAuth(req).userId,
        clientContext(req),
      ),
    });
  });

  router.post('/media/:id/purge', manageMedia, async (req, res) => {
    const { reason } = PurgeMediaBody.parse(req.body);
    res.json({
      data: await c.media.adminPurge(
        String(req.params.id),
        reason,
        requireAuth(req).userId,
        clientContext(req),
      ),
    });
  });

  router.get('/interviews/:id/integrity', readMedia, async (req, res) => {
    res
      .set('Cache-Control', 'no-store')
      .json({ data: await c.media.adminIntegrity(String(req.params.id)) });
  });

  router.get('/consent-texts', requirePermission('consent.read'), async (_req, res) => {
    res.json({ data: await c.consent.listTexts() });
  });

  router.post('/consent-texts', requirePermission('consent.manage'), async (req, res) => {
    const body = CreateConsentTextBody.parse(req.body);
    res.status(201).json({
      data: await c.consent.createText(body, requireAuth(req).userId, clientContext(req)),
    });
  });

  router.post(
    '/consent-texts/:id/activate',
    requirePermission('consent.manage'),
    async (req, res) => {
      const { reason } = ActivateConsentTextBody.parse(req.body);
      res.json({
        data: await c.consent.activateText(
          String(req.params.id),
          reason,
          requireAuth(req).userId,
          clientContext(req),
        ),
      });
    },
  );

  return router;
}

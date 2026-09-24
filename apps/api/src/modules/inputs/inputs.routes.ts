import { CreateJobTargetBody, UploadJobTargetFields } from '@cbi/shared-types';
import { Router, type RequestHandler } from 'express';
import type { Container } from '../../container.js';
import { clientContext } from '../../lib/request-context.js';
import { singleFileUpload } from '../../lib/upload.js';
import { authenticate, requireAuth } from '../../middleware/authenticate.js';

const noStore: RequestHandler = (_req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
};

/** `/resumes`: the candidate's own resumes. Every query is scoped to the token's user. */
export function resumesRouter(c: Container): Router {
  const router = Router();
  const upload = singleFileUpload(c.env.UPLOAD_MAX_MB * 1024 * 1024);
  router.use(authenticate('candidate', c), noStore);

  router.post('/', c.limiters.upload, upload, async (req, res) => {
    const { userId } = requireAuth(req);
    const { created, resume } = await c.inputs.uploadResume(userId, req.file!, clientContext(req));
    res.status(created ? 201 : 200).json({ data: resume });
  });
  router.get('/', async (req, res) => {
    res.json({ data: await c.inputs.listResumes(requireAuth(req).userId) });
  });
  router.get('/:id', async (req, res) => {
    res.json({ data: await c.inputs.getResume(requireAuth(req).userId, String(req.params.id)) });
  });
  router.get('/:id/status', async (req, res) => {
    const resume = await c.inputs.getResume(requireAuth(req).userId, String(req.params.id));
    res.json({ data: resume.extraction });
  });
  router.delete('/:id', async (req, res) => {
    await c.inputs.deleteResume(requireAuth(req).userId, String(req.params.id), clientContext(req));
    res.status(204).end();
  });
  return router;
}

/** `/jobs`: job targets (pasted, uploaded or linked job descriptions, or a role only). */
export function jobsRouter(c: Container): Router {
  const router = Router();
  const upload = singleFileUpload(c.env.UPLOAD_MAX_MB * 1024 * 1024);
  router.use(authenticate('candidate', c), noStore);

  router.post('/', async (req, res, next) => {
    const body = CreateJobTargetBody.parse(req.body);
    // Only URL sources make outbound requests; they get their own, tighter limit.
    const create = async () => {
      res.status(201).json({ data: await c.inputs.createJobTarget(requireAuth(req).userId, body) });
    };
    if (body.source === 'URL') {
      c.limiters.jdUrl(req, res, (err?: unknown) => (err ? next(err) : create().catch(next)));
    } else {
      await create();
    }
  });
  router.post('/upload', c.limiters.upload, upload, async (req, res) => {
    const fields = UploadJobTargetFields.parse(req.body ?? {});
    res
      .status(201)
      .json({ data: await c.inputs.uploadJobTarget(requireAuth(req).userId, req.file!, fields) });
  });
  router.get('/', async (req, res) => {
    res.json({ data: await c.inputs.listJobTargets(requireAuth(req).userId) });
  });
  router.get('/:id', async (req, res) => {
    res.json({ data: await c.inputs.getJobTarget(requireAuth(req).userId, String(req.params.id)) });
  });
  router.get('/:id/status', async (req, res) => {
    const target = await c.inputs.getJobTarget(requireAuth(req).userId, String(req.params.id));
    res.json({ data: target.extraction });
  });
  return router;
}

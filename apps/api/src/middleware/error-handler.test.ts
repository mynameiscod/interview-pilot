import { createLogger, type ErrorTracker } from '@cbi/config';
import express from 'express';
import { pinoHttp } from 'pino-http';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { AppError } from '../lib/errors.js';
import { createErrorHandler } from './error-handler.js';

function appWith(tracker: ErrorTracker, err: unknown) {
  const app = express();
  app.use(pinoHttp({ logger: createLogger({ service: 'test', level: 'silent' }) }));
  const router = express.Router();
  router.get('/:id', () => {
    throw err;
  });
  app.use('/things', router);
  app.use(createErrorHandler(tracker));
  return app;
}

const tracker = () => ({ enabled: true, captureException: vi.fn(), flush: vi.fn() });

describe('createErrorHandler', () => {
  it('reports unexpected errors with the route pattern and request id', async () => {
    const t = tracker();
    const res = await request(appWith(t, new Error('boom')))
      .get('/things/42')
      .expect(500);
    expect(res.body.error.code).toBe('INTERNAL_ERROR');
    expect(t.captureException).toHaveBeenCalledOnce();
    const [err, context] = t.captureException.mock.calls[0]!;
    expect((err as Error).message).toBe('boom');
    expect(context).toEqual({
      tags: { method: 'GET', route: '/things/:id' },
      extra: { requestId: res.body.error.requestId },
    });
  });

  it('does not report client errors or expected outages', async () => {
    const t = tracker();
    await request(appWith(t, AppError.notFound('nope')))
      .get('/things/1')
      .expect(404);
    await request(appWith(t, new AppError(503, 'JUDGE_UNAVAILABLE', 'later')))
      .get('/things/1')
      .expect(503);
    expect(t.captureException).not.toHaveBeenCalled();
  });
});

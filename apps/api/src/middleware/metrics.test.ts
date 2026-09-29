import { metricsRegistry } from '@cbi/config';
import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { httpMetrics, routeLabel } from './metrics.js';

describe('routeLabel', () => {
  it('uses the matched route pattern under its mount path', () => {
    expect(
      routeLabel({
        baseUrl: '/api/v1/interviews',
        route: { path: '/:id/turns' },
        originalUrl: '/api/v1/interviews/66f1c2a9b8e4d1a2b3c4d5e6/turns?x=1',
      }),
    ).toBe('/api/v1/interviews/:id/turns');
    expect(
      routeLabel({ baseUrl: '/api/v1/plans', route: { path: '/' }, originalUrl: '/api/v1/plans' }),
    ).toBe('/api/v1/plans');
  });

  it('replaces ids in mount paths, also after the router was left', () => {
    expect(
      routeLabel({
        baseUrl: '',
        route: { path: '/links' },
        originalUrl: '/api/v1/admin/campaigns/66f1c2a9b8e4d1a2b3c4d5e6/links',
      }),
    ).toBe('/api/v1/admin/campaigns/:id/links');
  });

  it('collapses unmatched requests', () => {
    expect(routeLabel({ baseUrl: '', route: undefined, originalUrl: '/x' })).toBe('unmatched');
    expect(routeLabel({ baseUrl: '/api/v1/admin', route: undefined, originalUrl: '/x' })).toBe(
      '/api/v1/admin/*',
    );
  });
});

describe('httpMetrics', () => {
  it('observes latency with the route pattern and status', async () => {
    const app = express();
    app.use(httpMetrics());
    const router = express.Router();
    router.get('/:id', (_req, res) => {
      res.status(204).end();
    });
    app.use('/things', router);
    await request(app).get('/things/66f1c2a9b8e4d1a2b3c4d5e6').expect(204);
    const text = await metricsRegistry.getSingleMetricAsString('cbi_http_request_duration_seconds');
    expect(text).toContain(
      'cbi_http_request_duration_seconds_count{method="GET",route="/things/:id",status_code="204"} 1',
    );
    expect(text).not.toContain('66f1c2a9b8e4d1a2b3c4d5e6');
  });
});

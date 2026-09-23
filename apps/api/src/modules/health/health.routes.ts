import type { LivenessResponse } from '@cbi/shared-types';
import { Router } from 'express';
import { checkReadiness, type ReadinessOptions } from '@cbi/config';

export interface HealthRouterOptions extends ReadinessOptions {
  service: string;
  version: string;
}

/**
 * `/healthz` — liveness: the process is up and serving. No dependency calls.
 * `/readyz`  — readiness: dependencies reachable and not draining. Used by
 *              NGINX/blue-green switching; returns 503 when not ready.
 */
export function healthRouter(opts: HealthRouterOptions): Router {
  const router = Router();

  router.get('/healthz', (_req, res) => {
    const body: LivenessResponse = {
      status: 'ok',
      service: opts.service,
      version: opts.version,
      uptimeSec: Math.round(process.uptime()),
    };
    res.set('Cache-Control', 'no-store').json(body);
  });

  router.get('/readyz', async (_req, res) => {
    const result = await checkReadiness(opts);
    res
      .status(result.status === 'ready' ? 200 : 503)
      .set('Cache-Control', 'no-store')
      .json(result);
  });

  return router;
}

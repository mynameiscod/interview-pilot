import { createServer, type Server } from 'node:http';
import { checkReadiness, type ReadinessOptions } from '@cbi/config';

/**
 * Minimal HTTP health endpoint for Docker/orchestrator probes. Bound inside
 * the private container network only; never published through NGINX.
 */
export function createHealthServer(opts: ReadinessOptions & { version: string }): Server {
  return createServer((req, res) => {
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(body));
    };
    if (req.method === 'GET' && req.url === '/healthz') {
      send(200, {
        status: 'ok',
        service: 'worker',
        version: opts.version,
        uptimeSec: Math.round(process.uptime()),
      });
      return;
    }
    if (req.method === 'GET' && req.url === '/readyz') {
      checkReadiness(opts).then(
        (result) => send(result.status === 'ready' ? 200 : 503, result),
        () => send(503, { status: 'not_ready', env: opts.env, checks: {} }),
      );
      return;
    }
    send(404, { error: { code: 'NOT_FOUND', message: 'Not found' } });
  });
}

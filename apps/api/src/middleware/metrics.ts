import { httpRequestDuration } from '@cbi/config';
import type { Request, RequestHandler } from 'express';

// Path segments that are ids, not routes: ObjectIds, UUIDs, numbers and long tokens.
const ID_SEGMENT =
  /\/(?:[0-9a-f]{24}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|\d+|[A-Za-z0-9_-]{32,})(?=\/|$)/gi;

/**
 * The route pattern for the latency histogram, e.g. `/api/v1/interviews/:id`.
 * `req.baseUrl` is reset once a request leaves its router (errors reach the
 * app-level handler with an empty one), so the mount prefix is taken from the
 * URL instead: all but the route's own segments. Id-like segments in it are
 * replaced as well, because the label set must stay small.
 */
export function routeLabel(req: Pick<Request, 'baseUrl' | 'route' | 'originalUrl'>): string {
  const routePath = (req.route as { path?: unknown } | undefined)?.path;
  if (typeof routePath !== 'string') {
    return req.baseUrl ? `${req.baseUrl.replace(ID_SEGMENT, '/:id')}/*` : 'unmatched';
  }
  const urlSegments = (req.originalUrl ?? '').split('?')[0]!.split('/').filter(Boolean);
  const routeSegments = routePath.split('/').filter(Boolean);
  const prefix = urlSegments.slice(0, Math.max(0, urlSegments.length - routeSegments.length));
  const full = `/${[...prefix, ...routeSegments].join('/')}`;
  return full.replace(ID_SEGMENT, '/:id');
}

/** Records every response in `cbi_http_request_duration_seconds`. */
export function httpMetrics(): RequestHandler {
  return (req, res, next) => {
    const end = httpRequestDuration.startTimer();
    res.once('finish', () => {
      end({ method: req.method, route: routeLabel(req), status_code: String(res.statusCode) });
    });
    next();
  };
}

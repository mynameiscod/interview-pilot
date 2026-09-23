import cors from 'cors';
import type { RequestHandler } from 'express';
import { AppError } from '../lib/errors.js';

/**
 * Strict CORS allowlist. Requests that carry an `Origin` header from outside
 * the allowlist are rejected outright rather than merely missing CORS headers,
 * which also closes the cross-site request path for cookie-bearing endpoints.
 * Server-to-server callers (e.g. payment webhooks) send no Origin and pass.
 */
export function originGuard(allowedOrigins: readonly string[]): RequestHandler[] {
  const allowed = new Set(allowedOrigins);

  const reject: RequestHandler = (req, _res, next) => {
    const origin = req.headers.origin;
    if (origin !== undefined && !allowed.has(origin)) {
      next(new AppError(403, 'ORIGIN_NOT_ALLOWED', 'Origin not allowed'));
      return;
    }
    next();
  };

  const corsHandler = cors({
    origin: (origin, cb) => cb(null, origin !== undefined && allowed.has(origin)),
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-Id', 'X-CB-CSRF'],
    exposedHeaders: ['X-Request-Id'],
    maxAge: 600,
  });

  return [reject, corsHandler];
}

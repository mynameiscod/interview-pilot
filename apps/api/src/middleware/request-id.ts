import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { REQUEST_ID_HEADER } from '@cbi/shared-types';

const SAFE_ID = /^[A-Za-z0-9._-]{8,128}$/;

/**
 * Reuses a well-formed upstream request id (e.g. from NGINX) so logs can be
 * correlated end to end; otherwise generates one. Always echoes it back.
 */
export function resolveRequestId(req: IncomingMessage, res: ServerResponse): string {
  const incoming = req.headers[REQUEST_ID_HEADER];
  const candidate = Array.isArray(incoming) ? incoming[0] : incoming;
  const id = candidate && SAFE_ID.test(candidate) ? candidate : randomUUID();
  res.setHeader(REQUEST_ID_HEADER, id);
  return id;
}

import type { Request } from 'express';

export interface ClientContext {
  requestId: string;
  ip: string;
  userAgent: string;
}

export function clientContext(req: Request): ClientContext {
  return {
    requestId: String(req.id),
    ip: req.ip ?? 'unknown',
    userAgent: (req.get('user-agent') ?? '').slice(0, 200),
  };
}

import { keyedHash } from '@cbi/auth-core';
import type { Logger } from '@cbi/config';
import { AuditLogModel } from '@cbi/db';
import type { AuditActorType } from '@cbi/shared-types';
import type { ClientSession } from 'mongoose';
import type { ClientContext } from './request-context.js';

export interface AuditEvent {
  actorType: AuditActorType;
  actorId?: string | null;
  action: string;
  resourceType?: string;
  resourceId?: string;
  outcome?: 'SUCCESS' | 'FAILURE';
  /** Must already be free of secrets, OTPs, tokens and full contact details. */
  details?: Record<string, unknown>;
}

export interface AuditService {
  record(event: AuditEvent, ctx?: Partial<ClientContext>, session?: ClientSession): Promise<void>;
}

/**
 * Writes to the append-only `auditLogs` collection. Inside a transaction a
 * failed write aborts the transaction (admin mutations must be audited).
 * Outside one, the failure is logged and the request continues, so an audit
 * outage cannot lock everyone out of signing in.
 */
export function createAuditService(opts: { hashSecret: string; logger: Logger }): AuditService {
  return {
    async record(event, ctx, session) {
      const doc = {
        at: new Date(),
        actorType: event.actorType,
        actorId: event.actorId ?? undefined,
        action: event.action,
        resourceType: event.resourceType,
        resourceId: event.resourceId,
        outcome: event.outcome ?? 'SUCCESS',
        requestId: ctx?.requestId,
        ipHash: ctx?.ip ? keyedHash(opts.hashSecret, `ip:${ctx.ip}`) : undefined,
        details: event.details,
      };
      try {
        await AuditLogModel.create([doc], session ? { session } : {});
      } catch (err) {
        if (session) throw err;
        opts.logger.error({ err, action: event.action }, 'audit write failed');
      }
    },
  };
}

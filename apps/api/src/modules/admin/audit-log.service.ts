import type { Writable } from 'node:stream';
import { AuditLogModel, mongoose, type AuditLogRecord } from '@cbi/db';
import type {
  AuditActorType,
  AuditLogEntry,
  AuditLogExportQuery,
  AuditLogPage,
  AuditLogQuery,
} from '@cbi/shared-types';
import type { AuditService } from '../../lib/audit.js';
import { CSV_BOM, csvLine } from '../../lib/csv.js';
import { AppError } from '../../lib/errors.js';
import type { ClientContext } from '../../lib/request-context.js';
import { transaction } from '../../lib/transaction.js';

type Filters = AuditLogExportQuery & { before?: string };

/** The MongoDB filter for the audit log view and export (ids validated first). */
export function auditLogFilter(query: Filters): Record<string, unknown> {
  for (const [field, value] of [
    ['actorId', query.actorId],
    ['before', query.before],
  ] as const) {
    if (value && !mongoose.isValidObjectId(value)) {
      throw AppError.validation(`Invalid ${field}`);
    }
  }
  const filter: Record<string, unknown> = {};
  if (query.action) filter.action = query.action;
  if (query.actorId) filter.actorId = new mongoose.Types.ObjectId(query.actorId);
  if (query.resourceId) filter.resourceId = query.resourceId;
  if (query.from || query.to) {
    filter.at = {
      ...(query.from ? { $gte: new Date(query.from) } : {}),
      ...(query.to ? { $lt: new Date(query.to) } : {}),
    };
  }
  if (query.before) filter._id = { $lt: new mongoose.Types.ObjectId(query.before) };
  return filter;
}

/** Resolves when a full stream can take more, or has closed (listeners removed either way). */
function drainedOrClosed(out: Writable) {
  return new Promise<void>((resolve) => {
    const done = () => {
      out.off('drain', done);
      out.off('close', done);
      resolve();
    };
    out.on('drain', done);
    out.on('close', done);
  });
}

type AuditRow = AuditLogRecord & { _id: mongoose.Types.ObjectId };

function toEntry(r: AuditRow): AuditLogEntry {
  return {
    id: String(r._id),
    at: r.at.toISOString(),
    actorType: r.actorType as AuditActorType,
    actorId: r.actorId ? String(r.actorId) : null,
    action: r.action,
    resourceType: r.resourceType ?? null,
    resourceId: r.resourceId ?? null,
    outcome: r.outcome as 'SUCCESS' | 'FAILURE',
    requestId: r.requestId ?? null,
    details: (r.details as Record<string, unknown> | undefined) ?? null,
  };
}

export const AUDIT_CSV_HEADER = [
  'id',
  'at',
  'actorType',
  'actorId',
  'action',
  'resourceType',
  'resourceId',
  'outcome',
  'requestId',
  'details',
] as const;

/** One audit entry as a CSV line (formula-like text neutralised; details as JSON). */
export function auditCsvLine(e: AuditLogEntry): string {
  return csvLine([
    e.id,
    e.at,
    e.actorType,
    e.actorId,
    e.action,
    e.resourceType,
    e.resourceId,
    e.outcome,
    e.requestId,
    e.details ? JSON.stringify(e.details) : null,
  ]);
}

/** The security and admin audit trail (Admin → Audit log). */
export function createAuditLogService(deps: { audit: AuditService }) {
  return {
    async list(query: AuditLogQuery): Promise<AuditLogPage> {
      const rows = await AuditLogModel.find(auditLogFilter(query))
        .sort({ _id: -1 })
        .limit(query.limit + 1)
        .lean<AuditRow[]>();
      const page = rows.slice(0, query.limit);
      return {
        items: page.map(toEntry),
        nextCursor: rows.length > query.limit ? String(page[page.length - 1]!._id) : null,
      };
    },

    /**
     * Records the export (it is refused if it cannot be audited), then streams
     * every matching entry as CSV straight from a cursor, newest first, so the
     * log is never held in memory. Honours back-pressure and stops the cursor
     * if the client goes away.
     */
    async exportCsv(
      query: AuditLogExportQuery,
      out: Writable,
      actorId: string,
      ctx: ClientContext,
      onStart: () => void,
    ) {
      const filter = auditLogFilter(query);
      await transaction((tx) =>
        deps.audit.record(
          {
            actorType: 'ADMIN',
            actorId,
            action: 'audit.exported',
            resourceType: 'auditLog',
            details: { format: 'csv', filters: query },
          },
          ctx,
          tx,
        ),
      );
      const cursor = AuditLogModel.find(filter).sort({ _id: -1 }).lean<AuditRow[]>().cursor();
      let closed = false;
      const stop = () => {
        closed = true;
      };
      out.once('close', stop);
      onStart();
      let rows = 0;
      try {
        out.write(CSV_BOM + csvLine(AUDIT_CSV_HEADER));
        for await (const row of cursor) {
          if (closed) break;
          rows += 1;
          if (!out.write(auditCsvLine(toEntry(row as AuditRow)))) {
            await drainedOrClosed(out);
          }
        }
      } finally {
        out.off('close', stop);
        await cursor.close();
      }
      if (!closed) out.end();
      return { rows };
    },
  };
}

export type AuditLogService = ReturnType<typeof createAuditLogService>;

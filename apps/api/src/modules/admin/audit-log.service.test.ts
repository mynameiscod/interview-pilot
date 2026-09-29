import { Writable } from 'node:stream';
import { mongoose } from '@cbi/db';
import type * as Db from '@cbi/db';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuditService } from '../../lib/audit.js';
import { AppError } from '../../lib/errors.js';

const db = vi.hoisted(() => ({
  rows: [] as Record<string, unknown>[],
  closed: 0,
  filters: [] as unknown[],
}));

vi.mock('../../lib/transaction.js', () => ({
  transaction: <T>(fn: (tx: unknown) => Promise<T>) => fn('tx'),
}));

vi.mock('@cbi/db', async (importOriginal) => {
  const actual = await importOriginal<typeof Db>();
  const cursor = () => ({
    async *[Symbol.asyncIterator]() {
      for (const row of db.rows) yield row;
    },
    close: async () => {
      db.closed += 1;
    },
  });
  return {
    ...actual,
    AuditLogModel: {
      find: (filter: unknown) => {
        db.filters.push(filter);
        return { sort: () => ({ lean: () => ({ cursor }) }) };
      },
    },
  };
});

const { auditCsvLine, auditLogFilter, createAuditLogService } =
  await import('./audit-log.service.js');

const id = () => new mongoose.Types.ObjectId();
const row = (i: number) => ({
  _id: id(),
  at: new Date(Date.UTC(2026, 0, 1, 0, 0, i)),
  actorType: 'ADMIN',
  actorId: id(),
  action: `a.${i}`,
  resourceType: 'thing',
  resourceId: i === 0 ? '=cmd|calc' : `r-${i}`,
  outcome: 'SUCCESS',
  requestId: null,
  details: { i },
});

/** A slow sink with a tiny buffer, so writes hit back-pressure. */
function slowSink() {
  const chunks: string[] = [];
  const sink = new Writable({
    highWaterMark: 8,
    write(chunk: Buffer, _enc, done) {
      chunks.push(chunk.toString('utf8'));
      setImmediate(done);
    },
  });
  return { sink, text: () => chunks.join('') };
}

const ctx = { requestId: 'req-1', ip: '127.0.0.1', userAgent: null } as never;

describe('audit log filters', () => {
  it('builds the time range, actor, resource, action and cursor filter', () => {
    const actor = String(id());
    const before = String(id());
    const f = auditLogFilter({
      action: 'flag.updated',
      actorId: actor,
      resourceId: 'r-1',
      from: '2026-01-01T00:00:00+05:30',
      to: '2026-02-01T00:00:00Z',
      before,
    });
    expect(f).toEqual({
      action: 'flag.updated',
      actorId: new mongoose.Types.ObjectId(actor),
      resourceId: 'r-1',
      at: { $gte: new Date('2025-12-31T18:30:00Z'), $lt: new Date('2026-02-01T00:00:00Z') },
      _id: { $lt: new mongoose.Types.ObjectId(before) },
    });
    expect(auditLogFilter({ to: '2026-02-01T00:00:00Z' })).toEqual({
      at: { $lt: new Date('2026-02-01T00:00:00Z') },
    });
    expect(auditLogFilter({})).toEqual({});
  });

  it('rejects ids that are not ObjectIds', () => {
    expect(() => auditLogFilter({ actorId: 'bogus' })).toThrow(AppError);
    expect(() => auditLogFilter({ before: 'bogus' })).toThrow(/Invalid before/);
  });

  it('writes one safe CSV line per entry', () => {
    const line = auditCsvLine({
      id: 'e1',
      at: '2026-01-01T00:00:00.000Z',
      actorType: 'USER',
      actorId: null,
      action: 'x',
      resourceType: null,
      resourceId: '+SUM(1)',
      outcome: 'FAILURE',
      requestId: 'r',
      details: { a: 'b,c' },
    });
    expect(line).toBe(
      `e1,2026-01-01T00:00:00.000Z,USER,,x,,'+SUM(1),FAILURE,r,"{""a"":""b,c""}"\r\n`,
    );
  });
});

describe('audit log export', () => {
  let audit: AuditService & { record: ReturnType<typeof vi.fn> };
  beforeEach(() => {
    db.rows = Array.from({ length: 50 }, (_, i) => row(i));
    db.closed = 0;
    db.filters = [];
    audit = { record: vi.fn(async () => undefined) };
  });

  it('audits the export first, then streams every row through back-pressure', async () => {
    const service = createAuditLogService({ audit });
    const { sink, text } = slowSink();
    const onStart = vi.fn();
    const finished = new Promise((r) => sink.on('finish', r));
    const result = await service.exportCsv(
      { from: '2026-01-01T00:00:00Z' },
      sink,
      'admin-1',
      ctx,
      onStart,
    );
    await finished;
    expect(result).toEqual({ rows: 50 });
    expect(onStart).toHaveBeenCalledOnce();
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        actorId: 'admin-1',
        action: 'audit.exported',
        details: { format: 'csv', filters: { from: '2026-01-01T00:00:00Z' } },
      }),
      ctx,
      'tx',
    );
    expect(db.filters).toEqual([{ at: { $gte: new Date('2026-01-01T00:00:00Z') } }]);
    const lines = text()
      .replace(/^\uFEFF/, '')
      .trimEnd()
      .split('\r\n');
    expect(lines).toHaveLength(51);
    expect(lines[0]).toBe(
      'id,at,actorType,actorId,action,resourceType,resourceId,outcome,requestId,details',
    );
    expect(lines[1]).toContain("'=cmd|calc");
    expect(db.closed).toBe(1);
  });

  it('streams nothing when the export cannot be audited', async () => {
    audit.record.mockRejectedValueOnce(new Error('audit down'));
    const service = createAuditLogService({ audit });
    const { sink, text } = slowSink();
    const onStart = vi.fn();
    await expect(service.exportCsv({}, sink, 'admin-1', ctx, onStart)).rejects.toThrow(
      'audit down',
    );
    expect(onStart).not.toHaveBeenCalled();
    expect(text()).toBe('');
    expect(db.filters).toEqual([]);
  });

  it('stops reading when the client goes away', async () => {
    const service = createAuditLogService({ audit });
    const { sink } = slowSink();
    const onStart = vi.fn(() => setImmediate(() => sink.destroy()));
    const result = await service.exportCsv({}, sink, 'admin-1', ctx, onStart);
    expect(result.rows).toBeLessThan(50);
    expect(db.closed).toBe(1);
  });
});

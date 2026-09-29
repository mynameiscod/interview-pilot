import { describe, expect, it } from 'vitest';
import { AuditLogExportQuery, AuditLogQuery } from './admin.js';

describe('audit log queries', () => {
  it('accepts a time range with offsets and defaults the page size', () => {
    expect(
      AuditLogQuery.parse({ from: '2026-09-01T00:00:00+05:30', to: '2026-09-02T00:00:00Z' }),
    ).toEqual({ from: '2026-09-01T00:00:00+05:30', to: '2026-09-02T00:00:00Z', limit: 50 });
  });

  it('rejects dates that are not instants and ranges that end before they start', () => {
    expect(AuditLogQuery.safeParse({ from: '2026-09-01' }).success).toBe(false);
    const backwards = { from: '2026-09-02T00:00:00Z', to: '2026-09-01T00:00:00Z' };
    expect(AuditLogQuery.safeParse(backwards).success).toBe(false);
    expect(AuditLogExportQuery.safeParse(backwards).success).toBe(false);
    expect(
      AuditLogExportQuery.safeParse({ from: '2026-09-01T00:00:00Z', to: '2026-09-01T00:00:00Z' })
        .success,
    ).toBe(false);
  });

  it('exports with the same filters but no paging', () => {
    expect(
      AuditLogExportQuery.parse({ action: 'flag.updated', actorId: 'a', limit: '5', before: 'x' }),
    ).toEqual({ action: 'flag.updated', actorId: 'a' });
  });
});

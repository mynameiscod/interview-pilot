import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLogger } from '@cbi/config';
import { createMemoryStorage } from '@cbi/provider-adapters/testing';
import type { CampaignResultRow } from '@cbi/shared-types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readZip } from '../exports/zip-writer.js';

/**
 * The processor against an in-memory stand-in for the database: what it
 * writes to storage and to the export record. (The real queries are covered
 * by the integration suite.)
 */
const db = vi.hoisted(() => ({
  claimed: null as Record<string, unknown> | null,
  campaign: null as Record<string, unknown> | null,
  total: 0,
  rows: [] as CampaignResultRow[],
  reports: [] as Record<string, unknown>[],
  updates: [] as { filter: unknown; update: Record<string, Record<string, unknown>> }[],
  failRows: false,
}));

vi.mock('@cbi/db', () => ({
  CAMPAIGN_EXPORT_STUCK_AFTER_MS: 6 * 3600_000,
  MAX_PACKAGE_ROWS: 3,
  CampaignExportModel: {
    findOneAndUpdate: () => ({ lean: async () => db.claimed }),
    updateOne: async (filter: unknown, update: Record<string, Record<string, unknown>>) => {
      db.updates.push({ filter, update });
      return { matchedCount: 1 };
    },
  },
  CampaignModel: { findById: () => ({ lean: async () => db.campaign }) },
  InterviewReportModel: {
    find: () => ({ sort: () => ({ lean: async () => db.reports }) }),
  },
  campaignDimensions: async () => [{ key: 'api-design', name: 'API design' }],
  countCampaignResults: async () => db.total,
  campaignSummary: (c: { name: string }) => ({ name: c.name }),
  campaignResultsCsv: async function* () {
    yield '﻿Name\r\n';
    for (const r of db.rows) yield `${r.candidate.name}\r\n`;
  },
  campaignResultRows: async function* () {
    for (const r of db.rows) yield r;
    if (db.failRows) throw new Error('cursor lost');
  },
}));

const { processCampaignPackage, reportEntryBase } = await import('./campaign-export.js');

const EXPORT_ID = '64b0000000000000000000e1';
const CAMPAIGN_ID = '64b000000000000000000001';
const logger = createLogger({ service: 'test', level: 'silent' });
const now = new Date('2026-09-29T10:00:00.000Z');

const row = (i: number, overrides: Partial<CampaignResultRow> = {}): CampaignResultRow => ({
  applicationId: `app${i}`,
  interviewId: `int${i}`,
  candidate: { userId: `u${i}`, name: `Candidate ${i}`, email: `c${i}@example.com` },
  status: 'COMPLETED',
  joinedAt: now.toISOString(),
  completedAt: now.toISOString(),
  overall: 70,
  band: 'READY',
  confidence: 'HIGH',
  scoreRevision: 0,
  dimensions: { 'api-design': 70 },
  flagged: false,
  ...overrides,
});

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'cbi-export-test-'));
  Object.assign(db, {
    claimed: { _id: EXPORT_ID, campaignId: CAMPAIGN_ID, status: 'RUNNING' },
    campaign: { _id: CAMPAIGN_ID, name: 'Globex hiring', blueprintId: 'b1' },
    total: 2,
    rows: [row(1), row(2), row(3, { interviewId: null })],
    reports: [],
    updates: [],
    failRows: false,
  });
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const lastSet = () => db.updates.at(-1)!.update.$set!;

describe('campaign package processor', () => {
  it('streams the CSV, settings and latest reports to storage and marks the export ready', async () => {
    const { storage, objects } = createMemoryStorage();
    await storage.put('reports/int1/0.pdf', Buffer.from('%PDF-1 report'), 'application/pdf');
    db.reports = [
      // Newest revision first: the processor keeps the first per interview.
      {
        sessionId: 'int1',
        revision: 1,
        content: { summary: 'revised' },
        pdf: { status: 'READY', storageKey: 'reports/int1/0.pdf' },
      },
      {
        sessionId: 'int1',
        revision: 0,
        content: { summary: 'original' },
        pdf: { status: 'READY', storageKey: 'reports/int1/0.pdf' },
      },
      // The PDF is missing from storage: the JSON is still included.
      {
        sessionId: 'int2',
        revision: 0,
        content: { summary: 'two' },
        pdf: { status: 'READY', storageKey: 'reports/int2/gone.pdf' },
      },
    ];
    const outcome = await processCampaignPackage(
      { storage, logger, retentionHours: 24, tmpDir: dir, now: () => now },
      EXPORT_ID,
      false,
    );
    expect(outcome).toBe('ready');

    const key = `exports/campaigns/${CAMPAIGN_ID}/${EXPORT_ID}.zip`;
    const stored = objects.get(key)!;
    expect(stored.contentType).toBe('application/zip');
    const files = readZip(stored.body);
    expect([...files.keys()]).toEqual([
      'results.csv',
      'campaign.json',
      'reports/candidate-1-int1.json',
      'reports/candidate-1-int1.pdf',
      'reports/candidate-2-int2.json',
    ]);
    expect(files.get('results.csv')!.toString()).toContain('Candidate 3');
    expect(JSON.parse(files.get('reports/candidate-1-int1.json')!.toString())).toEqual({
      revision: 1,
      summary: 'revised',
    });
    expect(files.get('reports/candidate-1-int1.pdf')!.toString()).toBe('%PDF-1 report');

    expect(lastSet()).toMatchObject({
      status: 'READY',
      storageKey: key,
      sizeBytes: stored.body.length,
      progress: { done: 3, total: 3 },
      expiresAt: new Date(now.getTime() + 24 * 3600_000),
    });
    // The spool file is gone.
    expect(await readdir(dir)).toEqual([]);
  });

  it('refuses campaigns over the package limit without retrying', async () => {
    db.total = 4;
    const { storage, objects } = createMemoryStorage();
    const outcome = await processCampaignPackage(
      { storage, logger, retentionHours: 24, tmpDir: dir },
      EXPORT_ID,
      false,
    );
    expect(outcome).toBe('failed');
    expect(lastSet()).toMatchObject({ status: 'FAILED', error: expect.stringContaining('3') });
    expect(objects.size).toBe(0);
  });

  it('skips exports that are no longer queued or running', async () => {
    db.claimed = null;
    const { storage } = createMemoryStorage();
    await expect(
      processCampaignPackage({ storage, logger, retentionHours: 24 }, EXPORT_ID, true),
    ).resolves.toBe('skipped');
    expect(db.updates).toEqual([]);
  });

  it('marks the export failed on the last attempt and cleans up the spool file', async () => {
    db.failRows = true;
    const { storage, objects } = createMemoryStorage();
    const deps = { storage, logger, retentionHours: 24, tmpDir: dir };
    await expect(processCampaignPackage(deps, EXPORT_ID, false)).rejects.toThrow('cursor lost');
    expect(db.updates.some((u) => u.update.$set?.status === 'FAILED')).toBe(false);
    await expect(processCampaignPackage(deps, EXPORT_ID, true)).rejects.toThrow('cursor lost');
    expect(lastSet()).toMatchObject({ status: 'FAILED' });
    expect(objects.size).toBe(0);
    expect(await readdir(dir)).toEqual([]);
  });

  it('names report files after the candidate', () => {
    expect(
      reportEntryBase(row(1, { candidate: { userId: 'u', name: 'ప్రియ', email: null } })),
    ).toBe('reports/candidate-int1');
    expect(
      reportEntryBase(row(1, { candidate: { userId: 'u', name: null, email: 'Ravi.K@x.com' } })),
    ).toBe('reports/ravi-k-x-com-int1');
  });
});

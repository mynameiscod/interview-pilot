import { Types } from 'mongoose';
import { describe, expect, it } from 'vitest';
import {
  applicationStatus,
  campaignResultsPipeline,
  csvCell,
  resultsCsvHeader,
  resultsCsvLine,
  toResultRow,
  type CampaignResultDoc,
} from './campaign-results.js';

const campaignId = new Types.ObjectId();
const KEYS = ['api-design', 'debugging'];
const DIMENSIONS = [
  { key: 'api-design', name: 'API design' },
  { key: 'debugging', name: 'Debugging' },
];

/** The stages after the joins: filters (if any), then the sort. */
const tail = (stages: ReturnType<typeof campaignResultsPipeline>) => stages.slice(5);

describe('campaign results pipeline', () => {
  it('scopes to the campaign and joins the interview and its latest score', () => {
    const stages = campaignResultsPipeline(campaignId, KEYS, {});
    expect(stages[0]).toEqual({ $match: { campaignId } });
    const scoreLookup = (stages[2] as { $lookup: { pipeline: unknown[] } }).$lookup;
    expect(scoreLookup.pipeline.slice(0, 2)).toEqual([{ $sort: { revision: -1 } }, { $limit: 1 }]);
    // No filters: straight to the default order, best first.
    expect(tail(stages)).toEqual([{ $sort: { rank: -1, joinedAt: 1, _id: 1 } }]);
  });

  it('pushes status, overall and dimension filters into one match', () => {
    const stages = campaignResultsPipeline(campaignId, KEYS, {
      status: 'COMPLETED',
      minOverall: 70,
      dimension: 'debugging:60',
      sort: 'joined_desc',
    });
    expect(tail(stages)).toEqual([
      {
        $match: {
          status: 'COMPLETED',
          overall: { $ne: null, $gte: 70 },
          'score.dimensions': {
            $elemMatch: { key: 'debugging', score: { $ne: null, $gte: 60 } },
          },
        },
      },
      { $sort: { joinedAt: -1, _id: -1 } },
    ]);
  });

  it('matches nothing for a dimension outside the pinned blueprint', () => {
    const stages = campaignResultsPipeline(campaignId, KEYS, { dimension: 'cooking:10' });
    expect(stages.at(-1)).toEqual({ $match: { $expr: false } });
  });

  it('keeps unscored candidates last in both score orders', () => {
    expect(tail(campaignResultsPipeline(campaignId, KEYS, { sort: 'overall_asc' }))).toEqual([
      { $sort: { scored: -1, rank: 1, joinedAt: 1, _id: 1 } },
    ]);
  });

  it('maps interview states to application statuses', () => {
    expect(applicationStatus('READY')).toBe('JOINED');
    expect(applicationStatus('IN_PROGRESS' as never)).toBe('IN_PROGRESS');
    expect(applicationStatus('REPORT_READY')).toBe('COMPLETED');
    expect(applicationStatus('EXPIRED')).toBe('DID_NOT_FINISH');
  });
});

describe('result rows', () => {
  const joinedAt = new Date('2026-09-01T10:00:00.000Z');
  const doc = (overrides: Partial<CampaignResultDoc> = {}): CampaignResultDoc => ({
    _id: new Types.ObjectId(),
    userId: new Types.ObjectId(),
    joinedAt,
    status: 'COMPLETED',
    session: {
      _id: new Types.ObjectId(),
      endedAt: new Date('2026-09-01T11:00:00.000Z'),
      review: { flagged: true },
    },
    score: {
      revision: 1,
      overall: 72,
      band: 'READY_WITH_GAPS',
      confidence: { level: 'HIGH' },
      dimensions: [{ key: 'api-design', score: 80 }],
    },
    user: [{ primaryEmail: 'asha@example.com' }],
    profile: [{ displayName: 'Asha Rao' }],
    ...overrides,
  });

  it('maps a joined document to a grid row with every blueprint dimension', () => {
    const d = doc();
    expect(toResultRow(d, DIMENSIONS)).toEqual({
      applicationId: String(d._id),
      interviewId: String(d.session!._id),
      candidate: { userId: String(d.userId), name: 'Asha Rao', email: 'asha@example.com' },
      status: 'COMPLETED',
      joinedAt: '2026-09-01T10:00:00.000Z',
      completedAt: '2026-09-01T11:00:00.000Z',
      overall: 72,
      band: 'READY_WITH_GAPS',
      confidence: 'HIGH',
      scoreRevision: 1,
      dimensions: { 'api-design': 80, debugging: null },
      flagged: true,
      stage: 'NEW',
    });
  });

  it('handles candidates without an interview, score or profile', () => {
    const row = toResultRow(
      doc({ status: 'DID_NOT_FINISH', session: null, score: null, user: [], profile: [] }),
      DIMENSIONS,
    );
    expect(row).toMatchObject({
      interviewId: null,
      candidate: { name: null, email: null },
      completedAt: null,
      overall: null,
      scoreRevision: null,
      dimensions: { 'api-design': null, debugging: null },
      flagged: false,
    });
  });
});

describe('results CSV', () => {
  it('quotes cells and neutralises spreadsheet formulas', () => {
    expect(csvCell(null)).toBe('');
    expect(csvCell(72)).toBe('72');
    expect(csvCell('Rao, Asha')).toBe('"Rao, Asha"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
    expect(csvCell('-1+2')).toBe("'-1+2");
    // Numbers are data, not formulas.
    expect(csvCell(-1)).toBe('-1');
  });

  it('writes a BOM header and CRLF rows in column order', () => {
    const header = resultsCsvHeader(DIMENSIONS);
    expect(header.charCodeAt(0)).toBe(0xfeff);
    expect(header.slice(1)).toBe(
      'Name,Email,Status,Joined,Completed,Overall,Band,Confidence,Score revision,Flagged,API design,Debugging,Interview id\r\n',
    );
    const line = resultsCsvLine(
      {
        applicationId: 'a1',
        interviewId: 'i1',
        candidate: { userId: 'u1', name: '@admin', email: 'a@example.com' },
        status: 'COMPLETED',
        joinedAt: '2026-09-01T10:00:00.000Z',
        completedAt: null,
        overall: 72,
        band: 'READY',
        confidence: 'HIGH',
        scoreRevision: 0,
        dimensions: { 'api-design': 80, debugging: null },
        flagged: false,
        stage: 'NEW',
      },
      DIMENSIONS,
    );
    expect(line).toBe(
      "'@admin,a@example.com,COMPLETED,2026-09-01T10:00:00.000Z,,72,READY,HIGH,0,no,80,,i1\r\n",
    );
  });
});

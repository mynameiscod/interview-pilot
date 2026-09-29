import { Types } from 'mongoose';
import { describe, expect, it } from 'vitest';
import { campaignResultsPipeline } from './campaign-results.js';
import { identityImageKey } from './identity.js';
import {
  aggregateCohort,
  cohortCsvLines,
  matchesTags,
  type CohortAttempt,
} from './org-analytics.js';
import {
  identityStatus,
  orgResultsCsvHeader,
  orgResultsCsvLine,
  toOrgResultRow,
} from './org-results.js';
import {
  signWebhookBody,
  verifyWebhookSignature,
  WEBHOOK_MAX_ATTEMPTS,
  webhookBackoffMs,
  webhookBody,
  webhookSignatureHeader,
} from './org-webhooks.js';

const campaignId = new Types.ObjectId();
const KEYS = ['api-design'];
const DIMENSIONS = [{ key: 'api-design', name: 'API design' }];

describe('org results pipeline', () => {
  it('admits only candidates who agreed to share, with their scorecard average', () => {
    const stages = campaignResultsPipeline(
      campaignId,
      KEYS,
      { stage: 'SHORTLISTED' },
      {
        minScorecard: 3.5,
      },
    );
    const sessionLookup = (stages[1] as { $lookup: { pipeline: { $project: object }[] } }).$lookup;
    expect(sessionLookup.pipeline[0]!.$project).toHaveProperty('consents', 1);
    const scorecards = stages.find(
      (s) => '$lookup' in s && (s.$lookup as { as: string }).as === 'scorecardDocs',
    );
    expect(scorecards).toBeDefined();
    expect(stages.at(-2)).toEqual({
      $match: {
        'session.consents': { $elemMatch: { type: 'CAMPAIGN_SHARING', accepted: true } },
        scorecardAverage: { $ne: null, $gte: 3.5 },
        stage: 'SHORTLISTED',
      },
    });
  });

  it('leaves the admin grid unfiltered by consent', () => {
    const stages = campaignResultsPipeline(campaignId, KEYS, { stage: 'HIRED' });
    expect(JSON.stringify(stages)).not.toContain('CAMPAIGN_SHARING');
    expect(stages.at(-2)).toEqual({ $match: { stage: 'HIRED' } });
  });

  it('maps pipeline data onto the row', () => {
    const row = toOrgResultRow(
      {
        _id: new Types.ObjectId(),
        userId: new Types.ObjectId(),
        joinedAt: new Date('2026-09-01T10:00:00.000Z'),
        status: 'COMPLETED',
        stage: 'SHORTLISTED',
        session: null,
        score: null,
        scorecardAverage: 4.25,
        scorecards: 2,
        notesCount: [{ n: 3 }],
        invite: [{ tags: { batch: '2026', branch: 'CSE', year: 2026 } }],
        identity: [{ images: { SELFIE: {}, ID_DOCUMENT: {} }, decision: null }],
      },
      DIMENSIONS,
    );
    expect(row).toMatchObject({
      stage: 'SHORTLISTED',
      scorecardAverage: 4.25,
      scorecards: 2,
      notes: 3,
      tags: { batch: '2026', branch: 'CSE', year: 2026 },
      identity: 'CAPTURED',
    });
  });

  it('derives the identity check state', () => {
    expect(identityStatus(undefined)).toBe('NONE');
    expect(identityStatus({ images: { SELFIE: {} } })).toBe('NONE');
    expect(identityStatus({ images: {}, decision: { decision: 'MISMATCH' } })).toBe('MISMATCH');
    expect(identityStatus({ images: {}, decision: { decision: 'VERIFIED' } })).toBe('VERIFIED');
  });

  it('writes the org CSV with stage, scorecards and cohort tags', () => {
    expect(orgResultsCsvHeader(DIMENSIONS).slice(1)).toBe(
      'Name,Email,Status,Stage,Joined,Completed,Overall,Band,Confidence,API design,Scorecard average,Scorecards,Batch,Branch,Year,Identity,Application id\r\n',
    );
    const line = orgResultsCsvLine(
      {
        applicationId: 'a1',
        interviewId: 'i1',
        candidate: { userId: 'u1', name: '=cmd', email: 'a@example.com' },
        status: 'COMPLETED',
        joinedAt: '2026-09-01T10:00:00.000Z',
        completedAt: null,
        overall: 70,
        band: 'READY',
        confidence: 'HIGH',
        scoreRevision: 0,
        dimensions: { 'api-design': 80 },
        flagged: false,
        stage: 'HIRED',
        scorecardAverage: 4.5,
        scorecards: 2,
        notes: 0,
        tags: null,
        identity: 'VERIFIED',
      },
      DIMENSIONS,
    );
    expect(line).toBe(
      "'=cmd,a@example.com,COMPLETED,HIRED,2026-09-01T10:00:00.000Z,,70,READY,HIGH,80,4.5,2,,,,VERIFIED,a1\r\n",
    );
  });
});

describe('cohort analytics', () => {
  const at = (day: number) => new Date(Date.UTC(2026, 8, day));
  const attempt = (overrides: Partial<CohortAttempt>): CohortAttempt => ({
    userId: 'u1',
    joinedAt: at(1),
    consented: true,
    completed: true,
    overall: 50,
    band: 'DEVELOPING',
    dimensions: [{ key: 'api', name: 'API', score: 50 }],
    tags: { batch: '2026', branch: 'CSE', year: 2026 },
    ...overrides,
  });

  it('measures participation, bands, dimensions and improvement on latest attempts', () => {
    const result = aggregateCohort(
      [
        attempt({ userId: 'u1', joinedAt: at(1), overall: 40 }),
        attempt({
          userId: 'u1',
          joinedAt: at(9),
          overall: 70,
          band: 'READY_WITH_GAPS',
          dimensions: [{ key: 'api', name: 'API', score: 80 }],
        }),
        attempt({ userId: 'u2', joinedAt: at(2), overall: 60, band: 'READY_WITH_GAPS' }),
        attempt({ userId: 'u2', joinedAt: at(3), overall: 55, band: 'DEVELOPING' }),
        attempt({ userId: 'u3', overall: null, band: null, dimensions: [], completed: false }),
        // Not shared with the college: counted as joined only.
        attempt({ userId: 'u4', consented: false, overall: 99 }),
      ],
      10,
    );
    expect(result.participation).toEqual({ invited: 10, joined: 6, completed: 5, rate: 0.5 });
    expect(result.bands).toEqual([
      { band: 'READY_WITH_GAPS', count: 1 },
      { band: 'DEVELOPING', count: 1 },
    ]);
    expect(result.dimensions).toEqual([{ key: 'api', name: 'API', average: 65, count: 2 }]);
    expect(result.improvement).toEqual({
      students: 2,
      averageDelta: 12.5,
      improved: 1,
      declined: 1,
    });
    expect(
      result.students.map((s) => [s.userId, s.firstOverall, s.latestOverall, s.improvement]),
    ).toEqual([
      ['u1', 40, 70, 30],
      ['u2', 60, 55, -5],
      ['u3', null, null, null],
    ]);
    expect(result.students.some((s) => s.userId === 'u4')).toBe(false);
  });

  it('has no rate without invites', () => {
    expect(aggregateCohort([], 0).participation.rate).toBeNull();
  });

  it('filters by batch, branch and year', () => {
    const tags = { batch: '2026', branch: 'CSE', year: 2026 };
    expect(matchesTags(tags, { branch: 'CSE', year: 2026 })).toBe(true);
    expect(matchesTags(tags, { branch: 'ECE' })).toBe(false);
    expect(matchesTags(null, {})).toBe(true);
    expect(matchesTags(null, { batch: '2026' })).toBe(false);
  });

  it('writes the cohort report CSV', () => {
    const analytics = {
      ...aggregateCohort([attempt({ userId: 'u1' })], 1),
      tagValues: { batch: [], branch: [], year: [] },
    };
    analytics.students[0]!.name = 'Asha, R';
    const [header, row] = cohortCsvLines(analytics);
    expect(header!.slice(1)).toBe(
      'Name,Email,Batch,Branch,Year,Attempts,First overall,Latest overall,Improvement,Latest band\r\n',
    );
    expect(row).toBe('"Asha, R",,2026,CSE,2026,1,50,50,,DEVELOPING\r\n');
  });
});

describe('webhook signatures', () => {
  const secret = 'whsec_test_secret';
  const now = new Date('2026-09-29T10:00:00.000Z');

  it('signs `<timestamp>.<body>` with HMAC-SHA256 and verifies it', () => {
    const body = webhookBody('candidate.stage_changed', { applicationId: 'a1' }, now);
    const header = webhookSignatureHeader(secret, body, now);
    const t = Math.floor(now.getTime() / 1000);
    expect(header).toBe(`t=${t},v1=${signWebhookBody(secret, t, body)}`);
    expect(signWebhookBody(secret, t, body)).toMatch(/^[0-9a-f]{64}$/);
    expect(verifyWebhookSignature(secret, header, body, now)).toBe(true);
    expect(JSON.parse(body)).toMatchObject({
      event: 'candidate.stage_changed',
      createdAt: now.toISOString(),
      data: { applicationId: 'a1' },
    });
  });

  it('rejects a changed body, another secret or an old timestamp', () => {
    const body = '{"a":1}';
    const header = webhookSignatureHeader(secret, body, now);
    expect(verifyWebhookSignature(secret, header, '{"a":2}', now)).toBe(false);
    expect(verifyWebhookSignature('other', header, body, now)).toBe(false);
    expect(verifyWebhookSignature(secret, header, body, new Date(now.getTime() + 301_000))).toBe(
      false,
    );
    expect(verifyWebhookSignature(secret, 'garbage', body, now)).toBe(false);
  });

  it('backs off between retries, capped at six hours', () => {
    expect(webhookBackoffMs(1)).toBe(30_000);
    expect(webhookBackoffMs(2)).toBe(120_000);
    expect(webhookBackoffMs(WEBHOOK_MAX_ATTEMPTS)).toBe(6 * 3600_000);
    expect(webhookBackoffMs(50)).toBe(6 * 3600_000);
  });
});

describe('identity images', () => {
  it('are stored per user and interview', () => {
    const userId = new Types.ObjectId();
    const sessionId = new Types.ObjectId();
    expect(identityImageKey({ userId, sessionId }, 'ID_DOCUMENT', 'image/jpeg')).toBe(
      `identity/${String(userId)}/${String(sessionId)}/id_document.jpg`,
    );
  });
});

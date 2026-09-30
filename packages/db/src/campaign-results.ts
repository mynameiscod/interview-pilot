import type {
  ApplicationStatus,
  CandidateStage,
  CampaignResultRow,
  CampaignResults,
  CampaignResultsExportQuery,
  CampaignResultsQuery,
  CampaignResultsSort,
  CampaignSummary,
  InterviewState,
} from '@cbi/shared-types';
import { DEFAULT_INVITE_REMINDERS } from '@cbi/shared-types';
import type { PipelineStage, Types } from 'mongoose';
import { CampaignApplicationModel, type CampaignRecord } from './models/campaign.js';
import { InterviewScoreModel } from './models/evaluation.js';
import { OrgScorecardModel } from './models/org.js';
import { InterviewSessionModel } from './models/interview-session.js';
import { RoleBlueprintModel } from './models/library.js';
import { UserProfileModel } from './models/user-profile.js';
import { UserModel } from './models/user.js';

/**
 * Campaign results, shared by the API (grid and CSV) and the worker (package
 * exports). Filtering, sorting and paging run in MongoDB: an application is
 * joined with its interview, the interview's latest score and the candidate,
 * so no request ever loads a whole campaign into memory.
 */

/** A package export holds every report; beyond this, use the CSV. */
export const MAX_PACKAGE_ROWS = 5000;

const STARTABLE_STATES: InterviewState[] = [
  'DRAFT',
  'ROLE_ANALYSIS',
  'READY',
  'DEVICE_CHECK',
  'CONSENT_REQUIRED',
  'READY_TO_START',
];
const COMPLETED_STATES: InterviewState[] = ['PROCESSING', 'REPORT_READY'];
const UNFINISHED_STATES: InterviewState[] = ['CANCELLED', 'EXPIRED', 'FAILED'];

export function applicationStatus(state: InterviewState): ApplicationStatus {
  if (STARTABLE_STATES.includes(state)) return 'JOINED';
  if (COMPLETED_STATES.includes(state)) return 'COMPLETED';
  if (UNFINISHED_STATES.includes(state)) return 'DID_NOT_FINISH';
  return 'IN_PROGRESS';
}

/** `applicationStatus` as an aggregation expression (no interview reads as DID_NOT_FINISH). */
const STATUS_EXPR = {
  $switch: {
    branches: [
      { case: { $eq: ['$session', null] }, then: 'DID_NOT_FINISH' },
      { case: { $in: ['$session.state', STARTABLE_STATES] }, then: 'JOINED' },
      { case: { $in: ['$session.state', COMPLETED_STATES] }, then: 'COMPLETED' },
      { case: { $in: ['$session.state', UNFINISHED_STATES] }, then: 'DID_NOT_FINISH' },
    ],
    default: 'IN_PROGRESS',
  },
};

/** `rank` is the overall score with unscored candidates at -1; `scored` sorts them last. */
const SORTS: Record<CampaignResultsSort, Record<string, 1 | -1>> = {
  overall_desc: { rank: -1, joinedAt: 1, _id: 1 },
  overall_asc: { scored: -1, rank: 1, joinedAt: 1, _id: 1 },
  joined_asc: { joinedAt: 1, _id: 1 },
  joined_desc: { joinedAt: -1, _id: -1 },
};

export type CampaignResultsFilter = Pick<
  CampaignResultsExportQuery,
  'status' | 'minOverall' | 'dimension' | 'stage'
> & { sort?: CampaignResultsSort };

/**
 * The org portal's view of the same results: only candidates who accepted
 * the campaign's CAMPAIGN_SHARING consent, with each reviewer scorecard's
 * mean (and an optional minimum on it).
 */
export interface OrgResultsOptions {
  minScorecard?: number;
}

/**
 * Matches, joins, filters and sorts a campaign's applications. `dimensionKeys`
 * are the pinned blueprint's dimensions: filtering on any other key matches
 * nothing, as in the grid.
 */
export function campaignResultsPipeline(
  campaignId: Types.ObjectId,
  dimensionKeys: readonly string[],
  query: CampaignResultsFilter,
  org?: OrgResultsOptions,
): PipelineStage[] {
  const stages: PipelineStage[] = [
    { $match: { campaignId } },
    {
      $lookup: {
        from: InterviewSessionModel.collection.collectionName,
        localField: 'sessionId',
        foreignField: '_id',
        as: 'session',
        pipeline: [
          {
            $project: {
              state: 1,
              endedAt: 1,
              'review.flagged': 1,
              ...(org ? { consents: 1 } : {}),
            },
          },
        ],
      },
    },
    {
      // The latest revision (manual reviews included) is the one that counts.
      $lookup: {
        from: InterviewScoreModel.collection.collectionName,
        localField: 'sessionId',
        foreignField: 'sessionId',
        as: 'score',
        pipeline: [
          { $sort: { revision: -1 } },
          { $limit: 1 },
          {
            $project: {
              revision: 1,
              overall: 1,
              band: 1,
              'confidence.level': 1,
              'dimensions.key': 1,
              'dimensions.score': 1,
            },
          },
        ],
      },
    },
    {
      $set: {
        session: { $ifNull: [{ $first: '$session' }, null] },
        score: { $ifNull: [{ $first: '$score' }, null] },
      },
    },
    {
      $set: {
        status: STATUS_EXPR,
        overall: { $ifNull: ['$score.overall', null] },
        rank: { $ifNull: ['$score.overall', -1] },
        scored: { $cond: [{ $eq: [{ $ifNull: ['$score.overall', null] }, null] }, 0, 1] },
        stage: { $ifNull: ['$stage', 'NEW'] },
      },
    },
  ];
  if (org) stages.push(...scorecardStages());

  const match: Record<string, unknown> = {};
  // Employers only ever see candidates who agreed to share this interview with them.
  if (org) match['session.consents'] = { $elemMatch: { type: 'CAMPAIGN_SHARING', accepted: true } };
  if (org?.minScorecard !== undefined) {
    match.scorecardAverage = { $ne: null, $gte: org.minScorecard };
  }
  if (query.stage) match.stage = query.stage;
  if (query.status) match.status = query.status;
  if (query.minOverall !== undefined) match.overall = { $ne: null, $gte: query.minOverall };
  if (query.dimension) {
    const [key, min] = query.dimension.split(':') as [string, string];
    if (!dimensionKeys.includes(key)) return [...stages, { $match: { $expr: false } }];
    match['score.dimensions'] = { $elemMatch: { key, score: { $ne: null, $gte: Number(min) } } };
  }
  if (Object.keys(match).length > 0) stages.push({ $match: match });
  stages.push({ $sort: SORTS[query.sort ?? 'overall_desc'] });
  return stages;
}

/** Each reviewer scorecard's mean, averaged (null without scorecards), and how many there are. */
function scorecardStages(): PipelineStage[] {
  return [
    {
      $lookup: {
        from: OrgScorecardModel.collection.collectionName,
        localField: '_id',
        foreignField: 'applicationId',
        as: 'scorecardDocs',
        pipeline: [{ $project: { average: 1 } }],
      },
    },
    {
      $set: {
        scorecardAverage: {
          $cond: [
            { $gt: [{ $size: '$scorecardDocs' }, 0] },
            { $round: [{ $avg: '$scorecardDocs.average' }, 2] },
            null,
          ],
        },
        scorecards: { $size: '$scorecardDocs' },
      },
    },
    { $unset: 'scorecardDocs' },
  ];
}

/** Adds the candidate's email and display name (run after paging: they are not filtered on). */
export function candidateLookupStages(): PipelineStage.Lookup[] {
  return [
    {
      $lookup: {
        from: UserModel.collection.collectionName,
        localField: 'userId',
        foreignField: '_id',
        as: 'user',
        pipeline: [{ $project: { primaryEmail: 1 } }],
      },
    },
    {
      $lookup: {
        from: UserProfileModel.collection.collectionName,
        localField: 'userId',
        foreignField: 'userId',
        as: 'profile',
        pipeline: [{ $project: { displayName: 1 } }],
      },
    },
  ];
}

/** A document produced by `campaignResultsPipeline` + `candidateLookupStages`. */
export interface CampaignResultDoc {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  joinedAt: Date;
  status: ApplicationStatus;
  stage?: CandidateStage;
  session: {
    _id: Types.ObjectId;
    endedAt?: Date | null;
    review?: { flagged?: boolean } | null;
  } | null;
  score: {
    revision: number;
    overall: number | null;
    band: string;
    confidence?: { level?: string } | null;
    dimensions?: { key: string; score: number | null }[];
  } | null;
  user?: { primaryEmail?: string | null }[];
  profile?: { displayName?: string | null }[];
}

export type CampaignDimension = { key: string; name: string };

export function toResultRow(
  doc: CampaignResultDoc,
  dimensions: readonly CampaignDimension[],
): CampaignResultRow {
  const { session, score } = doc;
  return {
    applicationId: String(doc._id),
    interviewId: session ? String(session._id) : null,
    candidate: {
      userId: String(doc.userId),
      name: doc.profile?.[0]?.displayName ?? null,
      email: doc.user?.[0]?.primaryEmail ?? null,
    },
    status: doc.status,
    joinedAt: doc.joinedAt.toISOString(),
    completedAt: session?.endedAt ? session.endedAt.toISOString() : null,
    overall: score?.overall ?? null,
    band: score?.band ?? null,
    confidence: score?.confidence?.level ?? null,
    scoreRevision: score?.revision ?? null,
    dimensions: Object.fromEntries(
      dimensions.map((d) => [
        d.key,
        score?.dimensions?.find((x) => x.key === d.key)?.score ?? null,
      ]),
    ),
    flagged: Boolean(session?.review?.flagged),
    stage: doc.stage ?? 'NEW',
  };
}

/** The pinned blueprint's dimensions, in blueprint order (the grid's columns). */
export async function campaignDimensions(
  campaign: Pick<CampaignRecord, 'blueprintId'>,
): Promise<CampaignDimension[]> {
  const blueprint = await RoleBlueprintModel.findById(campaign.blueprintId, {
    'content.competencies': 1,
  }).lean();
  return (blueprint?.content.competencies ?? []).map((d) => ({ key: d.key, name: d.name }));
}

const hasFilters = (q: CampaignResultsFilter) =>
  Boolean(q.status || q.minOverall !== undefined || q.dimension || q.stage);

/** Candidates matching the filters. */
export async function countCampaignResults(
  campaign: Pick<CampaignRecord, '_id'>,
  dimensions: readonly CampaignDimension[],
  query: CampaignResultsFilter,
): Promise<number> {
  if (!hasFilters(query))
    return CampaignApplicationModel.countDocuments({ campaignId: campaign._id });
  const [res] = await CampaignApplicationModel.aggregate<{ n: number }>([
    ...campaignResultsPipeline(
      campaign._id,
      dimensions.map((d) => d.key),
      { ...query, sort: 'joined_asc' },
    ),
    { $count: 'n' },
  ]).allowDiskUse(true);
  return res?.n ?? 0;
}

/** One page of the results grid, with the total across pages. */
export async function campaignResultsPage(
  campaign: Pick<CampaignRecord, '_id' | 'blueprintId'>,
  query: CampaignResultsQuery,
): Promise<CampaignResults> {
  const dimensions = await campaignDimensions(campaign);
  const [facet] = await CampaignApplicationModel.aggregate<{
    total: { n: number }[];
    rows: CampaignResultDoc[];
  }>([
    ...campaignResultsPipeline(
      campaign._id,
      dimensions.map((d) => d.key),
      query,
    ),
    {
      $facet: {
        total: [{ $count: 'n' }],
        rows: [
          { $skip: (query.page - 1) * query.pageSize },
          { $limit: query.pageSize },
          ...candidateLookupStages(),
        ],
      },
    },
  ]).allowDiskUse(true);
  return {
    campaignId: String(campaign._id),
    dimensions,
    rows: (facet?.rows ?? []).map((doc) => toResultRow(doc, dimensions)),
    total: facet?.total[0]?.n ?? 0,
    page: query.page,
    pageSize: query.pageSize,
  };
}

/** Every matching row, read from a cursor (exports). */
export async function* campaignResultRows(
  campaign: Pick<CampaignRecord, '_id'>,
  dimensions: readonly CampaignDimension[],
  query: CampaignResultsFilter,
): AsyncGenerator<CampaignResultRow> {
  const cursor = CampaignApplicationModel.aggregate<CampaignResultDoc>([
    ...campaignResultsPipeline(
      campaign._id,
      dimensions.map((d) => d.key),
      query,
    ),
    ...candidateLookupStages(),
  ])
    .allowDiskUse(true)
    .cursor({ batchSize: 200 });
  try {
    for await (const doc of cursor) yield toResultRow(doc, dimensions);
  } finally {
    await cursor.close();
  }
}

// ---- CSV ------------------------------------------------------------------------------------------

/** Byte order mark, so spreadsheet apps read names in Hindi and Telugu correctly. */
export const CSV_BOM = String.fromCharCode(0xfeff);

/** CSV cell: quoted, and text that a spreadsheet would run as a formula is neutralised. */
export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  let s = String(value);
  if (typeof value === 'string' && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** The header line (with the BOM), CRLF-terminated. */
export function resultsCsvHeader(dimensions: readonly CampaignDimension[]): string {
  const header = [
    'Name',
    'Email',
    'Status',
    'Joined',
    'Completed',
    'Overall',
    'Band',
    'Confidence',
    'Score revision',
    'Flagged',
    ...dimensions.map((d) => d.name),
    'Interview id',
  ];
  return `${CSV_BOM}${header.map(csvCell).join(',')}\r\n`;
}

/** One row, CRLF-terminated. */
export function resultsCsvLine(
  row: CampaignResultRow,
  dimensions: readonly CampaignDimension[],
): string {
  return `${[
    row.candidate.name,
    row.candidate.email,
    row.status,
    row.joinedAt,
    row.completedAt,
    row.overall,
    row.band,
    row.confidence,
    row.scoreRevision,
    row.flagged ? 'yes' : 'no',
    ...dimensions.map((d) => row.dimensions[d.key]),
    row.interviewId,
  ]
    .map(csvCell)
    .join(',')}\r\n`;
}

/**
 * The CSV as a stream of chunks: the header, then rows from the cursor in
 * batches, so memory stays flat however many candidates there are.
 */
export async function* campaignResultsCsv(
  campaign: Pick<CampaignRecord, '_id'>,
  dimensions: readonly CampaignDimension[],
  query: CampaignResultsFilter,
  batchRows = 100,
): AsyncGenerator<string> {
  yield resultsCsvHeader(dimensions);
  let batch = '';
  let n = 0;
  for await (const row of campaignResultRows(campaign, dimensions, query)) {
    batch += resultsCsvLine(row, dimensions);
    if (++n % batchRows === 0) {
      yield batch;
      batch = '';
    }
  }
  if (batch) yield batch;
}

// ---- Summaries ------------------------------------------------------------------------------------

const iso = (d: Date) => d.toISOString();

export function campaignSummary(c: CampaignRecord): CampaignSummary {
  return {
    id: String(c._id),
    name: c.name,
    status: c.status,
    companyId: c.companyId ? String(c.companyId) : null,
    companyName: c.companyName,
    role: { id: String(c.roleId), title: c.roleTitle },
    blueprint: { id: String(c.blueprintId), version: c.blueprintVersion },
    template: {
      id: String(c.templateId),
      key: c.templateKey,
      version: c.templateVersion,
      name: c.templateName,
    },
    jobDescription: c.jobDescription,
    modes: c.modes,
    languages: c.languages,
    window: { startAt: iso(c.window.startAt), endAt: c.window.endAt ? iso(c.window.endAt) : null },
    maxCandidates: c.maxCandidates,
    joined: c.joinedCount,
    proctoring: c.proctoring,
    candidateSeesReport: c.candidateSeesReport,
    sponsoredCredits: c.sponsoredCredits
      ? { total: c.sponsoredCredits.total, used: c.sponsoredCredits.used }
      : null,
    tokenHint: c.tokenHint,
    orgId: c.orgId ? String(c.orgId) : null,
    requireInvite: c.requireInvite ?? false,
    employerView: c.employerView ?? 'FULL_REPORT',
    idCapture: c.idCapture ?? false,
    reminders: c.reminders ?? { ...DEFAULT_INVITE_REMINDERS },
    createdAt: iso(c.createdAt),
    updatedAt: iso(c.updatedAt),
  };
}

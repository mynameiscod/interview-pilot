import type {
  CandidateStage,
  InviteTags,
  OrgResultRow,
  OrgResults,
  OrgResultsExportQuery,
  OrgResultsQuery,
} from '@cbi/shared-types';
import { CandidateStage as CandidateStageEnum } from '@cbi/shared-types';
import type { PipelineStage, Types } from 'mongoose';
import {
  campaignDimensions,
  campaignResultsPipeline,
  candidateLookupStages,
  csvCell,
  CSV_BOM,
  toResultRow,
  type CampaignDimension,
  type CampaignResultDoc,
} from './campaign-results.js';
import { CampaignApplicationModel, type CampaignRecord } from './models/campaign.js';
import { InterviewSessionModel } from './models/interview-session.js';
import { CampaignInviteModel, IdentityCaptureModel, OrgNoteModel } from './models/org.js';

/**
 * Campaign results as an organisation sees them (org portal and API keys):
 * the shared results pipeline limited to candidates who accepted the
 * CAMPAIGN_SHARING consent, plus the pipeline stage, scorecards, notes,
 * invite tags and the identity check. Everything runs in MongoDB, a page at
 * a time, like the admin grid.
 */

type OrgFilter = Omit<OrgResultsExportQuery, 'sort'> & { sort?: OrgResultsExportQuery['sort'] };

interface OrgResultDoc extends CampaignResultDoc {
  scorecardAverage?: number | null;
  scorecards?: number;
  notesCount?: { n: number }[];
  invite?: { tags?: InviteTags | null }[];
  identity?: { images?: Record<string, unknown>; decision?: { decision: string } | null }[];
}

function orgPipeline(
  campaign: Pick<CampaignRecord, '_id'>,
  dimensions: readonly CampaignDimension[],
  query: OrgFilter,
): PipelineStage[] {
  return campaignResultsPipeline(
    campaign._id,
    dimensions.map((d) => d.key),
    query,
    { minScorecard: query.minScorecard },
  );
}

/** Notes, invite tags and the identity capture (after paging: not filtered on). */
export function orgRowLookupStages(): PipelineStage.FacetPipelineStage[] {
  return [
    ...candidateLookupStages(),
    {
      $lookup: {
        from: OrgNoteModel.collection.collectionName,
        localField: '_id',
        foreignField: 'applicationId',
        as: 'notesCount',
        pipeline: [{ $count: 'n' }],
      },
    },
    {
      $lookup: {
        from: CampaignInviteModel.collection.collectionName,
        localField: 'inviteId',
        foreignField: '_id',
        as: 'invite',
        pipeline: [{ $project: { tags: 1 } }],
      },
    },
    {
      $lookup: {
        from: IdentityCaptureModel.collection.collectionName,
        localField: 'sessionId',
        foreignField: 'sessionId',
        as: 'identity',
        pipeline: [{ $match: { deletedAt: null } }, { $project: { images: 1, decision: 1 } }],
      },
    },
  ];
}

export function identityStatus(
  capture: { images?: Record<string, unknown>; decision?: { decision: string } | null } | undefined,
): OrgResultRow['identity'] {
  if (!capture) return 'NONE';
  if (capture.decision?.decision === 'VERIFIED') return 'VERIFIED';
  if (capture.decision?.decision === 'MISMATCH') return 'MISMATCH';
  const images = capture.images ?? {};
  return images.SELFIE && images.ID_DOCUMENT ? 'CAPTURED' : 'NONE';
}

export function toOrgResultRow(
  doc: OrgResultDoc,
  dimensions: readonly CampaignDimension[],
): OrgResultRow {
  return {
    ...toResultRow(doc, dimensions),
    scorecardAverage: doc.scorecardAverage ?? null,
    scorecards: doc.scorecards ?? 0,
    notes: doc.notesCount?.[0]?.n ?? 0,
    tags: doc.invite?.[0]?.tags ?? null,
    identity: identityStatus(doc.identity?.[0]),
  };
}

/** Consented candidates per stage, whatever the filters (the pipeline board's counts). */
export async function orgStageCounts(
  campaign: Pick<CampaignRecord, '_id'>,
): Promise<Record<CandidateStage, number>> {
  const rows = await CampaignApplicationModel.aggregate<{ _id: CandidateStage; n: number }>([
    { $match: { campaignId: campaign._id } },
    {
      $lookup: {
        from: InterviewSessionModel.collection.collectionName,
        localField: 'sessionId',
        foreignField: '_id',
        as: 'session',
        pipeline: [{ $project: { consents: 1 } }],
      },
    },
    {
      $match: { 'session.consents': { $elemMatch: { type: 'CAMPAIGN_SHARING', accepted: true } } },
    },
    { $group: { _id: { $ifNull: ['$stage', 'NEW'] }, n: { $sum: 1 } } },
  ]);
  const counts = Object.fromEntries(CandidateStageEnum.options.map((s) => [s, 0])) as Record<
    CandidateStage,
    number
  >;
  for (const r of rows) counts[r._id] = r.n;
  return counts;
}

/** One page of the org results grid. */
export async function orgResultsPage(
  campaign: Pick<CampaignRecord, '_id' | 'blueprintId'>,
  query: OrgResultsQuery,
): Promise<OrgResults> {
  const dimensions = await campaignDimensions(campaign);
  const [[facet], stages] = await Promise.all([
    CampaignApplicationModel.aggregate<{ total: { n: number }[]; rows: OrgResultDoc[] }>([
      ...orgPipeline(campaign, dimensions, query),
      {
        $facet: {
          total: [{ $count: 'n' }],
          rows: [
            { $skip: (query.page - 1) * query.pageSize },
            { $limit: query.pageSize },
            ...orgRowLookupStages(),
          ],
        },
      },
    ]).allowDiskUse(true),
    orgStageCounts(campaign),
  ]);
  return {
    campaignId: String(campaign._id),
    dimensions,
    rows: (facet?.rows ?? []).map((doc) => toOrgResultRow(doc, dimensions)),
    total: facet?.total[0]?.n ?? 0,
    page: query.page,
    pageSize: query.pageSize,
    stages,
  };
}

/** One consented application as an org row, or null (other campaign, or no consent). */
export async function orgResultRow(
  campaign: Pick<CampaignRecord, '_id' | 'blueprintId'>,
  applicationId: Types.ObjectId,
): Promise<{ row: OrgResultRow; dimensions: CampaignDimension[] } | null> {
  const dimensions = await campaignDimensions(campaign);
  const [doc] = await CampaignApplicationModel.aggregate<OrgResultDoc>([
    ...orgPipeline(campaign, dimensions, {}),
    { $match: { _id: applicationId } },
    ...orgRowLookupStages(),
  ]);
  return doc ? { row: toOrgResultRow(doc, dimensions), dimensions } : null;
}

/** Matching rows, counted (exports are audited with it). */
export async function countOrgResults(
  campaign: Pick<CampaignRecord, '_id'>,
  dimensions: readonly CampaignDimension[],
  query: OrgFilter,
): Promise<number> {
  const [res] = await CampaignApplicationModel.aggregate<{ n: number }>([
    ...orgPipeline(campaign, dimensions, { ...query, sort: 'joined_asc' }),
    { $count: 'n' },
  ]).allowDiskUse(true);
  return res?.n ?? 0;
}

export function orgResultsCsvHeader(dimensions: readonly CampaignDimension[]): string {
  const header = [
    'Name',
    'Email',
    'Status',
    'Stage',
    'Joined',
    'Completed',
    'Overall',
    'Band',
    'Confidence',
    ...dimensions.map((d) => d.name),
    'Scorecard average',
    'Scorecards',
    'Batch',
    'Branch',
    'Year',
    'Identity',
    'Application id',
  ];
  return `${CSV_BOM}${header.map(csvCell).join(',')}\r\n`;
}

export function orgResultsCsvLine(
  row: OrgResultRow,
  dimensions: readonly CampaignDimension[],
): string {
  return `${[
    row.candidate.name,
    row.candidate.email,
    row.status,
    row.stage,
    row.joinedAt,
    row.completedAt,
    row.overall,
    row.band,
    row.confidence,
    ...dimensions.map((d) => row.dimensions[d.key]),
    row.scorecardAverage,
    row.scorecards,
    row.tags?.batch,
    row.tags?.branch,
    row.tags?.year,
    row.identity,
    row.applicationId,
  ]
    .map(csvCell)
    .join(',')}\r\n`;
}

/** The org CSV, streamed from a cursor in batches (memory stays flat). */
export async function* orgResultsCsv(
  campaign: Pick<CampaignRecord, '_id'>,
  dimensions: readonly CampaignDimension[],
  query: OrgFilter,
  batchRows = 100,
): AsyncGenerator<string> {
  yield orgResultsCsvHeader(dimensions);
  const cursor = CampaignApplicationModel.aggregate<OrgResultDoc>([
    ...orgPipeline(campaign, dimensions, query),
    ...orgRowLookupStages(),
  ])
    .allowDiskUse(true)
    .cursor({ batchSize: 200 });
  let batch = '';
  let n = 0;
  try {
    for await (const doc of cursor) {
      batch += orgResultsCsvLine(toOrgResultRow(doc, dimensions), dimensions);
      if (++n % batchRows === 0) {
        yield batch;
        batch = '';
      }
    }
  } finally {
    await cursor.close();
  }
  if (batch) yield batch;
}

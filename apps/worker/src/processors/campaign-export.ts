import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { finished } from 'node:stream/promises';
import type { Logger } from '@cbi/config';
import {
  CAMPAIGN_EXPORT_STUCK_AFTER_MS,
  CampaignExportModel,
  CampaignModel,
  campaignDimensions,
  campaignResultRows,
  campaignResultsCsv,
  campaignSummary,
  countCampaignResults,
  InterviewReportModel,
  MAX_PACKAGE_ROWS,
  type CampaignRecord,
  type InterviewReportRecord,
} from '@cbi/db';
import { StorageNotFoundError, type StorageProvider } from '@cbi/provider-adapters';
import type { CampaignResultRow } from '@cbi/shared-types';
import { ZipWriter } from '../exports/zip-writer.js';

export interface CampaignExportDeps {
  storage: StorageProvider;
  logger: Logger;
  /** How long a finished package stays downloadable. */
  retentionHours: number;
  /** Where the ZIP is spooled before upload (default: the OS temp directory). */
  tmpDir?: string;
  now?: () => Date;
}

/** Reports are looked up this many candidates at a time (and progress saved as often). */
const BATCH = 100;

const HOUR = 3600_000;

export const exportStorageKey = (campaignId: string, exportId: string) =>
  `exports/campaigns/${campaignId}/${exportId}.zip`;

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40) || 'candidate';

/** `reports/<name>-<interviewId>` (the extension is added per file). */
export const reportEntryBase = (row: CampaignResultRow) =>
  `reports/${slug(row.candidate.name ?? row.candidate.email ?? '')}-${row.interviewId}`;

type ReportDoc = Pick<InterviewReportRecord, 'sessionId' | 'revision' | 'content' | 'pdf'>;

async function latestReports(rows: CampaignResultRow[]) {
  const ids = rows.flatMap((r) => (r.interviewId ? [r.interviewId] : []));
  const latest = new Map<string, ReportDoc>();
  if (ids.length === 0) return latest;
  const reports = await InterviewReportModel.find(
    { sessionId: { $in: ids } },
    { sessionId: 1, revision: 1, content: 1, pdf: 1 },
  )
    .sort({ revision: -1 })
    .lean<ReportDoc[]>();
  for (const rep of reports) {
    if (!latest.has(String(rep.sessionId))) latest.set(String(rep.sessionId), rep);
  }
  return latest;
}

/** Terminal failure: the record says why; retrying would not help. */
async function fail(exportId: string, error: string, now: Date) {
  await CampaignExportModel.updateOne(
    { _id: exportId, status: { $in: ['QUEUED', 'RUNNING'] } },
    { $set: { status: 'FAILED', error, completedAt: now, expiresAt: now } },
  );
}

/**
 * Builds a campaign package: results.csv, the campaign settings and each
 * candidate's latest report (JSON, and PDF when ready). Entries are streamed
 * one at a time into a ZIP spooled on local disk, which is then streamed to
 * object storage, so memory stays flat whatever the campaign's size.
 * Idempotent: a retry starts the file again from scratch.
 */
export async function processCampaignPackage(
  deps: CampaignExportDeps,
  exportId: string,
  finalAttempt: boolean,
): Promise<'ready' | 'failed' | 'skipped'> {
  const now = deps.now ?? (() => new Date());
  const claimed = await CampaignExportModel.findOneAndUpdate(
    { _id: exportId, status: { $in: ['QUEUED', 'RUNNING'] } },
    {
      $set: {
        status: 'RUNNING',
        startedAt: now(),
        'progress.done': 0,
        error: null,
        expiresAt: new Date(now().getTime() + CAMPAIGN_EXPORT_STUCK_AFTER_MS),
      },
    },
    { returnDocument: 'after' },
  ).lean();
  // Already finished, failed, expired or deleted: nothing to do.
  if (!claimed) return 'skipped';

  const campaign = await CampaignModel.findById(claimed.campaignId).lean<CampaignRecord>();
  if (!campaign) {
    await fail(exportId, 'The campaign no longer exists.', now());
    return 'failed';
  }
  const dimensions = await campaignDimensions(campaign);
  const total = await countCampaignResults(campaign, dimensions, {});
  if (total > MAX_PACKAGE_ROWS) {
    await fail(
      exportId,
      `Packages hold up to ${MAX_PACKAGE_ROWS} candidates. Export the CSV instead.`,
      now(),
    );
    return 'failed';
  }
  await CampaignExportModel.updateOne({ _id: exportId }, { $set: { 'progress.total': total } });

  const campaignId = String(campaign._id);
  const path = join(deps.tmpDir ?? tmpdir(), `campaign-export-${exportId}-${randomUUID()}.zip`);
  const key = exportStorageKey(campaignId, exportId);
  const out = createWriteStream(path, { flags: 'wx' });
  try {
    const zip = new ZipWriter(out, now());
    await zip.add('results.csv', campaignResultsCsv(campaign, dimensions, {}));
    await zip.add(
      'campaign.json',
      Buffer.from(JSON.stringify(campaignSummary(campaign), null, 2), 'utf8'),
    );

    let done = 0;
    const writeReports = async (rows: CampaignResultRow[]) => {
      const latest = await latestReports(rows);
      for (const row of rows) {
        const rep = row.interviewId ? latest.get(row.interviewId) : undefined;
        if (!rep) continue;
        const base = reportEntryBase(row);
        await zip.add(
          `${base}.json`,
          Buffer.from(JSON.stringify({ revision: rep.revision, ...rep.content }, null, 2), 'utf8'),
        );
        if (rep.pdf.status === 'READY' && rep.pdf.storageKey) {
          let pdf;
          try {
            pdf = await deps.storage.getStream(rep.pdf.storageKey);
          } catch (err) {
            if (!(err instanceof StorageNotFoundError)) throw err;
            deps.logger.warn({ sessionId: row.interviewId }, 'report pdf missing from package');
          }
          if (pdf) await zip.add(`${base}.pdf`, pdf);
        }
      }
      done += rows.length;
      await CampaignExportModel.updateOne({ _id: exportId }, { $set: { 'progress.done': done } });
    };

    let batch: CampaignResultRow[] = [];
    for await (const row of campaignResultRows(campaign, dimensions, {})) {
      batch.push(row);
      if (batch.length === BATCH) {
        await writeReports(batch);
        batch = [];
      }
    }
    if (batch.length > 0) await writeReports(batch);
    await zip.finish();

    const { size } = await stat(path);
    await deps.storage.putFile(key, path, 'application/zip');
    const at = now();
    const ready = await CampaignExportModel.updateOne(
      { _id: exportId, status: 'RUNNING' },
      {
        $set: {
          status: 'READY',
          storageKey: key,
          sizeBytes: size,
          progress: { done, total: done },
          completedAt: at,
          expiresAt: new Date(at.getTime() + deps.retentionHours * HOUR),
        },
      },
    );
    if (ready.matchedCount === 0) {
      // Given up as stuck while this ran: the record says FAILED, so no one can download this.
      await deps.storage.delete(key);
      return 'skipped';
    }
    deps.logger.info(
      { exportId, campaignId, rows: done, files: zip.entries, sizeBytes: size },
      'campaign package ready',
    );
    return 'ready';
  } catch (err) {
    if (finalAttempt) {
      deps.logger.error({ err, exportId }, 'campaign package failed');
      await fail(exportId, 'The package could not be built. Try again later.', now());
    }
    throw err;
  } finally {
    // Close the spool file (still open if building failed) before deleting it.
    out.destroy();
    await finished(out).catch(() => undefined);
    await rm(path, { force: true });
  }
}

/**
 * Deletes package files past retention (the record stays, as EXPIRED, until
 * its TTL removes it) and fails exports stuck in the queue. Storage errors
 * leave the record for the next run.
 */
export async function sweepCampaignExports(opts: {
  storage: StorageProvider;
  logger: Logger;
  now?: Date;
}) {
  const now = opts.now ?? new Date();
  const result = { expired: 0, stuck: 0, errors: 0 };
  const due = await CampaignExportModel.find(
    { status: 'READY', expiresAt: { $lte: now } },
    { storageKey: 1 },
  )
    .limit(500)
    .lean();
  for (const exp of due) {
    try {
      if (exp.storageKey) await opts.storage.delete(exp.storageKey);
      await CampaignExportModel.updateOne(
        { _id: exp._id, status: 'READY' },
        { $set: { status: 'EXPIRED', storageKey: null } },
      );
      result.expired += 1;
    } catch (err) {
      result.errors += 1;
      opts.logger.warn({ err, exportId: String(exp._id) }, 'campaign export file not deleted');
    }
  }
  const stuck = await CampaignExportModel.updateMany(
    { status: { $in: ['QUEUED', 'RUNNING'] }, expiresAt: { $lte: now } },
    {
      $set: {
        status: 'FAILED',
        error: 'The export took too long and was stopped. Try again.',
        completedAt: now,
        expiresAt: now,
      },
    },
  );
  result.stuck = stuck.modifiedCount;
  if (result.expired + result.stuck + result.errors > 0) {
    opts.logger.info(result, 'campaign exports swept');
  }
  return result;
}

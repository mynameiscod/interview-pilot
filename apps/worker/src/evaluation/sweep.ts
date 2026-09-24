import { InterviewSessionModel, type InterviewSessionRecord } from '@cbi/db';
import type { Queue } from 'bullmq';
import { ensureStageJob, startEvaluation } from './queue.js';

export interface EvaluationSweepOptions {
  queue: Queue;
  now?: Date;
  /** PROCESSING this long without an evaluation run: start one (a lost enqueue). */
  startAfterMs?: number;
  /** A queued or running stage untouched this long: make sure its job exists. */
  stalledAfterMs?: number;
  batchSize?: number;
}

type Row = Pick<InterviewSessionRecord, '_id' | 'processing'>;

/**
 * Safety net for the evaluation pipeline. Enqueueing happens where the
 * session reaches PROCESSING, but a crash between the state change and the
 * enqueue, or a lost job, must not leave a candidate without a report.
 * Stages marked FAILED are left for an admin to re-run.
 */
export async function sweepEvaluations(opts: EvaluationSweepOptions) {
  const now = opts.now ?? new Date();
  const limit = opts.batchSize ?? 100;
  const ago = (ms: number) => new Date(now.getTime() - ms);
  let started = 0;
  let resumed = 0;

  const unstarted = await InterviewSessionModel.find(
    { state: 'PROCESSING', processing: null, updatedAt: { $lt: ago(opts.startAfterMs ?? 30_000) } },
    { _id: 1 },
  )
    .limit(limit)
    .lean<Row[]>();
  for (const row of unstarted) {
    if (await startEvaluation(opts.queue, String(row._id))) started++;
  }

  const stalled = await InterviewSessionModel.find(
    {
      state: { $in: ['PROCESSING', 'REPORT_READY'] },
      'processing.status': { $in: ['QUEUED', 'RUNNING'] },
      'processing.updatedAt': { $lt: ago(opts.stalledAfterMs ?? 10 * 60_000) },
    },
    { _id: 1, processing: 1 },
  )
    .limit(limit)
    .lean<Row[]>();
  for (const row of stalled) {
    const p = row.processing!;
    if (!p.stage) continue;
    await ensureStageJob(opts.queue, { sessionId: String(row._id), stage: p.stage, run: p.run });
    resumed++;
  }
  return { started, resumed };
}

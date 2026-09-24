import { beginEvaluation, FIRST_STAGE, type Redis } from '@cbi/db';
import {
  EvaluationJob,
  evaluationJobId,
  QueueName,
  type EvaluationStageJobData,
  type ProcessingStage,
} from '@cbi/shared-types';
import { Queue, type JobsOptions } from 'bullmq';

export const EVALUATION_JOB_OPTIONS: JobsOptions = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 10_000 },
  removeOnComplete: { count: 2000, age: 7 * 24 * 3600 },
  removeOnFail: { count: 5000, age: 30 * 24 * 3600 },
};

export function createEvaluationQueue(connection: Redis) {
  return new Queue(QueueName.EVALUATION, { connection, defaultJobOptions: EVALUATION_JOB_OPTIONS });
}

/**
 * Makes sure the job for a stage exists and will run. Adding an id that
 * already exists is ignored by BullMQ, so a failed job is retried instead
 * and a finished one (whose result was lost) is replaced.
 */
export async function ensureStageJob(
  queue: Queue,
  data: { sessionId: string; stage: ProcessingStage; run: number },
): Promise<void> {
  const id = evaluationJobId(data.sessionId, data.stage, data.run);
  const existing = await queue.getJob(id);
  if (existing) {
    const state = await existing.getState();
    if (state === 'failed') return existing.retry();
    if (state !== 'completed') return;
    await existing.remove();
  }
  const payload: EvaluationStageJobData = data;
  await queue.add(EvaluationJob.STAGE, payload, { jobId: id });
}

/** Starts evaluation for a PROCESSING session once (no-op if it already started). */
export async function startEvaluation(queue: Queue, sessionId: string): Promise<boolean> {
  const run = await beginEvaluation(sessionId);
  if (run === null) return false;
  await ensureStageJob(queue, { sessionId, stage: FIRST_STAGE, run });
  return true;
}

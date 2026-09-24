import type { Logger } from '@cbi/config';
import { istDay, rollupDays, type MediaStorage, type ReconcileGateway, type Redis } from '@cbi/db';
import {
  AnalysisJob,
  DocumentJob,
  EvaluationJob,
  QueueName,
  type EvaluationStageJobData,
  type ReportPdfJobData,
  type InterviewAnalyzeJobData,
  type JdExtractJobData,
  type ResumeExtractJobData,
} from '@cbi/shared-types';
import { DelayedError, Queue, Worker, type Job } from 'bullmq';
import {
  renderRevisionPdf,
  runEvaluationStage,
  type EvaluationDeps,
} from './evaluation/pipeline.js';
import { createEvaluationQueue, ensureStageJob } from './evaluation/queue.js';
import { sweepEvaluations } from './evaluation/sweep.js';
import { writeHeartbeat } from './processors/heartbeat.js';
import { processInterviewAnalyze, type AnalysisProcessorDeps } from './processors/analysis.js';
import {
  processJdExtract,
  processResumeExtract,
  type DocumentProcessorDeps,
} from './processors/documents.js';
import { sweepLiveSessions } from './processors/live-sweep.js';
import { reconcilePayments } from './processors/payment-reconcile.js';
import { runMediaSweep } from './processors/media-sweep.js';
import { rollupProviderHealth } from './processors/provider-health.js';

export const HEARTBEAT_JOB = 'heartbeat' as const;
export const PROVIDER_HEALTH_JOB = 'provider-health' as const;
export const LIVE_SWEEP_JOB = 'live-sweep' as const;
export const PAYMENT_RECONCILE_JOB = 'payment-reconcile' as const;
export const MEDIA_SWEEP_JOB = 'media-sweep' as const;
export const ANALYTICS_ROLLUP_JOB = 'analytics-rollup' as const;

export interface WorkerRuntimeOptions {
  workerId: string;
  version: string;
  heartbeatIntervalMs: number;
  /** AI provider health rollup interval; omit to disable (it needs MongoDB). */
  providerHealthIntervalMs?: number;
  /** Live interview timeouts (disconnect, pause, expiry); omit to disable. */
  liveSweepIntervalMs?: number;
  /** Connection dedicated to BullMQ (maxRetriesPerRequest: null). */
  queueConnection: Redis;
  /** Connection used by processors for ordinary commands. */
  redis: Redis;
  logger: Logger;
  /** Resume and job-description extraction; omit to leave the queue unconsumed. */
  documents?: { deps: DocumentProcessorDeps; concurrency: number };
  /** Role analysis and blueprint selection; omit to leave the queue unconsumed. */
  analysis?: { deps: AnalysisProcessorDeps; concurrency: number };
  /** Reconciliation of purchases with the payment gateway; omit to disable. */
  payments?: { gateway: ReconcileGateway; intervalMs: number };
  /** Recording finalization and retention; omit to disable. */
  media?: { storage: MediaStorage; intervalMs: number };
  /** Analytics rollups for today and yesterday; omit to disable. */
  analyticsRollupIntervalMs?: number;
  /** The evaluation pipeline (evidence, scores, report, PDF, email); omit to leave it unconsumed. */
  evaluation?: { deps: EvaluationDeps; concurrency: number };
}

export interface WorkerRuntime {
  queues: Queue[];
  workers: Worker[];
  close(): Promise<void>;
}

const isFinalAttempt = (job: Job) => job.attemptsMade + 1 >= (job.opts.attempts ?? 1);

/** Registers queues, schedulers and processors. */
export async function startWorkers(opts: WorkerRuntimeOptions): Promise<WorkerRuntime> {
  const systemQueue = new Queue(QueueName.SYSTEM, { connection: opts.queueConnection });
  const consumed: QueueName[] = [
    QueueName.SYSTEM,
    ...(opts.documents ? [QueueName.DOCUMENTS] : []),
    ...(opts.analysis ? [QueueName.ANALYSIS] : []),
    ...(opts.evaluation ? [QueueName.EVALUATION] : []),
  ];
  const evaluationQueue = opts.evaluation ? createEvaluationQueue(opts.queueConnection) : null;

  // Scheduler per worker id so every replica reports its own heartbeat.
  await systemQueue.upsertJobScheduler(
    `${HEARTBEAT_JOB}:${opts.workerId}`,
    { every: opts.heartbeatIntervalMs },
    {
      name: HEARTBEAT_JOB,
      data: { workerId: opts.workerId },
      opts: { removeOnComplete: 10, removeOnFail: 50 },
    },
  );

  // One scheduler shared by all replicas: the rollup is idempotent, but once a minute is enough.
  if (opts.providerHealthIntervalMs) {
    await systemQueue.upsertJobScheduler(
      PROVIDER_HEALTH_JOB,
      { every: opts.providerHealthIntervalMs },
      { name: PROVIDER_HEALTH_JOB, opts: { removeOnComplete: 10, removeOnFail: 50 } },
    );
  }

  if (opts.liveSweepIntervalMs) {
    await systemQueue.upsertJobScheduler(
      LIVE_SWEEP_JOB,
      { every: opts.liveSweepIntervalMs },
      { name: LIVE_SWEEP_JOB, opts: { removeOnComplete: 10, removeOnFail: 50 } },
    );
  }

  if (opts.payments) {
    await systemQueue.upsertJobScheduler(
      PAYMENT_RECONCILE_JOB,
      { every: opts.payments.intervalMs },
      { name: PAYMENT_RECONCILE_JOB, opts: { removeOnComplete: 10, removeOnFail: 50 } },
    );
  }

  if (opts.analyticsRollupIntervalMs) {
    await systemQueue.upsertJobScheduler(
      ANALYTICS_ROLLUP_JOB,
      { every: opts.analyticsRollupIntervalMs },
      { name: ANALYTICS_ROLLUP_JOB, opts: { removeOnComplete: 10, removeOnFail: 50 } },
    );
  }

  if (opts.media) {
    await systemQueue.upsertJobScheduler(
      MEDIA_SWEEP_JOB,
      { every: opts.media.intervalMs },
      { name: MEDIA_SWEEP_JOB, opts: { removeOnComplete: 10, removeOnFail: 50 } },
    );
  }

  const workers: Worker[] = [
    new Worker(
      QueueName.SYSTEM,
      async (job) => {
        switch (job.name) {
          case HEARTBEAT_JOB: {
            await writeHeartbeat(
              opts.redis,
              {
                workerId: String(job.data.workerId),
                version: opts.version,
                at: new Date().toISOString(),
                queues: consumed,
              },
              opts.heartbeatIntervalMs,
            );
            return;
          }
          case LIVE_SWEEP_JOB: {
            const swept = await sweepLiveSessions({ logger: opts.logger });
            if (Object.values(swept).some((n) => n > 0)) {
              opts.logger.info(swept, 'live sessions swept');
            }
            if (evaluationQueue) {
              const evaluations = await sweepEvaluations({ queue: evaluationQueue });
              if (evaluations.started + evaluations.resumed > 0) {
                opts.logger.info(evaluations, 'evaluations started or resumed');
              }
            }
            return;
          }
          case PAYMENT_RECONCILE_JOB: {
            if (!opts.payments) return;
            const counts = await reconcilePayments({
              gateway: opts.payments.gateway,
              logger: opts.logger,
            });
            if (counts.checked > 0) opts.logger.info(counts, 'purchases reconciled');
            return;
          }
          case MEDIA_SWEEP_JOB: {
            if (!opts.media) return;
            await runMediaSweep({ storage: opts.media.storage, logger: opts.logger });
            return;
          }
          case ANALYTICS_ROLLUP_JOB: {
            // Recomputing both days is idempotent; yesterday catches late updates after midnight.
            const today = istDay(new Date());
            const yesterday = istDay(new Date(Date.now() - 24 * 3600 * 1000));
            await rollupDays(yesterday, today);
            return;
          }
          case PROVIDER_HEALTH_JOB: {
            const windows = await rollupProviderHealth();
            opts.logger.debug({ windows }, 'provider health rolled up');
            return;
          }
          default:
            // Unknown jobs fail visibly instead of being silently acknowledged.
            throw new Error(`Unknown system job: ${job.name}`);
        }
      },
      { connection: opts.queueConnection, concurrency: 1 },
    ),
  ];

  if (opts.documents) {
    const { deps, concurrency } = opts.documents;
    workers.push(
      new Worker(
        QueueName.DOCUMENTS,
        async (job) => {
          switch (job.name) {
            case DocumentJob.RESUME_EXTRACT:
              return processResumeExtract(
                deps,
                (job.data as ResumeExtractJobData).resumeId,
                isFinalAttempt(job),
              );
            case DocumentJob.JD_EXTRACT:
              return processJdExtract(
                deps,
                (job.data as JdExtractJobData).jobTargetId,
                isFinalAttempt(job),
              );
            default:
              throw new Error(`Unknown document job: ${job.name}`);
          }
        },
        // Parsing untrusted files can be slow; a long lock stops a busy job being re-run as stalled.
        { connection: opts.queueConnection, concurrency, lockDuration: 120_000 },
      ),
    );
  }

  if (opts.analysis) {
    const { deps, concurrency } = opts.analysis;
    workers.push(
      new Worker(
        QueueName.ANALYSIS,
        async (job, token) => {
          if (job.name !== AnalysisJob.INTERVIEW_ANALYZE) {
            throw new Error(`Unknown analysis job: ${job.name}`);
          }
          const outcome = await processInterviewAnalyze(
            deps,
            (job.data as InterviewAnalyzeJobData).sessionId,
            isFinalAttempt(job),
          );
          if (outcome.status === 'wait') {
            // Inputs are still being extracted: check again shortly without using up an attempt.
            await job.moveToDelayed(Date.now() + outcome.retryInMs, token);
            throw new DelayedError();
          }
        },
        { connection: opts.queueConnection, concurrency, lockDuration: 120_000 },
      ),
    );
  }

  if (opts.evaluation && evaluationQueue) {
    const { deps, concurrency } = opts.evaluation;
    workers.push(
      new Worker(
        QueueName.EVALUATION,
        async (job) => {
          if (job.name === EvaluationJob.REPORT_PDF) {
            const { sessionId, revision } = job.data as ReportPdfJobData;
            await renderRevisionPdf(deps, sessionId, revision);
            return;
          }
          if (job.name !== EvaluationJob.STAGE)
            throw new Error(`Unknown evaluation job: ${job.name}`);
          const data = job.data as EvaluationStageJobData;
          const outcome = await runEvaluationStage(deps, data, isFinalAttempt(job));
          if (outcome.status === 'done' && outcome.next) {
            await ensureStageJob(evaluationQueue, { ...data, stage: outcome.next });
          }
        },
        // AI scoring and PDF rendering can take a while; keep the lock long enough.
        { connection: opts.queueConnection, concurrency, lockDuration: 180_000 },
      ),
    );
  }

  for (const worker of workers) {
    worker.on('failed', (job, err) =>
      opts.logger.error({ jobId: job?.id, jobName: job?.name, err }, 'job failed'),
    );
    worker.on('error', (err) => opts.logger.error({ err }, 'worker error'));
  }

  return {
    queues: evaluationQueue ? [systemQueue, evaluationQueue] : [systemQueue],
    workers,
    async close() {
      await systemQueue.removeJobScheduler(`${HEARTBEAT_JOB}:${opts.workerId}`).catch(() => false);
      await Promise.all([
        ...workers.map((w) => w.close()),
        systemQueue.close(),
        evaluationQueue?.close(),
      ]);
    },
  };
}

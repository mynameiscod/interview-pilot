import type { Logger } from '@cbi/config';
import type { Redis } from '@cbi/db';
import { QueueName } from '@cbi/shared-types';
import { Queue, Worker } from 'bullmq';
import { writeHeartbeat } from './processors/heartbeat.js';
import { rollupProviderHealth } from './processors/provider-health.js';

export const HEARTBEAT_JOB = 'heartbeat' as const;
export const PROVIDER_HEALTH_JOB = 'provider-health' as const;

export interface WorkerRuntimeOptions {
  workerId: string;
  version: string;
  heartbeatIntervalMs: number;
  /** AI provider health rollup interval; omit to disable (it needs MongoDB). */
  providerHealthIntervalMs?: number;
  /** Connection dedicated to BullMQ (maxRetriesPerRequest: null). */
  queueConnection: Redis;
  /** Connection used by processors for ordinary commands. */
  redis: Redis;
  logger: Logger;
}

export interface WorkerRuntime {
  queues: Queue[];
  workers: Worker[];
  close(): Promise<void>;
}

/** Registers queues, schedulers and processors. */
export async function startWorkers(opts: WorkerRuntimeOptions): Promise<WorkerRuntime> {
  const systemQueue = new Queue(QueueName.SYSTEM, { connection: opts.queueConnection });

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

  const systemWorker = new Worker(
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
              queues: [QueueName.SYSTEM],
            },
            opts.heartbeatIntervalMs,
          );
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
  );

  systemWorker.on('failed', (job, err) =>
    opts.logger.error({ jobId: job?.id, jobName: job?.name, err }, 'job failed'),
  );
  systemWorker.on('error', (err) => opts.logger.error({ err }, 'worker error'));

  return {
    queues: [systemQueue],
    workers: [systemWorker],
    async close() {
      await systemQueue.removeJobScheduler(`${HEARTBEAT_JOB}:${opts.workerId}`).catch(() => false);
      await Promise.all([systemWorker.close(), systemQueue.close()]);
    },
  };
}

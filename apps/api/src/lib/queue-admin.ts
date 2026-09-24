import type { Redis } from '@cbi/db';
import { QueueName, type FailedJob, type QueueCounts } from '@cbi/shared-types';
import { Queue } from 'bullmq';

export const QUEUE_NAMES = Object.values(QueueName) as QueueName[];

/** Read-mostly access to the worker queues for the admin queue view. */
export interface QueueAdmin {
  counts(): Promise<QueueCounts[]>;
  failed(name: QueueName, limit: number): Promise<FailedJob[]>;
  /** Moves one failed job back to waiting. False when it is not (or no longer) failed. */
  retry(name: QueueName, jobId: string): Promise<boolean>;
  close(): Promise<void>;
}

/** Only ids are kept from a payload (payloads carry ids only, but be strict). */
function idsOnly(data: unknown): Record<string, unknown> {
  if (!data || typeof data !== 'object') return {};
  return Object.fromEntries(
    Object.entries(data as Record<string, unknown>).filter(
      ([k, v]) =>
        (typeof v === 'string' && v.length <= 64) || typeof v === 'number' || k === 'stage',
    ),
  );
}

export function createQueueAdmin(connection: Redis): QueueAdmin {
  // Created on first use, so processes that never open the queue view never connect.
  const queues = new Map<QueueName, Queue>();
  const queue = (name: QueueName) => {
    let q = queues.get(name);
    if (!q) {
      q = new Queue(name, { connection });
      queues.set(name, q);
    }
    return q;
  };
  return {
    async counts() {
      return Promise.all(
        QUEUE_NAMES.map(async (name) => {
          const q = queue(name);
          const [c, paused] = await Promise.all([
            q.getJobCounts('waiting', 'active', 'delayed', 'failed', 'completed'),
            q.isPaused(),
          ]);
          return {
            name,
            waiting: c.waiting ?? 0,
            active: c.active ?? 0,
            delayed: c.delayed ?? 0,
            failed: c.failed ?? 0,
            completed: c.completed ?? 0,
            paused,
          };
        }),
      );
    },
    async failed(name, limit) {
      const jobs = await queue(name).getFailed(0, limit - 1);
      return jobs.map((j) => ({
        id: String(j.id),
        name: j.name,
        failedReason: (j.failedReason ?? '').slice(0, 500),
        attemptsMade: j.attemptsMade,
        failedAt: j.finishedOn ? new Date(j.finishedOn).toISOString() : null,
        data: idsOnly(j.data),
      }));
    },
    async retry(name, jobId) {
      const job = await queue(name).getJob(jobId);
      if (!job || !(await job.isFailed())) return false;
      await job.retry('failed');
      return true;
    },
    async close() {
      await Promise.all([...queues.values()].map((q) => q.close()));
    },
  };
}

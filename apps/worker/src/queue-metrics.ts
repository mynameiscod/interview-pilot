import type { QueueDepth } from '@cbi/config';
import type { Redis } from '@cbi/db';
import { QueueName } from '@cbi/shared-types';
import { Queue } from 'bullmq';

/**
 * Reads job counts for every queue (the `cbi_queue_jobs` gauge calls it at
 * scrape time). Every worker replica reports the same numbers, so alert on
 * `max by (queue, state)`.
 */
export function createQueueDepthReader(connection: Redis) {
  const queues = (Object.values(QueueName) as QueueName[]).map(
    (name) => new Queue(name, { connection }),
  );
  return {
    async read(): Promise<QueueDepth[]> {
      return Promise.all(
        queues.map(async (q) => {
          const [c, paused] = await Promise.all([
            q.getJobCounts('waiting', 'active', 'delayed', 'failed'),
            q.isPaused(),
          ]);
          return {
            name: q.name,
            waiting: c.waiting ?? 0,
            active: c.active ?? 0,
            delayed: c.delayed ?? 0,
            failed: c.failed ?? 0,
            paused,
          };
        }),
      );
    },
    async close() {
      await Promise.all(queues.map((q) => q.close()));
    },
  };
}

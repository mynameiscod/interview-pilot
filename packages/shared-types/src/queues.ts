/**
 * BullMQ queue names. Queues are separated by workload so each can have its
 * own concurrency and retry policy (see docs/architecture §2). Queues are
 * added here as the phase that needs them is implemented.
 */
export const QueueName = {
  /** Platform housekeeping: worker heartbeats, provider health, cleanup schedulers. */
  SYSTEM: 'system',
} as const;
export type QueueName = (typeof QueueName)[keyof typeof QueueName];

/** Redis key prefix for worker heartbeats; value is JSON, key expires if the worker dies. */
export const WORKER_HEARTBEAT_KEY_PREFIX = 'cbi:worker:heartbeat:' as const;

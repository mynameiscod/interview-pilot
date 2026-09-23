import { WORKER_HEARTBEAT_KEY_PREFIX } from '@cbi/shared-types';

export interface HeartbeatStore {
  set(key: string, value: string, mode: 'PX', ttlMs: number): Promise<unknown>;
}

export interface Heartbeat {
  workerId: string;
  version: string;
  at: string;
  queues: string[];
}

/**
 * Records that this worker process is alive and consuming queues. The key
 * expires after three missed intervals, so the Admin System Health page can
 * treat a missing key as a dead worker. Runs as a repeatable job, which proves
 * the full Redis → BullMQ → processor path works, not merely that the process
 * is up.
 */
export async function writeHeartbeat(
  store: HeartbeatStore,
  heartbeat: Heartbeat,
  intervalMs: number,
): Promise<void> {
  await store.set(
    `${WORKER_HEARTBEAT_KEY_PREFIX}${heartbeat.workerId}`,
    JSON.stringify(heartbeat),
    'PX',
    intervalMs * 3,
  );
}

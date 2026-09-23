import { randomUUID } from 'node:crypto';
import { createLogger } from '@cbi/config';
import { createRedis } from '@cbi/db';
import { WORKER_HEARTBEAT_KEY_PREFIX } from '@cbi/shared-types';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startWorkers, type WorkerRuntime } from './worker.js';

const REDIS_URL = process.env.REDIS_URL;
if (!REDIS_URL) {
  throw new Error('Integration tests need REDIS_URL. Start Redis with `pnpm infra:up`.');
}

const logger = createLogger({ service: 'worker-integration', level: 'silent' });
const redis = createRedis(REDIS_URL, logger, 'command');
const queueConnection = createRedis(REDIS_URL, logger, 'queue');
const workerId = `test-${randomUUID()}`;
let runtime: WorkerRuntime;

beforeAll(async () => {
  await Promise.all([redis.connect(), queueConnection.connect()]);
  runtime = await startWorkers({
    workerId,
    version: 'integration',
    heartbeatIntervalMs: 1000,
    queueConnection,
    redis,
    logger,
  });
});

afterAll(async () => {
  await runtime.close();
  await redis.del(`${WORKER_HEARTBEAT_KEY_PREFIX}${workerId}`);
  await Promise.all([redis.quit(), queueConnection.quit()]);
});

describe('system worker', () => {
  it('processes the scheduled heartbeat job end to end through BullMQ', async () => {
    const key = `${WORKER_HEARTBEAT_KEY_PREFIX}${workerId}`;
    let value: string | null = null;
    for (let i = 0; i < 50 && !value; i++) {
      value = await redis.get(key);
      if (!value) await new Promise((r) => setTimeout(r, 200));
    }
    expect(value).not.toBeNull();
    expect(JSON.parse(value!)).toMatchObject({ workerId, version: 'integration' });
    const ttl = await redis.pttl(key);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(3000);
  });
});

import { hostname } from 'node:os';
import { createLogger, loadEnv, workerEnvSchema } from '@cbi/config';
import { connectMongo, createRedis, disconnectMongo, pingMongo, pingRedis } from '@cbi/db';
import { createHealthServer } from './health-server.js';
import { startWorkers } from './worker.js';

const env = loadEnv(workerEnvSchema);
const logger = createLogger({
  service: 'worker',
  level: env.LOG_LEVEL,
  version: env.APP_VERSION,
  env: env.APP_ENV,
});
const workerId = `${hostname()}:${process.pid}`;

let draining = false;

process.on('unhandledRejection', (reason) => {
  logger.error({ err: reason }, 'unhandled promise rejection');
});

async function main(): Promise<void> {
  const redis = createRedis(env.REDIS_URL, logger, 'command');
  const queueConnection = createRedis(env.REDIS_URL, logger, 'queue');
  await Promise.all([
    connectMongo({ uri: env.MONGODB_URI, autoIndex: env.APP_ENV !== 'production', logger }),
    redis.connect(),
    queueConnection.connect(),
  ]);

  const runtime = await startWorkers({
    workerId,
    version: env.APP_VERSION,
    heartbeatIntervalMs: env.WORKER_HEARTBEAT_INTERVAL_MS,
    queueConnection,
    redis,
    logger,
  });

  const health = createHealthServer({
    env: env.APP_ENV,
    version: env.APP_VERSION,
    probes: { mongo: pingMongo, redis: () => pingRedis(redis) },
    isDraining: () => draining,
  });
  health.listen(env.WORKER_HEALTH_PORT, () =>
    logger.info({ port: env.WORKER_HEALTH_PORT, workerId }, 'worker started'),
  );

  const shutdown = async (signal: string) => {
    if (draining) return;
    draining = true;
    logger.info({ signal }, 'shutdown started; finishing active jobs');
    const force = setTimeout(() => {
      logger.warn('grace period elapsed; exiting with jobs still active');
      process.exit(1);
    }, env.SHUTDOWN_GRACE_MS);
    force.unref();
    try {
      await runtime.close();
      await Promise.allSettled([disconnectMongo(), redis.quit(), queueConnection.quit()]);
      health.close();
      logger.info('shutdown complete');
    } finally {
      process.exit(0);
    }
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err: unknown) => {
  logger.fatal({ err }, 'worker failed to start');
  process.exit(1);
});

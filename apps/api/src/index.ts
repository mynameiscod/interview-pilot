import { apiEnvSchema, createLogger, loadEnv } from '@cbi/config';
import { createApp, SERVICE_NAME } from './app.js';
import { connectMongo, createRedis, disconnectMongo, pingMongo, pingRedis } from '@cbi/db';

const env = loadEnv(apiEnvSchema);
const logger = createLogger({
  service: SERVICE_NAME,
  level: env.LOG_LEVEL,
  version: env.APP_VERSION,
  env: env.APP_ENV,
});

let draining = false;

process.on('unhandledRejection', (reason) => {
  logger.error({ err: reason }, 'unhandled promise rejection');
});

async function main(): Promise<void> {
  const redis = createRedis(env.REDIS_URL, logger);
  await Promise.all([
    connectMongo({
      uri: env.MONGODB_URI,
      autoIndex: env.APP_ENV !== 'production',
      logger,
    }),
    redis.connect(),
  ]);

  const app = createApp({
    env,
    logger,
    probes: { mongo: pingMongo, redis: () => pingRedis(redis) },
    isDraining: () => draining,
  });

  const server = app.listen(env.PORT_API, () => {
    logger.info({ port: env.PORT_API }, 'api listening');
  });

  const shutdown = async (signal: string) => {
    if (draining) return;
    draining = true;
    logger.info({ signal }, 'shutdown started; draining connections');
    const forceTimer = setTimeout(() => {
      logger.warn('grace period elapsed; closing remaining connections');
      server.closeAllConnections();
    }, env.SHUTDOWN_GRACE_MS);
    forceTimer.unref();

    server.close(async () => {
      try {
        await Promise.allSettled([disconnectMongo(), redis.quit()]);
        logger.info('shutdown complete');
      } finally {
        process.exit(0);
      }
    });
    server.closeIdleConnections();
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err: unknown) => {
  logger.fatal({ err }, 'api failed to start');
  process.exit(1);
});

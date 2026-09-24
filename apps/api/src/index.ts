import { apiEnvSchema, createLogger, loadEnv } from '@cbi/config';
import { createApp, SERVICE_NAME } from './app.js';
import { buildContainer } from './container.js';
import { bootstrapAi } from './modules/ai/ai-bootstrap.js';
import {
  connectMongo,
  createRedis,
  disconnectMongo,
  ensureIndexes,
  ensureLibraryCatalog,
  pingMongo,
  pingRedis,
} from '@cbi/db';

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
  const queueRedis = createRedis(env.REDIS_URL, logger, 'queue');
  await Promise.all([
    connectMongo({
      uri: env.MONGODB_URI,
      autoIndex: false,
      logger,
    }),
    redis.connect(),
    queueRedis.connect(),
  ]);
  await ensureIndexes();

  const container = buildContainer({ env, logger, redis, rateLimitRedis: redis, queueRedis });
  logger.info(container.providers, 'providers configured');
  await bootstrapAi({ env, ai: container.ai, audit: container.audit, logger });
  const seeded = await ensureLibraryCatalog();
  logger.info(seeded, 'interview library checked');
  const stopAiListener = await container.ai.listenForChanges();
  const app = createApp({
    container,
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
        await stopAiListener();
        await container.jobs.close();
        await Promise.allSettled([disconnectMongo(), redis.quit(), queueRedis.quit()]);
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

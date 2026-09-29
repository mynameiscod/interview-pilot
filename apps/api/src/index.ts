import { apiEnvSchema, createLogger, initErrorTracking, initMetrics, loadEnv } from '@cbi/config';
import { createServer } from 'node:http';
import { createApp, SERVICE_NAME } from './app.js';
import { createRealtime } from './realtime.js';
import { buildContainer } from './container.js';
import { bootstrapAi } from './modules/ai/ai-bootstrap.js';
import {
  connectMongo,
  createRedis,
  disconnectMongo,
  ensureCommerceCatalog,
  ensureConsentTexts,
  ensureOpsDefaults,
  ensureDesignPromptBank,
  ensureProblemBank,
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

const errorTracker = initErrorTracking({
  dsn: env.SENTRY_DSN,
  service: SERVICE_NAME,
  environment: env.SENTRY_ENVIRONMENT ?? env.APP_ENV,
  release: env.SENTRY_RELEASE ?? env.APP_VERSION,
});
if (env.METRICS_ENABLED) initMetrics({ service: SERVICE_NAME });

let draining = false;

process.on('unhandledRejection', (reason) => {
  logger.error({ err: reason }, 'unhandled promise rejection');
  errorTracker.captureException(reason, { tags: { kind: 'unhandledRejection' } });
});

async function main(): Promise<void> {
  const sentinel = { sentinels: env.REDIS_SENTINELS, name: env.REDIS_SENTINEL_MASTER };
  const redis = createRedis(env.REDIS_URL, logger, 'command', sentinel);
  const queueRedis = createRedis(env.REDIS_URL, logger, 'queue', sentinel);
  await Promise.all([
    connectMongo({
      uri: env.MONGODB_URI,
      autoIndex: false,
      maxPoolSize: env.MONGODB_MAX_POOL_SIZE,
      logger,
    }),
    redis.connect(),
    queueRedis.connect(),
  ]);
  await ensureIndexes({ auditLogRetentionDays: env.AUDIT_LOG_RETENTION_DAYS });

  const container = buildContainer({ env, logger, redis, rateLimitRedis: redis, queueRedis });
  logger.info(container.providers, 'providers configured');
  await bootstrapAi({ env, ai: container.ai, audit: container.audit, logger });
  const seeded = await ensureLibraryCatalog();
  logger.info(seeded, 'interview library checked');
  logger.info({ created: await ensureCommerceCatalog() }, 'plan catalogue checked');
  logger.info({ created: await ensureConsentTexts() }, 'consent texts checked');
  logger.info({ created: await ensureProblemBank() }, 'coding problems checked');
  logger.info({ created: await ensureDesignPromptBank() }, 'design prompts checked');
  logger.info(await ensureOpsDefaults(), 'feature flags and settings checked');
  const stopAiListener = await container.ai.listenForChanges();
  await container.integrations.start();
  const stopIntegrationsListener = await container.integrations.listenForChanges();
  const stopOpsListener = await container.opsChanges.listenForChanges();
  logger.info(
    Object.fromEntries(
      (['email', 'payments', 'storage', 'sms', 'judge'] as const).map((k) => [
        k,
        container.integrations.status(k),
      ]),
    ),
    'integrations',
  );
  const app = createApp({
    container,
    logger,
    probes: { mongo: pingMongo, redis: () => pingRedis(redis) },
    isDraining: () => draining,
    errorTracker,
  });

  const server = createServer(app);
  const realtime = await createRealtime({ server, container, redis });
  server.listen(env.PORT_API, () => {
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

    // Closing Socket.IO tells rooms to reconnect elsewhere and closes the HTTP server.
    void realtime.close().then(async () => {
      try {
        await stopAiListener();
        await stopIntegrationsListener();
        await stopOpsListener();
        await container.jobs.close();
        await container.queueAdmin.close();
        await Promise.allSettled([disconnectMongo(), redis.quit(), queueRedis.quit()]);
        await errorTracker.flush();
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

main().catch(async (err: unknown) => {
  logger.fatal({ err }, 'api failed to start');
  errorTracker.captureException(err, { tags: { kind: 'startup' } });
  await errorTracker.flush();
  process.exit(1);
});

import { hostname } from 'node:os';
import { buildAiRuntime, buildIntegrations } from '@cbi/ai-runtime';
import {
  createLogger,
  initErrorTracking,
  initMetrics,
  loadEnv,
  metricsHandler,
  setQueueDepthSource,
  workerEnvSchema,
} from '@cbi/config';
import { connectMongo, createRedis, disconnectMongo, pingMongo, pingRedis } from '@cbi/db';
import {
  createEmailProvider,
  createJudge,
  createPaymentGateway,
  createStorage,
} from '@cbi/provider-adapters';
import { createHealthServer } from './health-server.js';
import { createFfmpegRunner } from './processors/media-file.js';
import { createDocumentOcr } from './processors/ocr.js';
import { createQueueDepthReader } from './queue-metrics.js';
import { startWorkers } from './worker.js';

const env = loadEnv(workerEnvSchema);
const logger = createLogger({
  service: 'worker',
  level: env.LOG_LEVEL,
  version: env.APP_VERSION,
  env: env.APP_ENV,
});
const workerId = `${hostname()}:${process.pid}`;

const errorTracker = initErrorTracking({
  dsn: env.SENTRY_DSN,
  service: 'worker',
  environment: env.SENTRY_ENVIRONMENT ?? env.APP_ENV,
  release: env.SENTRY_RELEASE ?? env.APP_VERSION,
});
if (env.METRICS_ENABLED) initMetrics({ service: 'worker' });

let draining = false;

process.on('unhandledRejection', (reason) => {
  logger.error({ err: reason }, 'unhandled promise rejection');
  errorTracker.captureException(reason, { tags: { kind: 'unhandledRejection' } });
});

async function main(): Promise<void> {
  const sentinel = { sentinels: env.REDIS_SENTINELS, name: env.REDIS_SENTINEL_MASTER };
  const redis = createRedis(env.REDIS_URL, logger, 'command', sentinel);
  const queueConnection = createRedis(env.REDIS_URL, logger, 'queue', sentinel);
  await Promise.all([
    connectMongo({
      uri: env.MONGODB_URI,
      autoIndex: env.APP_ENV !== 'production',
      maxPoolSize: env.MONGODB_MAX_POOL_SIZE,
      logger,
    }),
    redis.connect(),
    queueConnection.connect(),
  ]);

  const ai = buildAiRuntime({ env, logger, redis });
  const stopListening = await ai.listenForChanges();
  // Same resolution as the API: System → Integrations first, then the environment file.
  const integrations = buildIntegrations({
    redis,
    logger,
    secrets: ai.secrets,
    refreshMs: 60_000,
    fallbacks: {
      email: createEmailProvider(env),
      storage: createStorage(env),
      payments: createPaymentGateway(env),
      judge: createJudge(env),
    },
  });
  await integrations.start();
  const stopIntegrations = await integrations.listenForChanges();
  const storage = integrations.storage;

  const runtime = await startWorkers({
    workerId,
    version: env.APP_VERSION,
    heartbeatIntervalMs: env.WORKER_HEARTBEAT_INTERVAL_MS,
    providerHealthIntervalMs: env.WORKER_PROVIDER_HEALTH_INTERVAL_MS,
    liveSweepIntervalMs: env.WORKER_LIVE_SWEEP_INTERVAL_MS,
    media: { storage, intervalMs: env.WORKER_MEDIA_SWEEP_INTERVAL_MS },
    mediaFiles: {
      storage,
      ffmpeg: createFfmpegRunner({
        path: env.MEDIA_FFMPEG_PATH,
        timeoutMs: env.MEDIA_FFMPEG_TIMEOUT_MS,
      }),
      intervalMs: env.WORKER_MEDIA_FILE_INTERVAL_MS,
    },
    erasure: { storage, intervalMs: env.WORKER_ACCOUNT_ERASURE_INTERVAL_MS },
    analyticsRollupIntervalMs: env.WORKER_ANALYTICS_ROLLUP_INTERVAL_MS,
    payments: {
      gateway: integrations.payments,
      intervalMs: env.WORKER_PAYMENT_RECONCILE_INTERVAL_MS,
    },
    queueConnection,
    redis,
    logger,
    errorTracker,
    documents: {
      concurrency: env.WORKER_DOCUMENT_CONCURRENCY,
      deps: {
        storage,
        ai,
        logger,
        fetch: { timeoutMs: env.JD_FETCH_TIMEOUT_MS, maxBytes: env.JD_FETCH_MAX_BYTES },
        ocr: env.OCR_ENABLED
          ? createDocumentOcr(
              { ai, logger },
              { maxPages: env.OCR_MAX_PAGES, maxBytes: env.OCR_MAX_MB * 1024 * 1024 },
            )
          : undefined,
      },
    },
    analysis: { concurrency: env.WORKER_ANALYSIS_CONCURRENCY, deps: { ai, logger } },
    evaluation: {
      concurrency: env.WORKER_EVALUATION_CONCURRENCY,
      deps: {
        ai,
        storage,
        email: integrations.email,
        emailEnabled: () => integrations.ready('email'),
        logger,
        candidateUrl: env.PUBLIC_CANDIDATE_URL,
        judge: integrations.judge,
      },
    },
    exports: {
      concurrency: env.WORKER_EXPORT_CONCURRENCY,
      sweepIntervalMs: env.WORKER_EXPORT_SWEEP_INTERVAL_MS,
      deps: {
        storage,
        logger,
        retentionHours: env.CAMPAIGN_EXPORT_RETENTION_HOURS,
        tmpDir: env.EXPORT_SPOOL_DIR,
      },
    },
  });

  const queueDepth = env.METRICS_ENABLED ? createQueueDepthReader(queueConnection) : null;
  setQueueDepthSource(queueDepth ? () => queueDepth.read() : null);
  const health = createHealthServer({
    env: env.APP_ENV,
    version: env.APP_VERSION,
    probes: { mongo: pingMongo, redis: () => pingRedis(redis) },
    isDraining: () => draining,
    metrics: env.METRICS_ENABLED ? metricsHandler({ token: env.METRICS_TOKEN }) : undefined,
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
      setQueueDepthSource(null);
      await queueDepth?.close();
      await stopListening();
      await stopIntegrations();
      await Promise.allSettled([disconnectMongo(), redis.quit(), queueConnection.quit()]);
      health.close();
      await errorTracker.flush();
      logger.info('shutdown complete');
    } finally {
      process.exit(0);
    }
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch(async (err: unknown) => {
  logger.fatal({ err }, 'worker failed to start');
  errorTracker.captureException(err, { tags: { kind: 'startup' } });
  await errorTracker.flush();
  process.exit(1);
});

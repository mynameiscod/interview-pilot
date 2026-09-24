import type { DependencyProbe, Logger } from '@cbi/config';
import { API_V1_PREFIX } from '@cbi/shared-types';
import express, { type Express } from 'express';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';
import swaggerUi from 'swagger-ui-express';
import type { Container } from './container.js';
import { AppError } from './lib/errors.js';
import { errorHandler, notFoundHandler } from './middleware/error-handler.js';
import { originGuard } from './middleware/origin-guard.js';
import { resolveRequestId } from './middleware/request-id.js';
import { adminRouter } from './modules/admin/admin.routes.js';
import { authRouter } from './modules/auth/auth.routes.js';
import { creditsRouter } from './modules/credits/credits.routes.js';
import { healthRouter } from './modules/health/health.routes.js';
import { jobsRouter, resumesRouter } from './modules/inputs/inputs.routes.js';
import { interviewsRouter } from './modules/interviews/interviews.routes.js';
import { librarySearchRouter } from './modules/library/library.routes.js';
import {
  paymentsRouter,
  paymentWebhookHandler,
  plansRouter,
} from './modules/payments/payments.routes.js';
import { feedbackRouter, reportsRouter } from './modules/reports/reports.routes.js';
import { usersRouter } from './modules/users/users.routes.js';
import { voiceInterviewRouter, voiceRouter } from './modules/voice/voice.routes.js';
import { codingInterviewRouter } from './modules/coding/coding.routes.js';
import {
  mediaInterviewRouter,
  mediaPlaybackRouter,
  userConsentsRouter,
} from './modules/media/media.routes.js';
import { campaignsRouter } from './modules/campaigns/campaigns.routes.js';
import { opsPublicRouter, shareLinksRouter } from './modules/ops/ops.routes.js';
import { buildOpenApiDocument } from './openapi/document.js';

export const SERVICE_NAME = 'api';

export interface AppDependencies {
  container: Container;
  logger: Logger;
  probes: Record<string, DependencyProbe>;
  isDraining: () => boolean;
}

export function createApp(deps: AppDependencies): Express {
  const { container: c, logger } = deps;
  const env = c.env;
  const app = express();

  app.disable('x-powered-by');
  app.set('trust proxy', env.TRUST_PROXY_HOPS);

  app.use(
    pinoHttp({
      logger,
      genReqId: resolveRequestId,
      autoLogging: { ignore: (req) => req.url === '/healthz' || req.url === '/readyz' },
      customLogLevel: (_req, res, err) =>
        err || res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info',
      serializers: {
        req: (req: { id: unknown; method: string; url: string }) => ({
          id: req.id,
          method: req.method,
          url: req.url,
        }),
        res: (res: { statusCode: number }) => ({ statusCode: res.statusCode }),
      },
    }),
  );

  // Health endpoints sit outside CORS/origin checks: they are called by NGINX and Docker.
  app.use(
    healthRouter({
      service: SERVICE_NAME,
      version: env.APP_VERSION,
      env: env.APP_ENV,
      probes: deps.probes,
      isDraining: deps.isDraining,
    }),
  );

  if (env.API_DOCS_ENABLED) {
    const document = buildOpenApiDocument(env.APP_VERSION);
    app.get('/api/docs/openapi.json', (_req, res) => {
      res.json(document);
    });
    app.use(
      '/api/docs',
      helmet({ contentSecurityPolicy: false }),
      swaggerUi.serve,
      swaggerUi.setup(document),
    );
  }

  app.use(helmet());
  app.use(originGuard(env.CORS_ALLOWED_ORIGINS));
  // Payment webhooks need the raw body for their signature, so they come before the JSON parser.
  app.post(`${API_V1_PREFIX}/payments/webhooks/razorpay`, ...paymentWebhookHandler(c));
  app.use(express.json({ limit: env.REQUEST_BODY_LIMIT }));

  const v1 = express.Router();
  v1.use(c.limiters.public);
  v1.use('/auth', authRouter('candidate', c));
  v1.use('/users', userConsentsRouter(c));
  v1.use('/users', usersRouter(c));
  v1.use('/resumes', resumesRouter(c));
  v1.use('/jobs', jobsRouter(c));
  v1.use('/interviews', voiceInterviewRouter(c));
  v1.use('/interviews', mediaInterviewRouter(c));
  v1.use('/interviews', codingInterviewRouter(c));
  v1.use('/media', mediaPlaybackRouter(c));
  v1.use('/interviews', interviewsRouter(c));
  v1.use('/voice', voiceRouter(c));
  v1.use('/credits', creditsRouter(c));
  v1.use('/reports', shareLinksRouter(c));
  v1.use('/reports', reportsRouter(c));
  v1.use('/feedback', feedbackRouter(c));
  v1.use('/campaigns', campaignsRouter(c));
  v1.use(opsPublicRouter(c));
  v1.use('/plans', plansRouter(c));
  v1.use('/payments', paymentsRouter(c));
  v1.use(librarySearchRouter());
  v1.use('/admin/auth', authRouter('admin', c));
  v1.use('/admin', adminRouter(c));
  v1.use((req, _res, next) => {
    next(
      new AppError(404, 'NOT_FOUND', `Route ${req.method} ${API_V1_PREFIX}${req.path} not found`),
    );
  });
  app.use(API_V1_PREFIX, v1);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

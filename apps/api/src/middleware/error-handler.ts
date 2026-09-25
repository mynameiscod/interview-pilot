import { AiAbortedError, AiUnavailableError } from '@cbi/ai-core';
import { NotConfiguredError } from '@cbi/provider-adapters';
import type { ApiErrorBody } from '@cbi/shared-types';
import type { ErrorRequestHandler, RequestHandler } from 'express';
import { ZodError } from 'zod';
import { AppError } from '../lib/errors.js';

export const notFoundHandler: RequestHandler = (req, _res, next) => {
  next(AppError.notFound(`Route ${req.method} ${req.path} not found`));
};

interface HttpLikeError {
  type?: string;
  status?: number;
}

function toAppError(err: unknown): AppError {
  if (err instanceof AppError) return err;
  if (err instanceof ZodError) {
    return new AppError(400, 'VALIDATION_FAILED', 'Request validation failed', {
      issues: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
  }
  // The attempt trail is logged, never returned: it names providers and models.
  if (err instanceof AiUnavailableError || err instanceof AiAbortedError) {
    return new AppError(
      503,
      'AI_UNAVAILABLE',
      'The AI service is temporarily unavailable. Please try again in a moment.',
    );
  }
  if (err instanceof NotConfiguredError) {
    const what: Record<string, string> = {
      email: 'Email',
      payments: 'Payments',
      storage: 'File storage',
      sms: 'SMS',
      judge: 'Code running',
    };
    return new AppError(
      503,
      'NOT_CONFIGURED',
      `${what[err.kind] ?? 'This service'} is not set up yet. Please try again later.`,
    );
  }
  const httpErr = err as HttpLikeError;
  // body-parser errors carry a `type`; never forward their messages, which can echo input.
  if (httpErr?.type === 'entity.too.large') {
    return new AppError(413, 'PAYLOAD_TOO_LARGE', 'Request body is too large');
  }
  if (httpErr?.type === 'entity.parse.failed' || httpErr?.type === 'encoding.unsupported') {
    return new AppError(400, 'BAD_REQUEST', 'Malformed request body');
  }
  return new AppError(500, 'INTERNAL_ERROR', 'An unexpected error occurred');
}

/** Converts every error into the standard `{ error: {...} }` envelope. */
export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  const appError = toAppError(err);
  if (err instanceof AiUnavailableError) {
    req.log.error({ feature: err.feature, attempts: err.attempts }, 'ai unavailable');
  } else if (appError.status >= 500) {
    req.log.error({ err }, 'unhandled error');
  } else {
    req.log.info({ code: appError.code, status: appError.status }, 'request rejected');
  }
  const body: ApiErrorBody = {
    error: {
      code: appError.code,
      message: appError.message,
      ...(appError.details !== undefined ? { details: appError.details } : {}),
      requestId: String(req.id),
    },
  };
  res.status(appError.status).json(body);
};

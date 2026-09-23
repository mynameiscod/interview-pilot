import { pino, type Logger, type LoggerOptions } from 'pino';

/**
 * Paths removed from every log line: request/response credential headers and
 * the field names used for secrets across the platform. Extend this list
 * rather than relying on call sites to remember not to log a value.
 */
export const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-razorpay-signature"]',
  'res.headers["set-cookie"]',
  'password',
  'otp',
  'token',
  'accessToken',
  'refreshToken',
  'apiKey',
  'secret',
  'clientSecret',
  '*.password',
  '*.otp',
  '*.token',
  '*.accessToken',
  '*.refreshToken',
  '*.apiKey',
  '*.secret',
  '*.clientSecret',
  '*.authorization',
  '*.cookie',
];

export interface CreateLoggerOptions {
  service: string;
  level: LoggerOptions['level'];
  version?: string;
  env?: string;
}

export function createLogger(opts: CreateLoggerOptions): Logger {
  return pino({
    level: opts.level,
    base: { service: opts.service, version: opts.version, env: opts.env },
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
    formatters: {
      level: (label) => ({ level: label }),
    },
  });
}

export type { Logger };

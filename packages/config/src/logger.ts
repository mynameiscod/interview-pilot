import { pino, type Logger, type LoggerOptions } from 'pino';

/**
 * Paths removed from every log line: request/response credential headers and
 * the field names used for secrets across the platform. Extend this list
 * rather than relying on call sites to remember not to log a value.
 */
const EMAIL_FIELDS = new Set(['email', 'primaryEmail']);
const PHONE_FIELDS = new Set(['mobile', 'phone', 'primaryMobile', 'phoneNumber']);
const NAME_FIELDS = ['displayName', 'fullName', 'firstName', 'lastName', 'candidateName'];
/** OTP destinations are an email or a phone number. */
const PERSONAL_FIELDS = [...EMAIL_FIELDS, ...PHONE_FIELDS, ...NAME_FIELDS, 'destination'];

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
  // Personal data (DPDP): contact details are masked, names removed.
  ...PERSONAL_FIELDS.flatMap((field) => [field, `*.${field}`]),
];

/** Masks an email to `a***@example.com` (the domain helps support without identifying anyone). */
function maskEmailValue(value: string): string {
  const at = value.lastIndexOf('@');
  if (at <= 0) return '[REDACTED]';
  return `${value.charAt(0)}***${value.slice(at)}`;
}

/** Masks a phone number to its last 4 digits. */
function maskPhoneValue(value: string): string {
  const digits = value.replace(/\D/g, '');
  return digits.length >= 4 ? `******${digits.slice(-4)}` : '[REDACTED]';
}

/**
 * Censor for redacted paths: credentials are removed; emails and phone
 * numbers are masked (not dropped) so support can still correlate a report;
 * names are removed.
 */
export function censorLogValue(value: unknown, path: string[]): unknown {
  const field = path[path.length - 1] ?? '';
  if (typeof value !== 'string' || value === '') return '[REDACTED]';
  if (EMAIL_FIELDS.has(field)) return maskEmailValue(value);
  if (PHONE_FIELDS.has(field)) return maskPhoneValue(value);
  if (field === 'destination')
    return value.includes('@') ? maskEmailValue(value) : maskPhoneValue(value);
  return '[REDACTED]';
}

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
    redact: { paths: REDACT_PATHS, censor: censorLogValue },
    formatters: {
      level: (label) => ({ level: label }),
    },
  });
}

export type { Logger };

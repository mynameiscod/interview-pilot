/**
 * PII scrubbing for error reports (Sentry / GlitchTip) from the API, the worker
 * and both web apps. Error events leave our infrastructure, so every string is
 * cleaned of email addresses, phone numbers and credentials, and values under
 * sensitive keys are dropped whole. Browser-safe: no Node or SDK imports.
 */

export const PII_FILTERED = '[Filtered]';

const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
/** 10–15 digits with optional single spaces/dashes and a leading +: mobile numbers, not ids with letters. */
const PHONE = /(?<![\w.])\+?\d(?:[ -]?\d){9,14}(?![\w.])/g;
const AUTH_SCHEME = /\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]+/gi;
const JWT = /\beyJ[\w-]{5,}\.[\w-]{5,}\.[\w-]*/g;
/** Credentials in query strings or form bodies: ?token=…, &code=…, api_key=… */
const CREDENTIAL_PARAM =
  /([?&;](?:access_token|refresh_token|id_token|token|code|otp|key|api_key|apikey|signature|sig|password|secret)=)[^&#\s"']+/gi;

/** Keys whose values are never sent, whatever they contain. */
const SENSITIVE_KEY =
  /^(authorization|proxy-authorization|cookie|cookies|set-cookie|x-razorpay-signature|x-cb-signature|password|passwd|secret|client_?secret|token|access_?token|refresh_?token|id_?token|otp|api_?key|accesskey|credential|credentials|email|primary_?email|phone|mobile|ip_address)$/i;

const MAX_DEPTH = 12;

/** Removes emails, phone numbers, bearer tokens, JWTs and credential query params from a string. */
export function scrubText(text: string): string {
  return text
    .replace(AUTH_SCHEME, `$1 ${PII_FILTERED}`)
    .replace(JWT, PII_FILTERED)
    .replace(CREDENTIAL_PARAM, `$1${PII_FILTERED}`)
    .replace(EMAIL, PII_FILTERED)
    .replace(PHONE, PII_FILTERED);
}

/** Deep copy of `value` with every string scrubbed and sensitive keys filtered. */
export function scrubPii<T>(value: T, depth = 0): T {
  if (typeof value === 'string') return scrubText(value) as T;
  if (value === null || typeof value !== 'object' || depth > MAX_DEPTH) return value;
  if (Array.isArray(value)) return value.map((v: unknown) => scrubPii(v, depth + 1)) as T;
  // Only plain objects are walked; Dates, Errors and class instances are left as they are.
  const proto = Object.getPrototypeOf(value) as unknown;
  if (proto !== Object.prototype && proto !== null) return value;
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    out[key] =
      SENSITIVE_KEY.test(key) && v != null && v !== '' ? PII_FILTERED : scrubPii(v, depth + 1);
  }
  return out as T;
}

/**
 * The Sentry SDK's `dataCollection` option (v10+; the successor of
 * `sendDefaultPii: false`): no user details, cookies, headers, bodies, query
 * strings, AI prompts, queue payloads or local variables are collected at all.
 */
export const ERROR_REPORT_DATA_COLLECTION = {
  userInfo: false,
  cookies: false,
  httpHeaders: false,
  httpBodies: [] as never[],
  urlQueryParams: false,
  graphQL: { document: false, variables: false },
  genAI: { inputs: false, outputs: false },
  databaseQueryData: false,
  queues: false,
  stackFrameVariables: false,
} as const;

/** The parts of a Sentry event this module touches (kept structural, no SDK import). */
interface ScrubbableEvent {
  user?: { id?: string | number } | null;
  request?: { cookies?: unknown } | null;
}

/**
 * `beforeSend` / `beforeSendTransaction` hook: returns a scrubbed copy of the
 * event. The user is reduced to its opaque id; cookies are dropped entirely.
 */
export function scrubErrorEvent<E extends object>(event: E): E {
  const source = event as ScrubbableEvent;
  const scrubbed = scrubPii({ ...event, user: undefined }) as ScrubbableEvent;
  if (source.user?.id !== undefined) scrubbed.user = { id: source.user.id };
  else delete scrubbed.user;
  if (scrubbed.request) delete scrubbed.request.cookies;
  return scrubbed as E;
}

/** `beforeBreadcrumb` hook: breadcrumbs carry URLs and console messages. */
export function scrubBreadcrumb<B extends object>(breadcrumb: B): B {
  return scrubPii(breadcrumb);
}

import * as Sentry from '@sentry/node';
import { ERROR_REPORT_DATA_COLLECTION, scrubBreadcrumb, scrubErrorEvent } from '@cbi/shared-types';

/**
 * Error tracking for the API and the worker (Sentry SDK; GlitchTip speaks the
 * same protocol). Disabled unless SENTRY_DSN is set. Events are scrubbed of
 * personal data before they leave the process (packages/shared-types/src/pii.ts).
 */
export interface ErrorTracker {
  readonly enabled: boolean;
  /** Reports an error with low-cardinality tags (job name, route) and ids-only extras. */
  captureException(
    err: unknown,
    context?: { tags?: Record<string, string>; extra?: Record<string, unknown> },
  ): void;
  /** Waits for queued events to be sent (call before exiting). */
  flush(timeoutMs?: number): Promise<boolean>;
}

export interface ErrorTrackingOptions {
  dsn?: string;
  service: string;
  environment: string;
  /** The git sha the image was built from (falls back to the release tag). */
  release: string;
}

export const disabledErrorTracker: ErrorTracker = {
  enabled: false,
  captureException: () => undefined,
  flush: () => Promise.resolve(true),
};

// Integrations that would capture on their own or collect more than we want: unhandled
// rejections are reported explicitly by the entry points, and request bodies, local
// variables and console output may contain candidate data.
const EXCLUDED_INTEGRATIONS = new Set([
  'OnUnhandledRejection',
  'Console',
  'LocalVariables',
  'RequestData',
  'Modules',
]);

/** The SDK options, separate from `init` so they can be tested without a network client. */
export function sentryNodeOptions(
  opts: ErrorTrackingOptions & { dsn: string },
): Sentry.NodeOptions {
  return {
    dsn: opts.dsn,
    environment: opts.environment,
    release: opts.release,
    serverName: opts.service,
    initialScope: { tags: { service: opts.service } },
    // No IP addresses, cookies, headers, request bodies or user details (SDK v10+
    // replaced `sendDefaultPii: false` with this per-category switch).
    dataCollection: ERROR_REPORT_DATA_COLLECTION,
    // Errors only: tracesSampleRate stays unset, so no tracing (Prometheus covers latency).
    maxBreadcrumbs: 30,
    integrations: (defaults) => defaults.filter((i) => !EXCLUDED_INTEGRATIONS.has(i.name)),
    beforeSend: (event) => scrubErrorEvent(event),
    beforeSendTransaction: (event) => scrubErrorEvent(event),
    beforeBreadcrumb: (breadcrumb) => scrubBreadcrumb(breadcrumb),
  };
}

export function initErrorTracking(opts: ErrorTrackingOptions): ErrorTracker {
  if (!opts.dsn) return disabledErrorTracker;
  Sentry.init(sentryNodeOptions({ ...opts, dsn: opts.dsn }));
  return {
    enabled: true,
    captureException(err, context) {
      Sentry.withScope((scope) => {
        if (context?.tags) scope.setTags(context.tags);
        if (context?.extra) scope.setExtras(context.extra);
        Sentry.captureException(err);
      });
    },
    flush: (timeoutMs = 2000) => Sentry.flush(timeoutMs),
  };
}

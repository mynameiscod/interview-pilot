import { ERROR_REPORT_DATA_COLLECTION, scrubBreadcrumb, scrubErrorEvent } from '@cbi/shared-types';

/**
 * Browser error tracking (Sentry SDK; GlitchTip speaks the same protocol).
 * Off unless VITE_SENTRY_DSN was set at build time. The SDK is loaded with a
 * dynamic import, so a build without a DSN ships none of it. Events are scrubbed
 * of emails, phone numbers and tokens before they leave the browser, and the
 * CSP must allow the DSN host in connect-src (docs/deployment/observability.md).
 */
export interface BrowserErrorTrackingConfig {
  dsn?: string;
  environment: string;
  /** The git sha the bundle was built from. */
  release?: string;
  /** `candidate` or `admin`, added as a tag. */
  app: string;
}

/** The SDK options, or null when error tracking is off. */
export function browserErrorTrackingOptions(cfg: BrowserErrorTrackingConfig) {
  if (!cfg.dsn) return null;
  return {
    dsn: cfg.dsn,
    environment: cfg.environment,
    release: cfg.release,
    initialScope: { tags: { app: cfg.app } },
    // No IP address, cookies, headers, bodies or query strings (successor of sendDefaultPii: false).
    dataCollection: ERROR_REPORT_DATA_COLLECTION,
    maxBreadcrumbs: 30,
    // Browser noise that is not actionable.
    ignoreErrors: ['ResizeObserver loop', 'Non-Error promise rejection captured'],
    beforeSend: <E extends object>(event: E) => scrubErrorEvent(event),
    beforeBreadcrumb: <B extends object>(breadcrumb: B) => scrubBreadcrumb(breadcrumb),
  };
}

/** The part of `@sentry/react` used here (passed in so the import stays in the app bundle). */
export interface BrowserErrorSdk {
  init(options: NonNullable<ReturnType<typeof browserErrorTrackingOptions>>): unknown;
}

/** Initializes error tracking when configured. Never throws: a blocked SDK must not break the app. */
export async function initBrowserErrorTracking(
  cfg: BrowserErrorTrackingConfig,
  loadSdk: () => Promise<BrowserErrorSdk>,
): Promise<boolean> {
  const options = browserErrorTrackingOptions(cfg);
  if (!options) return false;
  try {
    const sdk = await loadSdk();
    sdk.init(options);
    return true;
  } catch {
    return false;
  }
}

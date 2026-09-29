import { AppEnv } from '@cbi/shared-types';
import { z } from 'zod';

const PublicConfig = z.object({
  VITE_API_URL: z.url(),
  VITE_APP_ENV: AppEnv,
  /** Google OAuth web client id (public). Empty hides the Google button. */
  VITE_GOOGLE_CLIENT_ID: z.string().optional(),
  /** Sentry/GlitchTip DSN (public by design). Empty turns error tracking off. */
  VITE_SENTRY_DSN: z.url().optional(),
  /** Git sha of this build, reported as the error-tracking release. */
  VITE_SENTRY_RELEASE: z.string().optional(),
});

/**
 * Public, build-time configuration. Never put secrets in VITE_* variables:
 * they are embedded in the JavaScript bundle.
 */
export const config = PublicConfig.parse({
  VITE_API_URL: import.meta.env.VITE_API_URL ?? 'http://localhost:4000',
  VITE_APP_ENV: import.meta.env.VITE_APP_ENV ?? 'development',
  VITE_GOOGLE_CLIENT_ID: import.meta.env.VITE_GOOGLE_CLIENT_ID || undefined,
  VITE_SENTRY_DSN: import.meta.env.VITE_SENTRY_DSN || undefined,
  VITE_SENTRY_RELEASE: import.meta.env.VITE_SENTRY_RELEASE || undefined,
});

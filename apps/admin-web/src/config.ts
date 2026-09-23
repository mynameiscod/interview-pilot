import { AppEnv } from '@cbi/shared-types';
import { z } from 'zod';

const PublicConfig = z.object({
  apiUrl: z.url(),
  appEnv: AppEnv,
  /** Google OAuth web client id (public). Empty hides the Google button. */
  googleClientId: z.string().optional(),
});

/** Public, build-time configuration. Never put secrets in VITE_* variables. */
export const config = PublicConfig.parse({
  apiUrl: import.meta.env.VITE_API_URL ?? 'http://localhost:4000',
  appEnv: import.meta.env.VITE_APP_ENV ?? 'development',
  googleClientId: import.meta.env.VITE_GOOGLE_CLIENT_ID || undefined,
});

export type AdminAppEnv = z.infer<typeof AppEnv>;

import { createSesEmailProvider } from './ses.js';
import { createSmtpEmailProvider } from './smtp.js';
import type { EmailProvider } from './types.js';

/** Email settings validated by @cbi/config (shared by the API and the worker). */
export interface EmailSettings {
  EMAIL_PROVIDER: 'ses' | 'smtp' | 'disabled';
  EMAIL_FROM: string;
  SES_REGION?: string;
  SES_ACCESS_KEY_ID?: string;
  SES_SECRET_ACCESS_KEY?: string;
  SMTP_HOST?: string;
  SMTP_PORT: number;
  SMTP_SECURE: boolean;
  SMTP_REQUIRE_TLS: boolean;
  SMTP_USER?: string;
  SMTP_PASS?: string;
}

/** The configured provider, or null when email is disabled. */
export function createEmailProvider(env: EmailSettings): EmailProvider | null {
  switch (env.EMAIL_PROVIDER) {
    case 'ses':
      return createSesEmailProvider({
        region: env.SES_REGION!,
        from: env.EMAIL_FROM,
        credentials:
          env.SES_ACCESS_KEY_ID && env.SES_SECRET_ACCESS_KEY
            ? { accessKeyId: env.SES_ACCESS_KEY_ID, secretAccessKey: env.SES_SECRET_ACCESS_KEY }
            : undefined,
      });
    case 'smtp':
      return createSmtpEmailProvider({
        host: env.SMTP_HOST!,
        port: env.SMTP_PORT,
        secure: env.SMTP_SECURE,
        requireTls: env.SMTP_REQUIRE_TLS,
        from: env.EMAIL_FROM,
        auth:
          env.SMTP_USER && env.SMTP_PASS ? { user: env.SMTP_USER, pass: env.SMTP_PASS } : undefined,
      });
    case 'disabled':
      return null;
  }
}

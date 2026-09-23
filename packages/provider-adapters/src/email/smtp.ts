import nodemailer, { type Transporter } from 'nodemailer';
import { ProviderError } from '../errors.js';
import type { EmailMessage, EmailProvider, SendResult } from './types.js';

export interface SmtpEmailOptions {
  host: string;
  port: number;
  /** true for implicit TLS (465); false uses STARTTLS when the server offers it. */
  secure: boolean;
  from: string;
  auth?: { user: string; pass: string };
  /** Require STARTTLS; set for any non-local server. */
  requireTls?: boolean;
  /** Injected in tests. */
  transport?: Pick<Transporter, 'sendMail'>;
}

/** Generic SMTP adapter (any SMTP relay, or Mailpit in local development). */
export function createSmtpEmailProvider(opts: SmtpEmailOptions): EmailProvider {
  const transport =
    opts.transport ??
    nodemailer.createTransport({
      host: opts.host,
      port: opts.port,
      secure: opts.secure,
      requireTLS: opts.requireTls ?? false,
      auth: opts.auth,
      connectionTimeout: 10_000,
      socketTimeout: 15_000,
    });

  return {
    name: 'smtp',
    async send(message: EmailMessage): Promise<SendResult> {
      try {
        const info = await transport.sendMail({
          from: opts.from,
          to: message.to,
          subject: message.subject,
          text: message.text,
          html: message.html,
        });
        return { providerMessageId: info.messageId };
      } catch (err) {
        const code = (err as { code?: string }).code ?? 'UNKNOWN';
        throw new ProviderError('smtp', `send failed (${code})`, true, { cause: err });
      }
    },
  };
}

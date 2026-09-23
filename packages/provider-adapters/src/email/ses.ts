import { SendEmailCommand, SESv2Client } from '@aws-sdk/client-sesv2';
import { ProviderError } from '../errors.js';
import type { EmailMessage, EmailProvider, SendResult } from './types.js';

export interface SesEmailOptions {
  region: string;
  from: string;
  /** Omit to use the default AWS credential chain (instance role, env, profile). */
  credentials?: { accessKeyId: string; secretAccessKey: string };
  timeoutMs?: number;
  /** Injected in tests. */
  client?: Pick<SESv2Client, 'send'>;
}

/** AWS SES v2 adapter. */
export function createSesEmailProvider(opts: SesEmailOptions): EmailProvider {
  const client =
    opts.client ??
    new SESv2Client({
      region: opts.region,
      credentials: opts.credentials,
      maxAttempts: 2,
    });
  const timeoutMs = opts.timeoutMs ?? 10_000;

  return {
    name: 'ses',
    async send(message: EmailMessage): Promise<SendResult> {
      const command = new SendEmailCommand({
        FromEmailAddress: opts.from,
        Destination: { ToAddresses: [message.to] },
        Content: {
          Simple: {
            Subject: { Data: message.subject, Charset: 'UTF-8' },
            Body: {
              Text: { Data: message.text, Charset: 'UTF-8' },
              ...(message.html ? { Html: { Data: message.html, Charset: 'UTF-8' } } : {}),
            },
          },
        },
      });
      try {
        const result = await client.send(command, { abortSignal: AbortSignal.timeout(timeoutMs) });
        return { providerMessageId: result.MessageId };
      } catch (err) {
        const name = err instanceof Error ? err.name : 'UnknownError';
        const retryable = !['MessageRejected', 'MailFromDomainNotVerifiedException'].includes(name);
        throw new ProviderError('ses', `send failed (${name})`, retryable, { cause: err });
      }
    },
  };
}

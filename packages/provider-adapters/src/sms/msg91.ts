import { ProviderError } from '../errors.js';
import type { OtpSms, OtpSmsProvider } from './types.js';

export interface Msg91Options {
  authKey: string;
  /** DLT-approved Flow template id containing the OTP variable. */
  templateId: string;
  /** Template variable that receives the code (as configured in the MSG91 template). */
  otpVariable: string;
  baseUrl?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

interface Msg91Response {
  type?: string;
  message?: string;
}

/**
 * MSG91 Flow API adapter. We generate and verify OTPs ourselves; MSG91 only
 * delivers the message through a DLT-registered template.
 */
export function createMsg91OtpProvider(opts: Msg91Options): OtpSmsProvider {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const url = `${opts.baseUrl ?? 'https://control.msg91.com'}/api/v5/flow`;

  return {
    name: 'msg91',
    async sendOtp({ to, code }: OtpSms) {
      let response: Response;
      try {
        response = await fetchImpl(url, {
          method: 'POST',
          headers: {
            authkey: opts.authKey,
            'content-type': 'application/json',
            accept: 'application/json',
          },
          body: JSON.stringify({
            template_id: opts.templateId,
            short_url: '0',
            recipients: [{ mobiles: to.replace(/^\+/, ''), [opts.otpVariable]: code }],
          }),
          signal: AbortSignal.timeout(opts.timeoutMs ?? 10_000),
        });
      } catch (err) {
        throw new ProviderError('msg91', 'request failed (network/timeout)', true, { cause: err });
      }

      const body = (await response.json().catch(() => ({}))) as Msg91Response;
      if (!response.ok || body.type !== 'success') {
        // MSG91 error messages describe the request, not the code; still keep them short.
        const reason = (body.message ?? `HTTP ${response.status}`).slice(0, 120);
        throw new ProviderError('msg91', `rejected: ${reason}`, response.status >= 500);
      }
      return { providerMessageId: body.message };
    },
  };
}

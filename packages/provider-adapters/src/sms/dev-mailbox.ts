import type { EmailProvider } from '../email/types.js';
import type { OtpSms, OtpSmsProvider } from './types.js';

/**
 * LOCAL DEVELOPMENT ONLY. Delivers "SMS" OTPs into the local dev mailbox
 * (Mailpit) so mobile login can be exercised without a DLT template or SMS
 * costs. The API refuses to start with this provider in staging/production.
 */
export function createDevMailboxSmsProvider(mailbox: EmailProvider): OtpSmsProvider {
  return {
    name: 'dev-mailbox',
    async sendOtp({ to, code, ttlMinutes }: OtpSms) {
      return mailbox.send({
        to: `sms-${to.replace(/\D/g, '')}@dev-sms.local`,
        subject: `[DEV SMS] to ${to}`,
        text: `Development SMS (not sent to a phone).\n\nYour CareerPilot Interview code is ${code}. It expires in ${ttlMinutes} minutes.`,
      });
    },
  };
}

/**
 * TEST DOUBLES ONLY — imported from '@cbi/provider-adapters/testing' by test
 * suites. Never wire these into application bootstrap code.
 */
import type { EmailMessage, EmailProvider } from './email/types.js';
import { ProviderError } from './errors.js';
import type { OtpSms, OtpSmsProvider } from './sms/types.js';
import { assertStorageKey, StorageNotFoundError, type StorageProvider } from './storage/types.js';

export function createRecordingEmailProvider() {
  const sent: EmailMessage[] = [];
  let failNext = false;
  const provider: EmailProvider = {
    name: 'test-recording-email',
    async send(message) {
      if (failNext) {
        failNext = false;
        throw new ProviderError('test-recording-email', 'simulated failure', true);
      }
      sent.push(message);
      return { providerMessageId: `test-${sent.length}` };
    },
  };
  return { provider, sent, failNextSend: () => (failNext = true) };
}

export function createRecordingSmsProvider() {
  const sent: OtpSms[] = [];
  const provider: OtpSmsProvider = {
    name: 'test-recording-sms',
    async sendOtp(message) {
      sent.push(message);
      return { providerMessageId: `test-${sent.length}` };
    },
  };
  return { provider, sent };
}

/** In-memory object storage for tests. */
export function createMemoryStorage() {
  const objects = new Map<string, { body: Buffer; contentType: string }>();
  const storage: StorageProvider = {
    name: 'test-memory-storage',
    async put(key, body, contentType) {
      assertStorageKey(key);
      objects.set(key, { body: Buffer.from(body), contentType });
    },
    async get(key) {
      const hit = objects.get(key);
      if (!hit) throw new StorageNotFoundError('test-memory-storage');
      return Buffer.from(hit.body);
    },
    async delete(key) {
      objects.delete(key);
    },
  };
  return { storage, objects };
}

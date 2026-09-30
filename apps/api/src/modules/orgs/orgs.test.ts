import { describe, expect, it } from 'vitest';
import { AppError } from '../../lib/errors.js';
import { blockedDuringMaintenance } from '../../middleware/maintenance.js';
import { AUTH_PATH } from '../auth/cookies.js';
import { captureStatus, imageType, kindFromPath } from './identity.service.js';
import { checkWebhookUrl, hashApiKey, newApiKey } from './integrations.service.js';
import { inviteSummary } from './invites.service.js';
import { checkRatings, parseMentions, scorecardAverage } from './pipeline.service.js';

describe('notes and scorecards', () => {
  it('keeps @mentions as plain text, once each', () => {
    expect(
      parseMentions('Thanks @asha, cc @ravi@acme.test and @asha. Email: me@acme.test'),
    ).toEqual(['asha', 'ravi@acme.test']);
    expect(parseMentions('no mentions here')).toEqual([]);
  });

  it('averages ratings to two decimals', () => {
    expect(scorecardAverage({ a: 5, b: 4, c: 4 })).toBe(4.33);
  });

  it('requires a rating for exactly the organisation criteria', () => {
    const criteria = [{ key: 'communication' }, { key: 'role-fit' }];
    expect(() => checkRatings({ communication: 4, 'role-fit': 3 }, criteria)).not.toThrow();
    expect(() => checkRatings({ communication: 4 }, criteria)).toThrow(AppError);
    expect(() => checkRatings({ communication: 4, 'role-fit': 3, extra: 1 }, criteria)).toThrow(
      /Unknown criteria: extra/,
    );
  });
});

describe('webhooks and API keys', () => {
  it('accepts https webhooks; http only where allowed; never credentials', () => {
    expect(checkWebhookUrl('https://ats.example.com/hooks/cb', false)).toBe(
      'https://ats.example.com/hooks/cb',
    );
    expect(() => checkWebhookUrl('http://ats.example.com/', false)).toThrow(/https/);
    expect(checkWebhookUrl('http://localhost:9000/cb', true)).toBe('http://localhost:9000/cb');
    expect(() => checkWebhookUrl('https://user:pw@ats.example.com/', false)).toThrow(/credentials/);
  });

  it('generates keys with a public prefix and a 256-bit secret, stored as a hash', () => {
    const { prefix, key } = newApiKey();
    expect(key).toMatch(new RegExp(`^cbk_${prefix}_[A-Za-z0-9_-]{43}$`));
    expect(hashApiKey(key)).toMatch(/^[0-9a-f]{64}$/);
    expect(newApiKey().key).not.toBe(key);
  });
});

describe('identity capture', () => {
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]);

  it('trusts the magic bytes, not the declared type alone', () => {
    expect(imageType('image/jpeg', jpeg)).toBe('image/jpeg');
    expect(imageType('image/png; charset=binary', png)).toBe('image/png');
    expect(imageType('image/png', jpeg)).toBeNull();
    expect(imageType('image/gif', jpeg)).toBeNull();
    expect(imageType(undefined, jpeg)).toBeNull();
  });

  it('maps URL kinds and reports completeness', () => {
    expect(kindFromPath('id-document')).toBe('ID_DOCUMENT');
    expect(() => kindFromPath('passport')).toThrow(AppError);
    expect(captureStatus(null)).toEqual({
      required: true,
      selfie: false,
      idDocument: false,
      complete: false,
    });
    const at = new Date();
    const image = { storageKey: 'k', mimeType: 'image/jpeg' as const, bytes: 1, at };
    expect(captureStatus({ images: { SELFIE: image, ID_DOCUMENT: image } }).complete).toBe(true);
  });
});

describe('org sessions and maintenance', () => {
  it('keeps the org portal on its own auth path', () => {
    expect(AUTH_PATH).toEqual({ candidate: '/auth', admin: '/admin/auth', org: '/org/auth' });
  });

  it('lets organisations keep working during maintenance while joins stay closed', () => {
    expect(blockedDuringMaintenance('POST', '/org/campaigns/x/candidates/stage')).toBe(false);
    expect(blockedDuringMaintenance('POST', '/campaign-invites/t/join')).toBe(true);
    expect(blockedDuringMaintenance('PUT', '/interviews/i/identity/selfie')).toBe(true);
  });
});

describe('invite summaries', () => {
  it('never expose the token', () => {
    const now = new Date('2026-09-29T10:00:00.000Z');
    const summary = inviteSummary({
      _id: '0'.repeat(24) as never,
      orgId: null as never,
      campaignId: null as never,
      email: 'asha@example.com',
      name: 'Asha',
      language: 'hi',
      tags: { batch: '2026', branch: 'CSE', year: 2026 },
      status: 'SENT',
      tokenHash: 'hash',
      tokenEnc: { v: 1 } as never,
      remindersSent: 1,
      nextSendAt: null,
      sendAttempts: 0,
      sentAt: now,
      lastReminderAt: null,
      openedAt: null,
      joinedAt: null,
      completedAt: null,
      userId: null,
      applicationId: null,
      lastError: null,
      createdBy: null as never,
      createdAt: now,
      updatedAt: now,
    });
    expect(JSON.stringify(summary)).not.toMatch(/hash|tokenEnc/);
    expect(summary).toMatchObject({ status: 'SENT', remindersSent: 1, sentAt: now.toISOString() });
  });
});

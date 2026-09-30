import { SafeFetchError, UrlBlockedError } from '@cbi/provider-adapters';
import { describe, expect, it } from 'vitest';
import { INVITE_DEFER_MS, nextInviteStep, nextReminderAt } from './invite-mailer.js';
import { inviteEmail } from './invite-messages.js';
import { failureReason } from './webhook-dispatch.js';

const HOUR = 3600_000;
const now = new Date('2026-09-29T10:00:00.000Z');
const ago = (h: number) => new Date(now.getTime() - h * HOUR);

const campaign = (overrides: Record<string, unknown> = {}) =>
  ({
    status: 'ACTIVE',
    window: { startAt: ago(100), endAt: null },
    reminders: { enabled: true, max: 2, intervalHours: 48 },
    ...overrides,
  }) as Parameters<typeof nextInviteStep>[1];

const invite = (overrides: Record<string, unknown> = {}) =>
  ({
    status: 'PENDING',
    sentAt: null,
    remindersSent: 0,
    lastReminderAt: null,
    ...overrides,
  }) as Parameters<typeof nextInviteStep>[0];

describe('invite scheduling', () => {
  it('sends the invite first, then up to two reminders at the interval', () => {
    expect(nextInviteStep(invite(), campaign(), now)).toEqual({ kind: 'invite' });
    const sent = invite({ status: 'SENT', sentAt: ago(10) });
    expect(nextInviteStep(sent, campaign(), now)).toEqual({
      kind: 'defer',
      until: new Date(ago(10).getTime() + 48 * HOUR),
    });
    expect(nextInviteStep(invite({ status: 'OPENED', sentAt: ago(49) }), campaign(), now)).toEqual({
      kind: 'reminder',
      number: 1,
    });
    expect(
      nextInviteStep(
        invite({ status: 'SENT', sentAt: ago(100), remindersSent: 1, lastReminderAt: ago(48) }),
        campaign(),
        now,
      ),
    ).toEqual({ kind: 'reminder', number: 2 });
    expect(
      nextInviteStep(
        invite({ status: 'SENT', sentAt: ago(200), remindersSent: 2 }),
        campaign(),
        now,
      ),
    ).toEqual({ kind: 'stop' });
  });

  it('never sends more than two reminders, even if configured higher', () => {
    const many = campaign({ reminders: { enabled: true, max: 9, intervalHours: 12 } });
    expect(
      nextInviteStep(invite({ status: 'SENT', sentAt: ago(99), remindersSent: 2 }), many, now),
    ).toEqual({
      kind: 'stop',
    });
    expect(nextReminderAt(many as never, 2, now)).toBeNull();
    expect(nextReminderAt(campaign() as never, 1, now)).toEqual(
      new Date(now.getTime() + 48 * HOUR),
    );
  });

  it('stops for joined, revoked or failed invites, closed or ended campaigns and disabled reminders', () => {
    for (const status of ['JOINED', 'COMPLETED', 'REVOKED', 'FAILED']) {
      expect(nextInviteStep(invite({ status }), campaign(), now)).toEqual({ kind: 'stop' });
    }
    expect(nextInviteStep(invite(), campaign({ status: 'CLOSED' }), now)).toEqual({ kind: 'stop' });
    expect(nextInviteStep(invite(), null, now)).toEqual({ kind: 'stop' });
    expect(
      nextInviteStep(invite(), campaign({ window: { startAt: ago(9), endAt: ago(1) } }), now),
    ).toEqual({ kind: 'stop' });
    const off = campaign({ reminders: { enabled: false, max: 2, intervalHours: 48 } });
    expect(nextInviteStep(invite({ status: 'SENT', sentAt: ago(99) }), off, now)).toEqual({
      kind: 'stop',
    });
    expect(nextReminderAt(off as never, 0, now)).toBeNull();
  });

  it('waits while the campaign is a draft or paused', () => {
    for (const status of ['DRAFT', 'PAUSED']) {
      expect(nextInviteStep(invite(), campaign({ status }), now)).toEqual({
        kind: 'defer',
        until: new Date(now.getTime() + INVITE_DEFER_MS),
      });
    }
  });
});

describe('invite emails', () => {
  const input = {
    name: 'Asha',
    companyName: 'Acme Labs',
    roleTitle: 'Backend Engineer',
    link: 'https://interview.test/campaign/i/abc',
    endAt: new Date('2026-10-05T12:30:00.000Z'),
  };

  it('are written in English, Hindi and Telugu with the link, company and closing date', () => {
    const en = inviteEmail('en', input);
    expect(en.subject).toBe('Acme Labs invites you to a Backend Engineer interview');
    expect(en.text).toContain('Hello Asha,');
    expect(en.text).toContain(input.link);
    expect(en.text).toMatch(/closes on 5 October 2026/);
    const hi = inviteEmail('hi', input);
    expect(hi.subject).toContain('आमंत्रित');
    expect(hi.text).toContain('नमस्ते Asha');
    const te = inviteEmail('te', input);
    expect(te.subject).toContain('ఆహ్వానిస్తోంది');
    for (const m of [hi, te]) {
      expect(m.text).toContain(input.link);
      expect(m.text).toContain('Acme Labs');
      expect(m.text).toContain('CareerPilot Interview by CodeBegun');
    }
  });

  it('say "reminder" for reminders and greet without a name', () => {
    const reminder = inviteEmail('en', { ...input, name: null, endAt: null, reminder: 1 });
    expect(reminder.subject).toBe('Reminder: your Backend Engineer interview with Acme Labs');
    expect(reminder.text.startsWith('Hello,')).toBe(true);
    expect(reminder.text).not.toContain('closes');
    expect(inviteEmail('te', { ...input, reminder: 2 }).subject).toContain('గుర్తు');
  });
});

describe('webhook delivery log', () => {
  it('records a short reason, never response bodies', () => {
    expect(failureReason(new UrlBlockedError('PRIVATE_ADDRESS'))).toBe(
      'Blocked URL (PRIVATE_ADDRESS)',
    );
    expect(failureReason(new SafeFetchError('TIMEOUT'))).toBe('Timed out');
    expect(failureReason(new SafeFetchError('NETWORK'))).toBe('Network error');
    expect(failureReason(new Error('secret stuff'))).toBe('Delivery failed');
  });
});

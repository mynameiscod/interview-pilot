import { describe, expect, it } from 'vitest';
import { computeStreak } from '@cbi/scoring-core';
import { nudgeEmail } from './nudge-messages.js';
import { decideNudge } from './practice-nudge.js';

const today = '2026-09-29';

describe('decideNudge', () => {
  it('never nudges before the first practice or on a practice day', () => {
    expect(decideNudge(computeStreak([], today), today)).toBeNull();
    expect(decideNudge(computeStreak(['2026-09-28', today], today), today)).toBeNull();
  });

  it('warns when a streak of two or more days would break today', () => {
    expect(decideNudge(computeStreak(['2026-09-27', '2026-09-28'], today), today)).toBe(
      'STREAK_AT_RISK',
    );
    // A single day is not a streak worth an email.
    expect(decideNudge(computeStreak(['2026-09-28'], today), today)).toBeNull();
  });

  it('invites candidates back after three idle days', () => {
    expect(decideNudge(computeStreak(['2026-09-27'], today), today)).toBeNull();
    expect(decideNudge(computeStreak(['2026-09-26'], today), today)).toBe('COMEBACK');
    expect(decideNudge(computeStreak(['2026-08-01'], today), today)).toBe('COMEBACK');
  });
});

describe('nudgeEmail', () => {
  const links = {
    streak: 4,
    appLink: 'https://interview.test/app',
    unsubscribeLink: 'https://interview.test/unsubscribe?token=abc',
  };

  it('is written in each language with the app and unsubscribe links', () => {
    for (const language of ['en', 'hi', 'te'] as const) {
      for (const kind of ['STREAK_AT_RISK', 'COMEBACK'] as const) {
        const m = nudgeEmail(language, kind, links);
        expect(m.subject.length).toBeGreaterThan(10);
        expect(m.text).toContain(links.appLink);
        expect(m.text.trimEnd().endsWith(links.unsubscribeLink)).toBe(true);
      }
    }
    expect(nudgeEmail('en', 'STREAK_AT_RISK', links).subject).toBe(
      'Keep your 4-day practice streak going',
    );
    expect(nudgeEmail('hi', 'STREAK_AT_RISK', links).text).toMatch(/[ऀ-ॿ]/u);
    expect(nudgeEmail('te', 'COMEBACK', links).text).toMatch(/[ఀ-౿]/u);
  });
});

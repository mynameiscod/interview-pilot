import { daysBetween, dimsHash, istDay, istDayBounds } from '@cbi/db';
import { describe, expect, it } from 'vitest';
import { toPaise } from './analytics.service.js';
import { flagOn, rolloutBucket } from './ops.service.js';

describe('feature flag rollout', () => {
  const flag = (enabled: boolean, rolloutPercent: number) => ({
    key: 'reports.publicProof',
    enabled,
    rolloutPercent,
  });

  it('is off when disabled and on for everyone at 100%', () => {
    expect(flagOn(flag(false, 100), 'u1')).toBe(false);
    expect(flagOn(flag(true, 100), null)).toBe(true);
  });

  it('keeps each user in a stable bucket and never includes anonymous visitors', () => {
    const users = Array.from({ length: 1000 }, (_, i) => `user-${i}`);
    const on = users.filter((u) => flagOn(flag(true, 30), u)).length;
    expect(on).toBeGreaterThan(230);
    expect(on).toBeLessThan(370);
    expect(rolloutBucket('a.b', 'u1')).toBe(rolloutBucket('a.b', 'u1'));
    expect(flagOn(flag(true, 99), null)).toBe(false);
    expect(flagOn(flag(true, 0), 'u1')).toBe(false);
  });
});

describe('analytics days and money', () => {
  it('uses India-time calendar days', () => {
    expect(istDay(new Date('2026-09-23T18:29:59Z'))).toBe('2026-09-23');
    expect(istDay(new Date('2026-09-23T18:30:00Z'))).toBe('2026-09-24');
    expect(istDayBounds('2026-09-24')).toEqual({
      start: new Date('2026-09-23T18:30:00Z'),
      end: new Date('2026-09-24T18:30:00Z'),
    });
    expect(daysBetween('2026-09-29', '2026-10-02')).toEqual([
      '2026-09-29',
      '2026-09-30',
      '2026-10-01',
      '2026-10-02',
    ]);
  });

  it('hashes dimensions independent of key order', () => {
    expect(dimsHash({})).toBe('');
    expect(dimsHash({ b: '2', a: '1' })).toBe(dimsHash({ a: '1', b: '2' }));
  });

  it('converts USD and INR micros to paise', () => {
    // $1 at ₹84 plus ₹1
    expect(toPaise(1_000_000, 1_000_000, 84)).toBe(8_500);
    expect(toPaise(0, 0, 84)).toBe(0);
  });
});

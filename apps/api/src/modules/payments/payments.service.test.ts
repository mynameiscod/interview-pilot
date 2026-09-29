import { mongoose, type CouponRecord } from '@cbi/db';
import { describe, expect, it } from 'vitest';
import { couponRejection } from './payments.service.js';

const NOW = new Date('2026-09-24T10:00:00Z');

const coupon = (overrides: Partial<CouponRecord> = {}): CouponRecord => ({
  _id: new mongoose.Types.ObjectId(),
  code: 'SAVE20',
  type: 'PERCENT',
  value: 20,
  validFrom: null,
  validTo: null,
  maxUses: null,
  perUserLimit: 1,
  usedCount: 0,
  planCodes: [],
  active: true,
  createdAt: NOW,
  updatedAt: NOW,
  ...overrides,
});

describe('couponRejection (the quote; orders re-check atomically)', () => {
  it('counts reserved uses against the total and per-user limits', () => {
    // usedCount includes uses reserved by unpaid orders.
    expect(couponRejection(coupon({ maxUses: 2, usedCount: 2 }), 'SPRINT', 0, NOW)).toBe('USED_UP');
    expect(couponRejection(coupon({ maxUses: 2, usedCount: 1 }), 'SPRINT', 0, NOW)).toBeNull();
    // `held` is what the user has reserved or redeemed.
    expect(couponRejection(coupon({ perUserLimit: 2 }), 'SPRINT', 2, NOW)).toBe('ALREADY_USED');
    expect(couponRejection(coupon({ perUserLimit: 2 }), 'SPRINT', 1, NOW)).toBeNull();
  });

  it('checks the rules in order', () => {
    expect(couponRejection(null, 'SPRINT', 0, NOW)).toBe('NOT_FOUND');
    expect(couponRejection(coupon({ active: false, usedCount: 9, maxUses: 1 }), 'X', 5, NOW)).toBe(
      'INACTIVE',
    );
    expect(couponRejection(coupon({ validTo: NOW }), 'SPRINT', 0, NOW)).toBe('EXPIRED');
    expect(
      couponRejection(coupon({ validFrom: new Date(NOW.getTime() + 1) }), 'SPRINT', 0, NOW),
    ).toBe('NOT_STARTED');
    expect(couponRejection(coupon({ planCodes: ['JOB_HUNT'] }), 'SPRINT', 0, NOW)).toBe(
      'NOT_FOR_PLAN',
    );
  });
});

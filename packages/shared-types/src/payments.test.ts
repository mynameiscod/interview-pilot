import { describe, expect, it } from 'vitest';
import { CreditAdjustmentBody } from './credits.js';
import {
  financialYearStart,
  formatInvoiceNumber,
  gstBreakdown,
  proratedRefundMinor,
  RefundBody,
} from './payments.js';
import { BillingSetting, DEFAULT_SETTINGS } from './system.js';

describe('proratedRefundMinor', () => {
  const base = { capturedMinor: 19_900, creditsGranted: 3, refundableMinor: 19_900 };

  it('prorates the captured amount to the unused credits (rounding down)', () => {
    expect(proratedRefundMinor({ ...base, creditsUnused: 3 })).toBe(19_900);
    expect(proratedRefundMinor({ ...base, creditsUnused: 2 })).toBe(13_266);
    expect(proratedRefundMinor({ ...base, creditsUnused: 0 })).toBe(0);
  });

  it('never suggests more than is left to refund', () => {
    expect(proratedRefundMinor({ ...base, creditsUnused: 3, refundableMinor: 5_000 })).toBe(5_000);
    expect(proratedRefundMinor({ ...base, creditsUnused: 3, refundableMinor: 0 })).toBe(0);
  });

  it('treats out-of-range credit counts safely', () => {
    expect(proratedRefundMinor({ ...base, creditsUnused: 9 })).toBe(19_900);
    expect(proratedRefundMinor({ ...base, creditsUnused: -1 })).toBe(0);
    expect(proratedRefundMinor({ ...base, creditsGranted: 0, creditsUnused: 1 })).toBe(0);
  });
});

describe('RefundBody', () => {
  it('defaults to a full refund of unused credits without acknowledgement', () => {
    expect(RefundBody.parse({ reason: 'Customer request' })).toEqual({
      reason: 'Customer request',
      acknowledgeUsedCredits: false,
    });
  });

  it('accepts a partial amount and a credit count', () => {
    expect(
      RefundBody.parse({
        reason: 'Partial',
        amountMinor: 5_000,
        withdrawCredits: 1,
        acknowledgeUsedCredits: true,
      }),
    ).toMatchObject({ amountMinor: 5_000, withdrawCredits: 1 });
    expect(RefundBody.safeParse({ reason: 'x', amountMinor: 0 }).success).toBe(false);
    expect(RefundBody.safeParse({ reason: 'Partial', amountMinor: 1.5 }).success).toBe(false);
    expect(RefundBody.safeParse({ reason: 'Partial', withdrawCredits: -1 }).success).toBe(false);
  });
});

describe('invoice numbers', () => {
  it('uses the Indian financial year in IST', () => {
    expect(financialYearStart(new Date('2026-04-01T00:00:00+05:30'))).toBe(2026);
    // 31 March 23:59 IST is still the previous financial year, although UTC says the same day.
    expect(financialYearStart(new Date('2026-03-31T23:59:00+05:30'))).toBe(2025);
    // 31 March 19:00 UTC is already 1 April in IST.
    expect(financialYearStart(new Date('2026-03-31T19:00:00Z'))).toBe(2026);
    expect(financialYearStart(new Date('2027-01-15T10:00:00Z'))).toBe(2026);
  });

  it('formats consecutive numbers within the GST 16-character limit', () => {
    expect(formatInvoiceNumber(2026, 42)).toBe('CPI/26-27/000042');
    expect(formatInvoiceNumber(2099, 999_999)).toBe('CPI/99-00/999999');
    expect(formatInvoiceNumber(2026, 1).length).toBeLessThanOrEqual(16);
  });
});

describe('gstBreakdown', () => {
  it('splits a GST-inclusive total and keeps the paise', () => {
    expect(gstBreakdown(19_900, 18)).toEqual({ taxableMinor: 16_864, taxMinor: 3_036 });
    const { taxableMinor, taxMinor } = gstBreakdown(49_900, 18);
    expect(taxableMinor + taxMinor).toBe(49_900);
  });

  it('has no tax at a zero rate', () => {
    expect(gstBreakdown(19_900, 0)).toEqual({ taxableMinor: 19_900, taxMinor: 0 });
  });
});

describe('BillingSetting', () => {
  it('accepts the default (no GSTIN: plain receipts)', () => {
    expect(BillingSetting.parse(DEFAULT_SETTINGS.billing).gstin).toBeNull();
  });

  it('validates the GSTIN and SAC code shapes', () => {
    const ok = {
      ...DEFAULT_SETTINGS.billing,
      legalName: 'CodeBegun Technologies Pvt Ltd',
      gstin: '36AABCC1234D1Z5',
      sacCode: '999293',
    };
    expect(BillingSetting.safeParse(ok).success).toBe(true);
    expect(BillingSetting.safeParse({ ...ok, gstin: '36aabcc1234d1z5' }).success).toBe(false);
    expect(BillingSetting.safeParse({ ...ok, gstin: '36AABCC1234D1X5' }).success).toBe(false);
    expect(BillingSetting.safeParse({ ...ok, sacCode: '99A' }).success).toBe(false);
    expect(BillingSetting.safeParse({ ...ok, taxRatePercent: 40 }).success).toBe(false);
  });
});

describe('CreditAdjustmentBody', () => {
  const userId = '0123456789abcdef01234567';

  it('grants or deducts a non-zero whole number with a reason', () => {
    expect(CreditAdjustmentBody.parse({ userId, delta: 2, reason: 'Goodwill' })).toEqual({
      userId,
      delta: 2,
      reason: 'Goodwill',
      expiresInDays: null,
    });
    expect(CreditAdjustmentBody.safeParse({ userId, delta: -1, reason: 'Abuse' }).success).toBe(
      true,
    );
    expect(CreditAdjustmentBody.safeParse({ userId, delta: 0, reason: 'None' }).success).toBe(
      false,
    );
    expect(CreditAdjustmentBody.safeParse({ userId, delta: 1, reason: '' }).success).toBe(false);
    expect(CreditAdjustmentBody.safeParse({ userId: 'x', delta: 1, reason: 'Ok!' }).success).toBe(
      false,
    );
  });
});

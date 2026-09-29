import { DEFAULT_SETTINGS } from '@cbi/shared-types';
import { describe, expect, it } from 'vitest';
import {
  latin1,
  PRODUCT_NAME,
  receiptMoney,
  renderReceiptPdf,
  type ReceiptInput,
} from './receipt-pdf.js';

const input = (overrides: Partial<ReceiptInput> = {}): ReceiptInput => ({
  invoiceNumber: 'CPI/26-27/000042',
  issuedAt: new Date('2026-09-24T10:00:00Z'),
  seller: DEFAULT_SETTINGS.billing,
  buyer: { name: 'Asha Rao', email: 'asha@example.com' },
  plan: { name: 'Sprint', credits: 3, validityDays: 7 },
  couponCode: 'LAUNCH20',
  listPriceMinor: 19_900,
  discountMinor: 3_980,
  totalMinor: 15_920,
  refundedMinor: 0,
  currency: 'INR',
  payment: { provider: 'razorpay', paymentId: 'pay_XYZ' },
  purchaseId: '0123456789abcdef01234567',
  ...overrides,
});

/** Uncompressed PDF text operators, joined, so assertions can read the content. */
async function text(receipt: ReceiptInput) {
  const pdf = await renderReceiptPdf(receipt, { compress: false });
  expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
  // pdfkit writes each text run as a hex string: <...> Tj / TJ. The trailer's
  // random file /ID is hex too; drop it so it cannot leak into the text.
  const body = pdf.toString('latin1').replace(/\/ID\s*\[[^\]]*\]/g, '');
  const runs = [...body.matchAll(/<([0-9a-f]+)>/g)].map((m) =>
    Buffer.from(m[1]!, 'hex').toString('latin1'),
  );
  return runs.join('');
}

describe('latin1', () => {
  it('keeps Latin-1 text and maps typographic punctuation', () => {
    expect(latin1('Zoë – “Rao”')).toBe('Zoë - "Rao"');
  });

  it('refuses text that would lose characters (no "?" in names)', () => {
    expect(latin1('आशा राव')).toBeNull();
    expect(latin1('ఆశ')).toBeNull();
  });
});

describe('receiptMoney', () => {
  it('uses Indian grouping and the currency code', () => {
    expect(receiptMoney(149_950, 'INR')).toBe('INR 1,499.50');
    expect(receiptMoney(1_00_00_000, 'INR')).toBe('INR 1,00,000.00');
  });
});

describe('renderReceiptPdf', () => {
  it('issues a plain receipt without a seller GSTIN', async () => {
    const t = await text(input());
    expect(t).toContain('Receipt');
    expect(t).not.toContain('Tax invoice');
    expect(t).toContain(PRODUCT_NAME);
    expect(t).toContain('CPI/26-27/000042');
    expect(t).toContain('Asha Rao');
    expect(t).toContain('INR 159.20');
    expect(t).toContain('coupon LAUNCH20');
    expect(t).toContain('not a tax invoice');
    expect(t).not.toContain('GST');
  });

  it('issues a tax invoice with GSTIN, SAC and the GST included', async () => {
    const t = await text(
      input({
        seller: {
          legalName: 'CodeBegun Technologies Pvt Ltd',
          address: 'Hyderabad, Telangana',
          gstin: '36AABCC1234D1Z5',
          sacCode: '999293',
          taxRatePercent: 18,
        },
      }),
    );
    expect(t).toContain('Tax invoice');
    expect(t).toContain('GSTIN: 36AABCC1234D1Z5');
    expect(t).toContain('SAC 999293');
    expect(t).toContain('GST @ 18%');
    // 15,920 including 18% GST: 13,492 taxable + 2,428 tax.
    expect(t).toContain('INR 134.92');
    expect(t).toContain('INR 24.28');
    expect(t).not.toContain('not a tax invoice');
  });

  it('leaves out a name the standard font cannot print, keeping the email', async () => {
    const t = await text(input({ buyer: { name: 'आशा राव', email: 'asha@example.com' } }));
    expect(t).toContain('asha@example.com');
    expect(t).not.toContain('?');
  });

  it('shows what was refunded', async () => {
    expect(await text(input({ refundedMinor: 5_000 }))).toContain('Refunded');
  });
});

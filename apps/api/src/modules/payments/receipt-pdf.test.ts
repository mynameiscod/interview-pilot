import { join } from 'node:path';
import { defaultFontDir, fontsAvailable } from '@cbi/pdf-fonts';
import { DEFAULT_SETTINGS, type BillingSetting } from '@cbi/shared-types';
import PDFDocument from 'pdfkit';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  latin1,
  PRODUCT_NAME,
  receiptMoney,
  renderCreditNotePdf,
  renderReceiptPdf,
  type CreditNoteInput,
  type ReceiptInput,
} from './receipt-pdf.js';

afterEach(() => vi.restoreAllMocks());

const GST_SELLER: BillingSetting = {
  legalName: 'CodeBegun Technologies Pvt Ltd',
  address: 'Hyderabad, Telangana',
  gstin: '36AABCC1234D1Z5',
  sacCode: '999293',
  taxRatePercent: 18,
};

const input = (overrides: Partial<ReceiptInput> = {}): ReceiptInput => ({
  invoiceNumber: 'CPI/26-27/000042',
  issuedAt: new Date('2026-09-24T10:00:00Z'),
  seller: DEFAULT_SETTINGS.billing,
  buyer: { name: 'Asha Rao', email: 'asha@example.com', state: null },
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

const creditNote = (overrides: Partial<CreditNoteInput> = {}): CreditNoteInput => ({
  creditNoteNumber: 'CN/26-27/000007',
  issuedAt: new Date('2026-09-28T10:00:00Z'),
  invoice: { number: 'CPI/26-27/000042', issuedAt: new Date('2026-09-24T10:00:00Z') },
  seller: GST_SELLER,
  buyer: { name: 'Asha Rao', email: 'asha@example.com', state: '36' },
  plan: { name: 'Sprint' },
  amountMinor: 5_900,
  currency: 'INR',
  refundId: 'rfnd_1',
  purchaseId: '0123456789abcdef01234567',
  ...overrides,
});

/** Standard fonts, uncompressed: the text operators, joined, so assertions can read the content. */
async function text(receipt: ReceiptInput | Promise<Buffer>) {
  const pdf =
    receipt instanceof Promise
      ? await receipt
      : await renderReceiptPdf(receipt, { compress: false, fontDir: null });
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

  it('issues a tax invoice with GSTIN, SAC and IGST when the buyer state is unknown', async () => {
    const t = await text(input({ seller: GST_SELLER }));
    expect(t).toContain('Tax invoice');
    expect(t).toContain('GSTIN: 36AABCC1234D1Z5');
    expect(t).toContain('State: Telangana (36)');
    expect(t).toContain('SAC 999293');
    expect(t).toContain('Place of supply: not stated (IGST applies)');
    expect(t).toContain('IGST @ 18%');
    expect(t).not.toContain('CGST');
    // 15,920 including 18% GST: 13,492 taxable + 2,428 tax.
    expect(t).toContain('INR 134.92');
    expect(t).toContain('INR 24.28');
    expect(t).not.toContain('not a tax invoice');
  });

  it('splits CGST and SGST for a buyer in the seller state, IGST across states', async () => {
    const same = await text(
      input({ seller: GST_SELLER, buyer: { name: 'Asha', email: null, state: '36' } }),
    );
    expect(same).toContain('Place of supply: Telangana (36)');
    expect(same).toContain('CGST @ 9%');
    expect(same).toContain('SGST @ 9%');
    // 2,428 tax: 1,214 each.
    expect(same.match(/INR 12\.14/g)).toHaveLength(2);
    expect(same).not.toContain('IGST');

    const other = await text(
      input({ seller: GST_SELLER, buyer: { name: 'Asha', email: null, state: '29' } }),
    );
    expect(other).toContain('Place of supply: Karnataka (29)');
    expect(other).toContain('IGST @ 18%');
    expect(other).not.toContain('CGST');
  });

  it('leaves out a name the standard font cannot print, keeping the email', async () => {
    const t = await text(
      input({ buyer: { name: 'आशा राव', email: 'asha@example.com', state: null } }),
    );
    expect(t).toContain('asha@example.com');
    expect(t).not.toContain('?');
  });

  it.skipIf(!fontsAvailable())(
    'prints Hindi and Telugu names with the embedded fonts by default',
    async () => {
      const written = vi.spyOn(PDFDocument.prototype, 'text');
      const pdf = await renderReceiptPdf(
        input({ buyer: { name: 'आशा రావు', email: 'asha@example.com', state: null } }),
        { compress: false },
      );
      expect(written.mock.calls.map((c) => String(c[0])).join('')).toContain('आशा రావు');
      const raw = pdf.toString('latin1');
      expect(raw).toMatch(/\/BaseFont \/[A-Z]{6}\+NotoSansDevanagari-Regular/);
      expect(raw).toMatch(/\/BaseFont \/[A-Z]{6}\+HindGuntur-Regular/);
      expect(raw).not.toContain('/Helvetica');
    },
  );

  it.skipIf(!fontsAvailable())('uses RECEIPT_FONT_PATH instead when set', async () => {
    const raw = (
      await renderReceiptPdf(input(), {
        compress: false,
        fontPath: join(defaultFontDir(), 'NotoSans-Regular.ttf'),
      })
    ).toString('latin1');
    expect(raw).toMatch(/\/BaseFont \/[A-Z]{6}\+NotoSans-Regular/);
    expect(raw).not.toContain('Devanagari');
  });

  it.skipIf(!fontsAvailable())(
    'falls back to the standard fonts if the embedded ones fail',
    async () => {
      const written = vi.spyOn(PDFDocument.prototype, 'text');
      written.mockImplementationOnce(() => {
        throw new TypeError('shaping failed');
      });
      const raw = (await renderReceiptPdf(input(), { compress: false })).toString('latin1');
      expect(raw).toContain('/BaseFont /Helvetica');
    },
  );

  it('shows what was refunded', async () => {
    expect(await text(input({ refundedMinor: 5_000 }))).toContain('Refunded (see credit notes)');
  });
});

describe('renderCreditNotePdf', () => {
  it('credits a refund against the invoice with the invoice GST split', async () => {
    const t = await text(renderCreditNotePdf(creditNote(), { compress: false, fontDir: null }));
    expect(t).toContain('Credit note');
    expect(t).toContain('Number: CN/26-27/000007');
    expect(t).toContain('Against invoice CPI/26-27/000042 of ');
    expect(t).toContain('Refund: Sprint plan');
    // 5,900 including 18% GST: 5,000 taxable + 900 tax, 450 each.
    expect(t).toContain('INR 50.00');
    expect(t).toContain('CGST @ 9%');
    expect(t.match(/INR 4\.50/g)).toHaveLength(2);
    expect(t).toContain('Total credited (GST included)');
    expect(t).toContain('refund rfnd_1');
  });

  it('is a plain credit note against a receipt without a seller GSTIN', async () => {
    const t = await text(
      renderCreditNotePdf(creditNote({ seller: DEFAULT_SETTINGS.billing }), {
        compress: false,
        fontDir: null,
      }),
    );
    expect(t).toContain('Against receipt CPI/26-27/000042');
    expect(t).toContain('Total credited');
    expect(t).not.toContain('GST');
  });
});

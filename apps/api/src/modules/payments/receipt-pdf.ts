import { existsSync } from 'node:fs';
import { gstBreakdown, type BillingSetting } from '@cbi/shared-types';
import PDFDocument from 'pdfkit';

/** Printed as the seller when the billing setting has no legal name. */
export const PRODUCT_NAME = 'CareerPilot Interview by CodeBegun';

const REPLACEMENTS: Record<string, string> = {
  '‘': "'",
  '’': "'",
  '“': '"',
  '”': '"',
  '–': '-',
  '—': '-',
  '…': '...',
  '•': '-',
  '₹': 'INR ',
};

/**
 * The standard PDF fonts only cover Latin-1 (as in the worker's report PDF).
 * Typographic punctuation is mapped to plain equivalents; returns null when
 * anything else would be lost, so the caller can leave the text out rather
 * than print "?" in a name.
 */
export function latin1(text: string): string | null {
  const { out, lossy } = toLatin1(text);
  return lossy ? null : out;
}

function toLatin1(text: string): { out: string; lossy: boolean } {
  let lossy = false;
  const out = [...text]
    .map((ch) => {
      if (REPLACEMENTS[ch]) return REPLACEMENTS[ch];
      const code = ch.codePointAt(0)!;
      if (code === 10) return ch;
      if (code >= 32 && code <= 255 && !(code >= 127 && code < 160)) return ch;
      lossy = true;
      return '?';
    })
    .join('');
  return { out, lossy };
}

/** `INR 1,499.00` (the rupee sign is not in the standard fonts). */
export function receiptMoney(minor: number, currency: string): string {
  const amount = new Intl.NumberFormat('en-IN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(minor / 100);
  return `${currency} ${amount}`;
}

export interface ReceiptInput {
  invoiceNumber: string;
  issuedAt: Date;
  seller: BillingSetting;
  buyer: { name: string | null; email: string | null };
  plan: { name: string; credits: number; validityDays: number | null };
  couponCode: string | null;
  listPriceMinor: number;
  discountMinor: number;
  totalMinor: number;
  refundedMinor: number;
  currency: string;
  payment: { provider: string; paymentId: string | null } | null;
  purchaseId: string;
}

export interface ReceiptOptions {
  /**
   * A TrueType/OpenType font with the scripts candidates' names use (e.g.
   * Noto Sans with Devanagari and Telugu). Without it names outside Latin-1
   * are left off the receipt; the email identifies the buyer.
   */
  fontPath?: string | null;
  /** Tests: leave content streams uncompressed so the text can be read back. */
  compress?: boolean;
}

/** The IST calendar date, e.g. 24 Sep 2026. */
const istDate = (at: Date) =>
  new Intl.DateTimeFormat('en-IN', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    timeZone: 'Asia/Kolkata',
  }).format(at);

/**
 * Renders a purchase receipt as an A4 PDF. With a seller GSTIN in the billing
 * setting it is a tax invoice: GSTIN, SAC code and the GST included in the
 * price. Otherwise it is a plain receipt.
 */
export function renderReceiptPdf(input: ReceiptInput, opts: ReceiptOptions = {}): Promise<Buffer> {
  const unicode = opts.fontPath && existsSync(opts.fontPath) ? opts.fontPath : null;
  const taxInvoice = input.seller.gstin !== null;
  const title = taxInvoice ? 'Tax invoice' : 'Receipt';
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'A4',
      margin: 50,
      compress: opts.compress ?? true,
      info: { Title: `${title} ${input.invoiceNumber}` },
    });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    if (unicode) doc.registerFont('Body', unicode);
    const regular = unicode ? 'Body' : 'Helvetica';
    const bold = unicode ? 'Body' : 'Helvetica-Bold';
    /** Text as printable in the current font, or null when it would lose characters. */
    const printable = (text: string) => (unicode ? text : latin1(text));
    /** Labels we write ourselves: never dropped (anything unprintable becomes "?"). */
    const label = (text: string) => (unicode ? text : toLatin1(text).out);
    const line = (text: string, size = 10, font = regular) => {
      const safe = printable(text);
      if (safe !== null) doc.font(font).fontSize(size).text(safe);
    };
    const row = (name: string, value: string, strong = false) => {
      const y = doc.y;
      doc
        .font(strong ? bold : regular)
        .fontSize(10)
        .text(label(name), 50, y, { width: 330 });
      doc.text(label(value), 380, y, { width: 165, align: 'right' });
      doc.moveDown(0.3);
      doc.x = 50;
    };

    const sellerName = input.seller.legalName || PRODUCT_NAME;
    doc.font(bold).fontSize(16).text(label(sellerName));
    if (input.seller.address) doc.font(regular).fontSize(9).text(label(input.seller.address));
    if (taxInvoice) line(`GSTIN: ${input.seller.gstin}`, 9);
    doc.moveDown(1);

    line(title, 18, bold);
    line(`Number: ${input.invoiceNumber}`);
    line(`Date: ${istDate(input.issuedAt)}`);
    line(`Purchase: ${input.purchaseId}`, 9);
    doc.moveDown(0.8);

    line('Billed to', 11, bold);
    const name = input.buyer.name?.trim() ? printable(input.buyer.name.trim()) : null;
    if (name) line(name);
    if (input.buyer.email) line(input.buyer.email);
    doc.moveDown(0.8);

    line('Details', 11, bold);
    const validity =
      input.plan.validityDays === null
        ? 'no expiry'
        : `valid ${input.plan.validityDays} day${input.plan.validityDays === 1 ? '' : 's'}`;
    row(
      `${input.plan.name} plan: ${input.plan.credits} interview credit${input.plan.credits === 1 ? '' : 's'}, ${validity}`,
      receiptMoney(input.listPriceMinor, input.currency),
    );
    if (taxInvoice && input.seller.sacCode) row(`SAC ${input.seller.sacCode}`, '');
    if (input.discountMinor > 0) {
      row(
        input.couponCode ? `Discount (coupon ${input.couponCode})` : 'Discount',
        `- ${receiptMoney(input.discountMinor, input.currency)}`,
      );
    }
    if (taxInvoice) {
      const { taxableMinor, taxMinor } = gstBreakdown(
        input.totalMinor,
        input.seller.taxRatePercent,
      );
      row('Taxable value', receiptMoney(taxableMinor, input.currency));
      row(`GST @ ${input.seller.taxRatePercent}%`, receiptMoney(taxMinor, input.currency));
    }
    row(
      taxInvoice ? 'Total (GST included)' : 'Total paid',
      receiptMoney(input.totalMinor, input.currency),
      true,
    );
    if (input.refundedMinor > 0) {
      row('Refunded', `- ${receiptMoney(input.refundedMinor, input.currency)}`);
    }
    doc.moveDown(0.8);

    if (input.payment?.paymentId) {
      line(`Paid online via ${input.payment.provider} (payment ${input.payment.paymentId}).`, 9);
    } else if (input.totalMinor === 0) {
      line('No payment was due (fully discounted).', 9);
    }
    if (!taxInvoice) line('This receipt is not a tax invoice.', 9);
    line('This is a computer-generated document and needs no signature.', 9);

    doc.end();
  });
}

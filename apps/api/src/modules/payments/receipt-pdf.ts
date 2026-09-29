import { existsSync } from 'node:fs';
import {
  defaultFontDir,
  fontsAvailable,
  registerScriptFonts,
  writeScriptText,
} from '@cbi/pdf-fonts';
import { gstSplit, gstStateLabel, type BillingSetting } from '@cbi/shared-types';
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
 * The standard PDF fonts only cover Latin-1. Typographic punctuation is
 * mapped to plain equivalents; returns null when anything else would be
 * lost, so the caller can leave the text out rather than print "?" in a name.
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

/** `INR 1,499.00` (the currency code, as on the standard-font fallback). */
export function receiptMoney(minor: number, currency: string): string {
  const amount = new Intl.NumberFormat('en-IN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(minor / 100);
  return `${currency} ${amount}`;
}

export interface ReceiptBuyer {
  name: string | null;
  email: string | null;
  /** GST state code (place of supply); null when not given. */
  state: string | null;
}

export interface ReceiptInput {
  invoiceNumber: string;
  issuedAt: Date;
  seller: BillingSetting;
  buyer: ReceiptBuyer;
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

export interface CreditNoteInput {
  creditNoteNumber: string;
  issuedAt: Date;
  /** The invoice (or receipt) the refund is against. */
  invoice: { number: string; issuedAt: Date };
  seller: BillingSetting;
  buyer: ReceiptBuyer;
  plan: { name: string };
  /** The refunded amount, GST included. */
  amountMinor: number;
  currency: string;
  refundId: string | null;
  purchaseId: string;
}

export interface ReceiptOptions {
  /**
   * RECEIPT_FONT_PATH: one TrueType/OpenType font used for all text instead
   * of the embedded fonts (e.g. one covering scripts beyond Latin, Hindi and
   * Telugu).
   */
  fontPath?: string | null;
  /**
   * The embedded fonts' directory (default: the fonts shipped with
   * @cbi/pdf-fonts); null forces the standard fonts, which leave names
   * outside Latin-1 off the document (the email identifies the buyer).
   */
  fontDir?: string | null;
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

type FontMode =
  { kind: 'standard' } | { kind: 'single'; path: string } | { kind: 'scripts'; dir: string };

/** Writes text in the document's font mode (see {@link ReceiptOptions}). */
interface Writer {
  doc: PDFKit.PDFDocument;
  /** A line of text; a name that cannot be printed (standard fonts) is left out. */
  line(text: string, size?: number, bold?: boolean): void;
  /** A label and an amount on one row. */
  row(name: string, value: string, strong?: boolean): void;
}

function fontModes(opts: ReceiptOptions): FontMode[] {
  const modes: FontMode[] = [];
  if (opts.fontPath && existsSync(opts.fontPath))
    modes.push({ kind: 'single', path: opts.fontPath });
  else {
    const dir = opts.fontDir === undefined ? defaultFontDir() : opts.fontDir;
    if (dir !== null && fontsAvailable(dir)) modes.push({ kind: 'scripts', dir });
  }
  modes.push({ kind: 'standard' });
  return modes;
}

/**
 * Renders an A4 document with the best fonts available, falling back to the
 * standard fonts when the embedded ones fail (e.g. shaping unusual text), so
 * a document is always produced.
 */
async function renderDocument(
  infoTitle: string,
  opts: ReceiptOptions,
  body: (w: Writer) => void,
): Promise<Buffer> {
  const modes = fontModes(opts);
  for (const [i, mode] of modes.entries()) {
    try {
      return await render(mode, infoTitle, opts, body);
    } catch (err) {
      if (i === modes.length - 1) throw err;
    }
  }
  throw new Error('unreachable');
}

function render(
  mode: FontMode,
  infoTitle: string,
  opts: ReceiptOptions,
  body: (w: Writer) => void,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'A4',
      margin: 50,
      compress: opts.compress ?? true,
      info: { Title: infoTitle },
    });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    if (mode.kind === 'single') doc.registerFont('Body', mode.path);
    if (mode.kind === 'scripts') registerScriptFonts(doc, mode.dir);
    const standardFont = (bold: boolean) => (bold ? 'Helvetica-Bold' : 'Helvetica');

    /** Writes `text` (a name: dropped when lossy in the standard fonts; a label: never). */
    const put = (
      text: string,
      size: number,
      bold: boolean,
      options: PDFKit.Mixins.TextOptions,
      at: { x: number; y: number } | undefined,
      dropLossy: boolean,
    ) => {
      if (mode.kind === 'scripts') {
        writeScriptText(doc, text, bold ? 'bold' : 'regular', size, options, at);
        return;
      }
      let out = text;
      if (mode.kind === 'standard') {
        const { out: safe, lossy } = toLatin1(text);
        if (lossy && dropLossy) return;
        out = safe;
      }
      doc.font(mode.kind === 'single' ? 'Body' : standardFont(bold)).fontSize(size);
      if (at) doc.text(out, at.x, at.y, options);
      else doc.text(out, options);
    };

    const writer: Writer = {
      doc,
      line: (text, size = 10, bold = false) => put(text, size, bold, {}, undefined, true),
      row: (name, value, strong = false) => {
        const y = doc.y;
        put(name, 10, strong, { width: 330 }, { x: 50, y }, false);
        const after = doc.y;
        put(value, 10, strong, { width: 165, align: 'right' }, { x: 380, y }, false);
        doc.y = Math.max(after, doc.y);
        doc.moveDown(0.3);
        doc.x = 50;
      },
    };
    body(writer);
    doc.end();
  });
}

/** Seller name, address and GSTIN, then the title block. */
function heading(
  w: Writer,
  seller: BillingSetting,
  title: string,
  lines: string[],
  buyer: ReceiptBuyer,
) {
  w.line(seller.legalName || PRODUCT_NAME, 16, true);
  if (seller.address) w.line(seller.address, 9);
  if (seller.gstin) {
    w.line(`GSTIN: ${seller.gstin}`, 9);
    w.line(`State: ${gstStateLabel(seller.gstin.slice(0, 2))}`, 9);
  }
  w.doc.moveDown(1);
  w.line(title, 18, true);
  lines.forEach((l, i) => w.line(l, i === lines.length - 1 ? 9 : 10));
  w.doc.moveDown(0.8);

  w.line('Billed to', 11, true);
  const name = buyer.name?.trim();
  if (name) w.line(name);
  if (buyer.email) w.line(buyer.email);
  if (seller.gstin) {
    w.line(
      buyer.state
        ? `Place of supply: ${gstStateLabel(buyer.state)}`
        : 'Place of supply: not stated (IGST applies)',
      9,
    );
  }
  w.doc.moveDown(0.8);
}

/** Taxable value and CGST + SGST (same state) or IGST for a GST-inclusive amount. */
function taxRows(
  w: Writer,
  seller: BillingSetting,
  buyerState: string | null,
  amountMinor: number,
  currency: string,
) {
  const rate = seller.taxRatePercent;
  const split = gstSplit(amountMinor, rate, seller.gstin?.slice(0, 2) ?? null, buyerState);
  w.row('Taxable value', receiptMoney(split.taxableMinor, currency));
  if (split.supply === 'INTRA') {
    w.row(`CGST @ ${rate / 2}%`, receiptMoney(split.cgstMinor, currency));
    w.row(`SGST @ ${rate / 2}%`, receiptMoney(split.sgstMinor, currency));
  } else {
    w.row(`IGST @ ${rate}%`, receiptMoney(split.igstMinor, currency));
  }
}

/**
 * Renders a purchase receipt as an A4 PDF. With a seller GSTIN in the billing
 * setting it is a tax invoice: GSTIN, SAC code, place of supply and the GST
 * included in the price, as CGST + SGST when the buyer is in the seller's
 * state and IGST otherwise (or when the buyer's state is unknown). Otherwise
 * it is a plain receipt.
 */
export function renderReceiptPdf(input: ReceiptInput, opts: ReceiptOptions = {}): Promise<Buffer> {
  const taxInvoice = input.seller.gstin !== null;
  const title = taxInvoice ? 'Tax invoice' : 'Receipt';
  return renderDocument(`${title} ${input.invoiceNumber}`, opts, (w) => {
    heading(
      w,
      input.seller,
      title,
      [
        `Number: ${input.invoiceNumber}`,
        `Date: ${istDate(input.issuedAt)}`,
        `Purchase: ${input.purchaseId}`,
      ],
      input.buyer,
    );

    w.line('Details', 11, true);
    const validity =
      input.plan.validityDays === null
        ? 'no expiry'
        : `valid ${input.plan.validityDays} day${input.plan.validityDays === 1 ? '' : 's'}`;
    w.row(
      `${input.plan.name} plan: ${input.plan.credits} interview credit${input.plan.credits === 1 ? '' : 's'}, ${validity}`,
      receiptMoney(input.listPriceMinor, input.currency),
    );
    if (taxInvoice && input.seller.sacCode) w.row(`SAC ${input.seller.sacCode}`, '');
    if (input.discountMinor > 0) {
      w.row(
        input.couponCode ? `Discount (coupon ${input.couponCode})` : 'Discount',
        `- ${receiptMoney(input.discountMinor, input.currency)}`,
      );
    }
    if (taxInvoice) {
      taxRows(w, input.seller, input.buyer.state, input.totalMinor, input.currency);
    }
    w.row(
      taxInvoice ? 'Total (GST included)' : 'Total paid',
      receiptMoney(input.totalMinor, input.currency),
      true,
    );
    if (input.refundedMinor > 0) {
      w.row(
        'Refunded (see credit notes)',
        `- ${receiptMoney(input.refundedMinor, input.currency)}`,
      );
    }
    w.doc.moveDown(0.8);

    if (input.payment?.paymentId) {
      w.line(`Paid online via ${input.payment.provider} (payment ${input.payment.paymentId}).`, 9);
    } else if (input.totalMinor === 0) {
      w.line('No payment was due (fully discounted).', 9);
    }
    if (!taxInvoice) w.line('This receipt is not a tax invoice.', 9);
    w.line('This is a computer-generated document and needs no signature.', 9);
  });
}

/**
 * Renders the credit note of one processed refund: the amount credited
 * against the original invoice, with the same GST split as that invoice.
 */
export function renderCreditNotePdf(
  input: CreditNoteInput,
  opts: ReceiptOptions = {},
): Promise<Buffer> {
  const taxInvoice = input.seller.gstin !== null;
  return renderDocument(`Credit note ${input.creditNoteNumber}`, opts, (w) => {
    heading(
      w,
      input.seller,
      'Credit note',
      [
        `Number: ${input.creditNoteNumber}`,
        `Date: ${istDate(input.issuedAt)}`,
        `Against ${taxInvoice ? 'invoice' : 'receipt'} ${input.invoice.number} of ${istDate(input.invoice.issuedAt)}`,
        `Purchase: ${input.purchaseId}`,
      ],
      input.buyer,
    );

    w.line('Details', 11, true);
    w.row(`Refund: ${input.plan.name} plan`, receiptMoney(input.amountMinor, input.currency));
    if (taxInvoice && input.seller.sacCode) w.row(`SAC ${input.seller.sacCode}`, '');
    if (taxInvoice) {
      taxRows(w, input.seller, input.buyer.state, input.amountMinor, input.currency);
    }
    w.row(
      taxInvoice ? 'Total credited (GST included)' : 'Total credited',
      receiptMoney(input.amountMinor, input.currency),
      true,
    );
    w.doc.moveDown(0.8);
    if (input.refundId)
      w.line(`Refunded to the original payment method (refund ${input.refundId}).`, 9);
    w.line('This is a computer-generated document and needs no signature.', 9);
  });
}

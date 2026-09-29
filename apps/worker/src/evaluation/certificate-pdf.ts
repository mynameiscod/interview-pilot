import type { ReadinessBand } from '@cbi/shared-types';
import PDFDocument from 'pdfkit';
import {
  BAND_LABELS,
  createTextWriter,
  fontDir,
  fontsAvailable,
  pdfSafe,
  type RenderOptions,
} from './pdf.js';

/** What a readiness certificate states; frozen when it was issued. */
export interface CertificateFacts {
  code: string;
  candidateName: string | null;
  roleTitle: string;
  overall: number | null;
  band: ReadinessBand;
  completedAt: Date | null;
  issuedAt: Date;
  /** The public verification page, `<candidate site>/verify/<code>`. */
  verifyUrl: string;
}

const PRODUCT = 'CareerPilot Interview by CodeBegun';
const DISCLAIMER =
  'This certificate records the result of an AI-assessed practice interview. It is guidance on interview readiness, not a hiring decision, a qualification or an endorsement by any employer.';

const longDate = (d: Date) =>
  new Intl.DateTimeFormat('en-IN', { dateStyle: 'long', timeZone: 'Asia/Kolkata' }).format(d);

/**
 * Renders a one-page, landscape A4 readiness certificate. Names and role
 * titles in Hindi or Telugu use the report's embedded fonts; without them
 * (or if shaping fails) it falls back to the standard fonts, as reports do.
 */
export async function renderCertificatePdf(
  facts: CertificateFacts,
  options: RenderOptions = {},
): Promise<Buffer> {
  const dir = options.fontDir === undefined ? fontDir() : options.fontDir;
  if (dir === null || !fontsAvailable(dir)) return render(facts, null, options);
  try {
    return await render(facts, dir, options);
  } catch {
    return render(facts, null, options);
  }
}

function render(facts: CertificateFacts, dir: string | null, options: RenderOptions) {
  return new Promise<Buffer>((resolve, reject) => {
    const title = `Readiness certificate ${facts.code}`;
    const doc = new PDFDocument({
      size: 'A4',
      layout: 'landscape',
      margin: 60,
      compress: options.compress ?? true,
      info: { Title: dir ? title : pdfSafe(title) },
    });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    const write = createTextWriter(doc, dir);
    const width = doc.page.width - 120;
    const centred = { align: 'center' as const, width };

    // A double rule frames the page (printable in black and white).
    doc
      .lineWidth(2)
      .rect(24, 24, doc.page.width - 48, doc.page.height - 48)
      .stroke();
    doc
      .lineWidth(0.5)
      .rect(32, 32, doc.page.width - 64, doc.page.height - 64)
      .stroke();

    doc.x = 60;
    doc.y = 80;
    write(PRODUCT.toUpperCase(), 'bold', 10, centred).moveDown(1.2);
    write('Certificate of interview readiness', 'bold', 28, centred).moveDown(1);
    write('This certifies that', 'regular', 12, centred).moveDown(0.4);
    write(facts.candidateName ?? 'the candidate', 'bold', 24, centred).moveDown(0.4);
    write('completed a practice interview for the role of', 'regular', 12, centred).moveDown(0.4);
    write(facts.roleTitle, 'bold', 18, centred).moveDown(0.6);
    const when = facts.completedAt ? ` on ${longDate(facts.completedAt)}` : '';
    write(`and was assessed${when} as`, 'regular', 12, centred).moveDown(0.4);
    write(BAND_LABELS[facts.band], 'bold', 20, centred).moveDown(0.3);
    if (facts.overall !== null) {
      write(`Overall readiness: ${facts.overall} / 100`, 'regular', 12, centred);
    }
    doc.moveDown(1.5);
    write(
      `Issued ${longDate(facts.issuedAt)}   ·   Certificate ${facts.code}`,
      'regular',
      10,
      centred,
    ).moveDown(0.3);
    write(`Check it at ${facts.verifyUrl}`, 'regular', 10, {
      ...centred,
      link: facts.verifyUrl,
      underline: true,
    }).moveDown(1.2);
    write(DISCLAIMER, 'italic', 8, centred);
    doc.end();
  });
}

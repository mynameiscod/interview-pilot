import type { ReportContent } from '@cbi/shared-types';
import PDFDocument from 'pdfkit';

const BAND_LABELS: Record<ReportContent['overall']['band'], string> = {
  READY: 'Interview-ready',
  READY_WITH_GAPS: 'Interview-ready with gaps',
  DEVELOPING: 'Developing',
  NOT_YET: 'Not yet ready',
  INSUFFICIENT_EVIDENCE: 'Not enough evidence to score',
};

const REPLACEMENTS: Record<string, string> = {
  '‘': "'",
  '’': "'",
  '“': '"',
  '”': '"',
  '–': '-',
  '—': '-',
  '…': '...',
  '•': '-',
  '→': '->',
};

/**
 * The standard PDF fonts only cover Latin-1. Typographic punctuation is
 * mapped to plain equivalents and anything else becomes "?". (Report text is
 * generated in English; localised PDFs need embedded fonts.)
 */
export function pdfSafe(text: string): string {
  return [...text]
    .map((ch) => {
      if (REPLACEMENTS[ch]) return REPLACEMENTS[ch];
      const code = ch.codePointAt(0)!;
      if (code === 9 || code === 10 || code === 13) return ch;
      return code >= 32 && code <= 255 && !(code >= 127 && code < 160) ? ch : '?';
    })
    .join('');
}

const date = (iso: string | null) => (iso ? new Date(iso).toISOString().slice(0, 10) : '-');

/** Renders the readiness report as an A4 PDF. */
export function renderReportPdf(content: ReportContent): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'A4',
      margin: 50,
      info: { Title: pdfSafe(`Readiness report - ${content.header.title}`) },
    });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const h1 = (t: string) =>
      doc.font('Helvetica-Bold').fontSize(18).text(pdfSafe(t)).moveDown(0.3);
    const h2 = (t: string) =>
      doc.moveDown(0.8).font('Helvetica-Bold').fontSize(13).text(pdfSafe(t)).moveDown(0.3);
    const p = (t: string, size = 10) =>
      doc.font('Helvetica').fontSize(size).text(pdfSafe(t)).moveDown(0.2);
    const bullet = (t: string) =>
      doc
        .font('Helvetica')
        .fontSize(10)
        .text(pdfSafe(`- ${t}`), { indent: 10 })
        .moveDown(0.1);

    const { header, overall } = content;
    h1('Interview readiness report');
    p(`${header.title}${header.companyName ? ` at ${header.companyName}` : ''}`, 12);
    p(
      `Date: ${date(header.endedAt ?? header.startedAt)}   Mode: ${header.mode.toLowerCase()}   Duration: ${Math.round(header.durationSec / 60)} min`,
    );

    h2('Overall readiness');
    p(
      `${overall.score === null ? 'No overall score' : `${overall.score} / 100`} - ${BAND_LABELS[overall.band]}`,
      12,
    );
    p(`Evidence confidence: ${overall.confidence.level.toLowerCase()}`);
    p(content.summary);

    h2('Dimensions');
    for (const d of content.dimensions) {
      doc
        .font('Helvetica-Bold')
        .fontSize(10)
        .text(
          pdfSafe(
            `${d.name}: ${d.score === null ? 'not assessed' : `${d.score} / 100`} (weight ${d.weight}%)`,
          ),
        );
      if (d.rationale) p(d.rationale, 9);
      for (const e of d.evidence.slice(0, 2)) bullet(e.claim);
      doc.moveDown(0.3);
    }

    if (content.strengths.length) {
      h2('Strengths');
      content.strengths.forEach((s) => bullet(s.text));
    }
    if (content.gaps.length) {
      h2('Gaps to work on');
      content.gaps.forEach((g) => bullet(g.text));
    }

    h2('Your plan');
    for (const [label, items] of [
      ['Next 24 hours', content.plan.next24h],
      ['Next 3 days', content.plan.next3Days],
      ['Next 7 days', content.plan.next7Days],
    ] as const) {
      doc.font('Helvetica-Bold').fontSize(10).text(label);
      items.forEach((i) => bullet(`${i.action} (${i.why})`));
      doc.moveDown(0.2);
    }

    if (content.previous) {
      h2('Progress since your last attempt');
      p(
        `Previous overall: ${content.previous.overall ?? '-'} on ${date(content.previous.endedAt)}`,
      );
      content.previous.deltas.forEach((d) =>
        bullet(`${d.name}: ${d.delta > 0 ? '+' : ''}${d.delta}`),
      );
    }

    doc.moveDown(1);
    doc.font('Helvetica-Oblique').fontSize(8).text(pdfSafe(content.disclaimer));
    doc.end();
  });
}

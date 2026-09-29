import {
  defaultFontDir,
  fontsAvailable,
  pdfSafe,
  registerScriptFonts,
  STANDARD_FONTS,
  writeScriptText,
  type Style,
} from '@cbi/pdf-fonts';
import type { ReportContent } from '@cbi/shared-types';
import PDFDocument from 'pdfkit';

const BAND_LABELS: Record<ReportContent['overall']['band'], string> = {
  READY: 'Interview-ready',
  READY_WITH_GAPS: 'Interview-ready with gaps',
  DEVELOPING: 'Developing',
  NOT_YET: 'Not yet ready',
  INSUFFICIENT_EVIDENCE: 'Not enough evidence to score',
};

/** `REPORT_FONT_DIR`, else the fonts shipped with @cbi/pdf-fonts. */
export function fontDir(): string {
  return process.env.REPORT_FONT_DIR || defaultFontDir();
}

const date = (iso: string | null) => (iso ? new Date(iso).toISOString().slice(0, 10) : '-');

export interface RenderOptions {
  /** Font directory; null forces the standard-font fallback. Defaults to {@link fontDir}. */
  fontDir?: string | null;
  /** Compress page streams (tests turn it off to inspect the output). */
  compress?: boolean;
}

/** Neutral wording for integrity observations. */
const INTEGRITY_LABELS: Record<string, string> = {
  TAB_HIDDEN: 'Switched to another tab or app',
  WINDOW_BLUR: 'Interview window lost focus',
  FULLSCREEN_EXIT: 'Left full screen',
  PASTE: 'Pasted text into an answer',
  CAMERA_LOST: 'Camera stopped',
  MICROPHONE_LOST: 'Microphone stopped',
};

/**
 * Renders the readiness report as an A4 PDF. With the embedded fonts present
 * any mix of English, Hindi and Telugu renders; without them (or if shaping
 * fails on some unusual text) it falls back to the standard fonts and
 * {@link pdfSafe}, so a report always gets a PDF.
 */
export async function renderReportPdf(
  content: ReportContent,
  options: RenderOptions = {},
): Promise<Buffer> {
  const dir = options.fontDir === undefined ? fontDir() : options.fontDir;
  if (dir === null || !fontsAvailable(dir)) return render(content, null, options);
  try {
    return await render(content, dir, options);
  } catch {
    return render(content, null, options);
  }
}

function render(content: ReportContent, dir: string | null, options: RenderOptions) {
  return new Promise<Buffer>((resolve, reject) => {
    const embedded = dir !== null;
    const title = `Readiness report - ${content.header.title}`;
    const doc = new PDFDocument({
      size: 'A4',
      margin: 50,
      compress: options.compress ?? true,
      // Info strings are written as UTF-16 when needed, so only the fallback needs pdfSafe.
      info: { Title: embedded ? title : pdfSafe(title) },
    });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    if (dir !== null) registerScriptFonts(doc, dir);

    /** One paragraph: a run per script, chained with `continued` so lines still wrap. */
    const write = (t: string, style: Style, size: number, opts: PDFKit.Mixins.TextOptions = {}) => {
      if (!embedded) return doc.fontSize(size).font(STANDARD_FONTS[style]).text(pdfSafe(t), opts);
      return writeScriptText(doc, t, style, size, opts);
    };

    const h1 = (t: string) => write(t, 'bold', 18).moveDown(0.3);
    const h2 = (t: string) => {
      doc.moveDown(0.8);
      return write(t, 'bold', 13).moveDown(0.3);
    };
    const p = (t: string, size = 10) => write(t, 'regular', size).moveDown(0.2);
    const bullet = (t: string) => write(`- ${t}`, 'regular', 10, { indent: 10 }).moveDown(0.1);

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
      write(
        `${d.name}: ${d.score === null ? 'not assessed' : `${d.score} / 100`} (weight ${d.weight}%)`,
        'bold',
        10,
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
      write(label, 'bold', 10);
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

    if (content.coding?.length) {
      h2('Coding');
      for (const c of content.coding) {
        const outcome = c.judgeUnavailable
          ? 'not run (the code judge was unavailable); reviewed from the code'
          : c.passed !== null
            ? `${c.passed} of ${c.total} tests passed`
            : 'no solution';
        bullet(
          `${c.title} (${c.difficulty.toLowerCase()}${c.language ? `, ${c.language}` : ''}): ${outcome}${c.submitted ? '' : ' - not submitted before time ran out'}`,
        );
      }
    }

    if (content.integrity) {
      h2('Session observations');
      const counts = Object.entries(content.integrity.counts).filter(
        ([type]) => type !== 'TAB_VISIBLE' && type !== 'WINDOW_FOCUS',
      );
      if (counts.length === 0) p('No browser events were noted.');
      counts.forEach(([type, n]) => bullet(`${INTEGRITY_LABELS[type] ?? type}: ${n}`));
      if (content.integrity.awaySec > 0) {
        bullet(
          `Time away from the interview page: about ${Math.round(content.integrity.awaySec / 60)} min`,
        );
      }
      write(content.integrity.note, 'italic', 8).fontSize(10);
    }

    doc.moveDown(1);
    write(content.disclaimer, 'italic', 8);
    doc.end();
  });
}

import type { AssessmentPanel, ReportContent } from '@cbi/shared-types';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import PDFDocument from 'pdfkit';

const BAND_LABELS: Record<ReportContent['overall']['band'], string> = {
  READY: 'Interview-ready',
  READY_WITH_GAPS: 'Interview-ready with gaps',
  DEVELOPING: 'Developing',
  NOT_YET: 'Not yet ready',
  INSUFFICIENT_EVIDENCE: 'Not enough evidence to score',
};

/** Panels are reported beside the dimensions, never in the overall score. */
const PANEL_NOTE =
  'Assessed separately from the dimensions above; not part of the overall readiness score.';

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
 * Fallback for when the embedded Noto fonts are missing: the standard PDF
 * fonts only cover Latin-1, so typographic punctuation is mapped to plain
 * equivalents and anything else (Hindi, Telugu, ...) becomes "?".
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

// ---- Embedded fonts ----------------------------------------------------------------------

export type Script = 'latin' | 'devanagari' | 'telugu';
type Style = 'regular' | 'bold' | 'italic';

/** Files under apps/worker/assets/fonts (infrastructure/scripts/fetch-fonts.mjs restores them). */
const FONT_FILES: Record<Script, Partial<Record<Style, string>>> = {
  latin: {
    regular: 'NotoSans-Regular.ttf',
    bold: 'NotoSans-Bold.ttf',
    italic: 'NotoSans-Italic.ttf',
  },
  devanagari: { regular: 'NotoSansDevanagari-Regular.ttf', bold: 'NotoSansDevanagari-Bold.ttf' },
  // Not Noto Sans Telugu: fontkit (pdfkit's shaper) throws on its GPOS for common
  // conjuncts such as "శ్రీ". Hind Guntur shapes every consonant cluster cleanly.
  telugu: { regular: 'HindGuntur-Regular.ttf', bold: 'HindGuntur-Bold.ttf' },
};

const STANDARD_FONTS: Record<Style, string> = {
  regular: 'Helvetica',
  bold: 'Helvetica-Bold',
  italic: 'Helvetica-Oblique',
};

/**
 * `REPORT_FONT_DIR`, else `<package>/assets/fonts`. The module sits two levels
 * below the package root in both src/ and dist/, so one relative path serves both.
 */
export function fontDir(): string {
  return (
    process.env.REPORT_FONT_DIR || fileURLToPath(new URL('../../assets/fonts', import.meta.url))
  );
}

/** Whether the regular face of every script is present (bold/italic are optional). */
export function fontsAvailable(dir = fontDir()): boolean {
  return Object.values(FONT_FILES).every((f) => existsSync(join(dir, f.regular!)));
}

// Includes the danda, which Telugu text also uses but only the Devanagari font has.
const isDevanagari = (c: number) => (c >= 0x0900 && c <= 0x097f) || (c >= 0xa8e0 && c <= 0xa8ff);
const isTelugu = (c: number) => c >= 0x0c00 && c <= 0x0c7f;
/**
 * Characters that stay with the surrounding run: marks, spaces (not the NBSP,
 * which Hind Guntur lacks), digits, the punctuation all three fonts carry (not
 * $ & @ ` or bullets), ZWNJ/ZWJ, dashes, curly quotes and the ellipsis.
 */
const NEUTRAL_ASCII = `0123456789!"#%'()*+,-./:;<=>?[\\]^_{|}~`;
const NEUTRAL_CODES = new Set([
  0x200c, 0x200d, 0x2013, 0x2014, 0x2018, 0x2019, 0x201c, 0x201d, 0x2026,
]);
const isNeutral = (ch: string, code: number) =>
  (/^[\p{M}\s]$/u.test(ch) && code !== 0xa0) ||
  NEUTRAL_ASCII.includes(ch) ||
  NEUTRAL_CODES.has(code);

function scriptOf(ch: string): Script | null {
  const code = ch.codePointAt(0)!;
  if (isDevanagari(code)) return 'devanagari';
  if (isTelugu(code)) return 'telugu';
  return isNeutral(ch, code) ? null : 'latin';
}

/**
 * Splits text into runs per script so each run can use a font that has its
 * glyphs. Neutral characters join the current run (leading ones join the first
 * script that follows); text with no script letters is one Latin run.
 */
export function scriptRuns(text: string): { script: Script; text: string }[] {
  const runs: { script: Script; text: string }[] = [];
  let pending = '';
  for (const ch of text) {
    const last = runs.at(-1);
    const script = scriptOf(ch);
    if (script === null) {
      if (last) last.text += ch;
      else pending += ch;
    } else if (last?.script === script) {
      last.text += ch;
    } else {
      runs.push({ script, text: pending + ch });
      pending = '';
    }
  }
  if (pending) runs.push({ script: 'latin', text: pending });
  return runs;
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

    const fontName = (script: Script, style: Style) => `${script}-${style}`;
    if (dir !== null) {
      for (const script of Object.keys(FONT_FILES) as Script[]) {
        for (const style of Object.keys(STANDARD_FONTS) as Style[]) {
          // A style the script lacks (e.g. Telugu italic) or a missing file uses the regular face.
          const file = FONT_FILES[script][style];
          const path = join(
            dir,
            file && existsSync(join(dir, file)) ? file : FONT_FILES[script].regular!,
          );
          doc.registerFont(fontName(script, style), path);
        }
      }
    }

    /** One paragraph: a run per script, chained with `continued` so lines still wrap. */
    const write = (t: string, style: Style, size: number, opts: PDFKit.Mixins.TextOptions = {}) => {
      doc.fontSize(size);
      if (!embedded) return doc.font(STANDARD_FONTS[style]).text(pdfSafe(t), opts);
      // Noto Sans has no arrow glyph.
      const runs = scriptRuns(t.replaceAll('→', '->'));
      doc.font(fontName('latin', style));
      if (runs.length === 0) return doc.text('', opts);
      // pdfkit places each call's baseline at its own font's ascent; pin every run to
      // the Latin font's so mixed-script lines sit on one baseline.
      const ascent =
        ((doc as unknown as { _font: { ascender: number } })._font.ascender / 1000) * size;
      runs.forEach((run, i) =>
        doc
          .font(fontName(run.script, style))
          .text(run.text, { ...opts, baseline: -ascent, continued: i < runs.length - 1 }),
      );
      return doc;
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
          `${c.title} (${c.difficulty.toLowerCase()}${c.language ? `, ${c.language}` : ''}${c.aiAssisted ? ', AI assistant allowed' : ''}): ${outcome}${c.submitted ? '' : ' - not submitted before time ran out'}`,
        );
      }
    }

    const panel = (title: string, note: string, x: AssessmentPanel) => {
      h2(title);
      write(note, 'italic', 8).fontSize(10);
      if (x.fallback) {
        p('The assessment model was unavailable, so this part was not scored.');
        return;
      }
      p(
        `${x.score === null ? 'Not scored' : `${x.score} / 100`}${x.subjects.length ? ` - ${x.subjects.join(', ')}` : ''}`,
        11,
      );
      if (x.summary) p(x.summary, 9);
      for (const d of x.dimensions) {
        write(`${d.name}: ${d.score === null ? 'not assessed' : `${d.score} / 100`}`, 'bold', 10);
        if (d.rationale) p(d.rationale, 9);
      }
    };
    if (content.systemDesign) {
      panel('System design', PANEL_NOTE, content.systemDesign);
    }
    if (content.aiCollaboration) {
      panel('AI collaboration', PANEL_NOTE, content.aiCollaboration);
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

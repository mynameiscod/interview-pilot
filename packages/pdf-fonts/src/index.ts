/// <reference types="pdfkit" />
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The fonts our PDFs embed (the worker's readiness report, the API's
 * receipts and credit notes) and the helpers that write English, Hindi and
 * Telugu with them. The files ship in this package's `fonts` directory
 * (SIL OFL 1.1, licence texts alongside; infrastructure/scripts/fetch-fonts.mjs
 * restores them). Without them callers fall back to the standard PDF fonts,
 * which only cover Latin-1.
 */

export type Script = 'latin' | 'devanagari' | 'telugu';
export type Style = 'regular' | 'bold' | 'italic';

export const FONT_FILES: Record<Script, Partial<Record<Style, string>>> = {
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

/** The standard PDF fonts used when the embedded ones are missing (Latin-1 only). */
export const STANDARD_FONTS: Record<Style, string> = {
  regular: 'Helvetica',
  bold: 'Helvetica-Bold',
  italic: 'Helvetica-Oblique',
};

/**
 * `<package>/fonts`. The module sits one level below the package root in
 * both src/ and dist/, so one relative path serves both (and the deployed
 * package keeps `fonts` through its `files`).
 */
export function defaultFontDir(): string {
  return fileURLToPath(new URL('../fonts', import.meta.url));
}

/** Whether the regular face of every script is present (bold/italic are optional). */
export function fontsAvailable(dir = defaultFontDir()): boolean {
  return Object.values(FONT_FILES).every((f) => existsSync(join(dir, f.regular!)));
}

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
 * Fallback for when the embedded fonts are missing: the standard PDF fonts
 * only cover Latin-1, so typographic punctuation is mapped to plain
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

/** The name a script's face is registered under in a document. */
export const scriptFontName = (script: Script, style: Style) => `${script}-${style}`;

/**
 * Registers every script's faces from `dir` with the document. A style the
 * script lacks (e.g. Telugu italic) or a missing file uses the regular face.
 */
export function registerScriptFonts(doc: PDFKit.PDFDocument, dir: string): void {
  for (const script of Object.keys(FONT_FILES) as Script[]) {
    for (const style of Object.keys(STANDARD_FONTS) as Style[]) {
      const file = FONT_FILES[script][style];
      const path = join(
        dir,
        file && existsSync(join(dir, file)) ? file : FONT_FILES[script].regular!,
      );
      doc.registerFont(scriptFontName(script, style), path);
    }
  }
}

/**
 * Writes one paragraph with the registered script fonts: a run per script,
 * chained with `continued` so lines still wrap. With `at`, the paragraph
 * starts there (as `doc.text(text, x, y, options)` would).
 */
export function writeScriptText(
  doc: PDFKit.PDFDocument,
  text: string,
  style: Style,
  size: number,
  opts: PDFKit.Mixins.TextOptions = {},
  at?: { x: number; y: number },
): PDFKit.PDFDocument {
  doc.fontSize(size);
  // Noto Sans has no arrow glyph.
  const runs = scriptRuns(text.replaceAll('→', '->'));
  doc.font(scriptFontName('latin', style));
  if (runs.length === 0) return at ? doc.text('', at.x, at.y, opts) : doc.text('', opts);
  // pdfkit places each call's baseline at its own font's ascent; pin every run to
  // the Latin font's so mixed-script lines sit on one baseline.
  const ascent = ((doc as unknown as { _font: { ascender: number } })._font.ascender / 1000) * size;
  runs.forEach((run, i) => {
    const runOpts = { ...opts, baseline: -ascent, continued: i < runs.length - 1 };
    doc.font(scriptFontName(run.script, style));
    if (i === 0 && at) doc.text(run.text, at.x, at.y, runOpts);
    else doc.text(run.text, runOpts);
  });
  return doc;
}

import {
  DOCUMENT_LIMITS,
  DOCUMENT_MIME,
  type DocumentLayout,
  type DocumentMime,
  type ExtractionErrorCode,
  type ExtractionWarning,
} from '@cbi/shared-types';
import mammoth from 'mammoth';
import { getDocumentProxy } from 'unpdf';
import { detectDocumentType } from './detect.js';
import {
  countWords,
  docxLayout,
  pdfLayout,
  textLayout,
  type LayoutSignals,
  type PdfPageItems,
} from './layout.js';
import { assertZipWithinLimits, ZipLimitError } from './zip.js';

export class ExtractionError extends Error {
  constructor(
    public readonly code: ExtractionErrorCode,
    options?: { cause?: unknown },
  ) {
    super(`extraction failed (${code})`, options);
    this.name = 'ExtractionError';
  }
}

export interface ExtractedText {
  mime: DocumentMime;
  text: string;
  parser: string;
  warnings: ExtractionWarning[];
  ocrUsed: boolean;
  pages: number | null;
  /** Formatting signals for ATS checks (tables, columns, image-only, length). */
  layout: DocumentLayout;
}

/**
 * Optional OCR for scanned PDFs. The worker passes a hook backed by the
 * `ocr.document` AI route; it returns recognised text, or null to fall back
 * (NO_TEXT with the OCR_NEEDED warning). Only called when the text layer is
 * below DOCUMENT_LIMITS.minTextChars.
 */
export type OcrHook = (
  file: Buffer,
  mime: DocumentMime,
  info: { pages: number | null },
) => Promise<string | null>;

export interface ExtractOptions {
  maxTextChars?: number;
  maxPdfPages?: number;
  maxDocxUncompressedBytes?: number;
  timeoutMs?: number;
  ocr?: OcrHook;
}

/** Collapses whitespace but keeps paragraph breaks; removes control characters. */
export function cleanText(raw: string): string {
  return (
    raw
      .replace(/^\uFEFF/, '')
      .replace(/\r\n?/g, '\n')
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u0008\u000b\u000e-\u001f\u007f]/g, '')
      .replace(/[\t\f\v\u00A0\u2000-\u200B]+/g, ' ')
      .split('\n')
      .map((line) => line.replace(/ {2,}/g, ' ').trim())
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
  );
}

async function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new ExtractionError('CORRUPT')), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** unpdf's merged-text normalisation: collapse spaces, keep line structure, one blank line at most. */
const mergePageTexts = (texts: string[]) =>
  texts
    .join('\n')
    .replace(/[^\S\n]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{3,}/g, '\n\n');

async function pdfText(
  buf: Buffer,
  maxPages: number,
): Promise<{ text: string; pages: number; layout: LayoutSignals }> {
  let pdf;
  try {
    // Text extraction never renders glyphs, so pdf.js font-program evaluation is not reached.
    pdf = await getDocumentProxy(new Uint8Array(buf), {
      stopAtErrors: false,
      disableFontFace: true,
    });
  } catch (err) {
    const name = (err as { name?: string })?.name;
    throw new ExtractionError(name === 'PasswordException' ? 'ENCRYPTED' : 'CORRUPT', {
      cause: err,
    });
  }
  try {
    if (pdf.numPages > maxPages) throw new ExtractionError('TOO_MANY_PAGES');
    // One pass over each page's text runs gives the text (as unpdf's extractText
    // builds it) and the positions the layout checks need.
    const pages: PdfPageItems[] = [];
    const texts: string[] = [];
    for (let n = 1; n <= pdf.numPages; n++) {
      const page = await pdf.getPage(n);
      const content = await page.getTextContent();
      const items = content.items.flatMap((item) =>
        'str' in item
          ? [
              {
                str: item.str,
                x: item.transform[4] as number,
                y: item.transform[5] as number,
                width: item.width,
                hasEOL: item.hasEOL,
              },
            ]
          : [],
      );
      texts.push(items.map((i) => i.str + (i.hasEOL ? '\n' : '')).join(''));
      pages.push({ width: page.view[2]! - page.view[0]!, items });
    }
    const layout = pdfLayout(pages);
    // Two-column resumes read column by column instead of interleaved line by line.
    const text = mergePageTexts(layout.columnText ? [layout.columnText] : texts);
    return {
      text,
      pages: pdf.numPages,
      layout: { tablesSuspected: layout.tablesSuspected, columnsSuspected: layout.columnsSuspected },
    };
  } catch (err) {
    if (err instanceof ExtractionError) throw err;
    throw new ExtractionError('CORRUPT', { cause: err });
  } finally {
    await pdf.loadingTask.destroy().catch(() => undefined);
  }
}

async function docxText(buf: Buffer, maxUncompressed: number): Promise<string> {
  try {
    assertZipWithinLimits(buf, maxUncompressed);
  } catch (err) {
    if (err instanceof ZipLimitError) throw new ExtractionError(err.reason, { cause: err });
    throw new ExtractionError('CORRUPT', { cause: err });
  }
  try {
    const result = await mammoth.extractRawText({ buffer: buf });
    return result.value;
  } catch (err) {
    throw new ExtractionError('CORRUPT', { cause: err });
  }
}

/**
 * Extracts bounded, cleaned text from an untrusted PDF, DOCX or text file.
 * The type comes from the bytes. Scanned PDFs (no text layer) go through the
 * OCR hook when provided, otherwise fail with NO_TEXT + OCR_NEEDED.
 */
export async function extractDocumentText(
  buf: Buffer,
  opts: ExtractOptions = {},
): Promise<ExtractedText> {
  const maxChars = opts.maxTextChars ?? DOCUMENT_LIMITS.maxTextChars;
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const mime = detectDocumentType(buf);
  if (!mime) throw new ExtractionError('UNSUPPORTED_TYPE');

  const warnings: ExtractionWarning[] = [];
  let raw: string;
  let parser: string;
  let pages: number | null = null;
  let ocrUsed = false;
  let signals: LayoutSignals;
  let imageOnly = false;

  switch (mime) {
    case DOCUMENT_MIME.PDF: {
      const pdf = await withTimeout(
        pdfText(buf, opts.maxPdfPages ?? DOCUMENT_LIMITS.maxPdfPages),
        timeoutMs,
      );
      raw = pdf.text;
      pages = pdf.pages;
      parser = 'unpdf';
      signals = pdf.layout;
      if (cleanText(raw).length < DOCUMENT_LIMITS.minTextChars) {
        warnings.push('OCR_NEEDED');
        imageOnly = true;
        const ocrText = opts.ocr ? await opts.ocr(buf, mime, { pages }).catch(() => null) : null;
        if (ocrText && cleanText(ocrText).length >= DOCUMENT_LIMITS.minTextChars) {
          raw = ocrText;
          ocrUsed = true;
          parser = 'ocr';
        } else if (cleanText(raw).length === 0) {
          throw new ExtractionError('NO_TEXT');
        }
      }
      break;
    }
    case DOCUMENT_MIME.DOCX:
      raw = await withTimeout(
        docxText(buf, opts.maxDocxUncompressedBytes ?? DOCUMENT_LIMITS.maxDocxUncompressedBytes),
        timeoutMs,
      );
      parser = 'mammoth';
      // docxText has already checked the archive against the zip-bomb limits.
      signals = docxLayout(buf);
      break;
    default:
      raw = buf.toString('utf8');
      parser = 'text';
      signals = textLayout(raw);
  }

  let text = cleanText(raw);
  if (text.length === 0) throw new ExtractionError('NO_TEXT');
  if (text.length > maxChars) {
    text = text.slice(0, maxChars);
    warnings.push('TEXT_TRUNCATED');
  }
  const layout: DocumentLayout = { pages, words: countWords(text), ...signals, imageOnly };
  return { mime, text, parser, warnings, ocrUsed, pages, layout };
}

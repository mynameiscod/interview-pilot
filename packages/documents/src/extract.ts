import {
  DOCUMENT_LIMITS,
  DOCUMENT_MIME,
  type DocumentMime,
  type ExtractionErrorCode,
  type ExtractionWarning,
} from '@cbi/shared-types';
import mammoth from 'mammoth';
import { extractText, getDocumentProxy } from 'unpdf';
import { detectDocumentType } from './detect.js';
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
}

/**
 * Optional OCR for scanned PDFs. No OCR provider is configured in Phase 3;
 * when one is (an `ocr.document` route), the worker passes a hook that
 * returns recognised text, or null to fall back.
 */
export type OcrHook = (file: Buffer, mime: DocumentMime) => Promise<string | null>;

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

async function pdfText(buf: Buffer, maxPages: number): Promise<{ text: string; pages: number }> {
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
    const { text } = await extractText(pdf, { mergePages: true });
    return { text, pages: pdf.numPages };
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

  switch (mime) {
    case DOCUMENT_MIME.PDF: {
      const pdf = await withTimeout(
        pdfText(buf, opts.maxPdfPages ?? DOCUMENT_LIMITS.maxPdfPages),
        timeoutMs,
      );
      raw = pdf.text;
      pages = pdf.pages;
      parser = 'unpdf';
      if (cleanText(raw).length < DOCUMENT_LIMITS.minTextChars) {
        warnings.push('OCR_NEEDED');
        const ocrText = opts.ocr ? await opts.ocr(buf, mime).catch(() => null) : null;
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
      break;
    default:
      raw = buf.toString('utf8');
      parser = 'text';
  }

  let text = cleanText(raw);
  if (text.length === 0) throw new ExtractionError('NO_TEXT');
  if (text.length > maxChars) {
    text = text.slice(0, maxChars);
    warnings.push('TEXT_TRUNCATED');
  }
  return { mime, text, parser, warnings, ocrUsed, pages };
}

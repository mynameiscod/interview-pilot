import { DOCUMENT_MIME } from '@cbi/shared-types';
import { strToU8, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { detectDocumentType, looksLikeText } from './detect.js';
import { cleanText, extractDocumentText, ExtractionError } from './extract.js';
import { buildDocx, buildDocxBomb, buildPdf, SAMPLE_RESUME_LINES } from './testing.js';
import { assertZipWithinLimits, listZipEntries } from './zip.js';

/** Parsing fixtures (Phase 3 exit criterion): every fixture is generated in code. */

async function code(buf: Buffer, opts: Parameters<typeof extractDocumentText>[1] = {}) {
  const err = await extractDocumentText(buf, opts).catch((e: unknown) => e);
  expect(err).toBeInstanceOf(ExtractionError);
  return (err as ExtractionError).code;
}

describe('type detection (by bytes, never by name)', () => {
  it('recognises PDF, DOCX and UTF-8 text', () => {
    expect(detectDocumentType(buildPdf([['hi']]))).toBe(DOCUMENT_MIME.PDF);
    expect(detectDocumentType(buildDocx(['hi']))).toBe(DOCUMENT_MIME.DOCX);
    expect(detectDocumentType(Buffer.from('\uFEFFplain résumé text\n'))).toBe(DOCUMENT_MIME.TXT);
  });

  it('rejects other zips, executables, images and binary data', () => {
    expect(detectDocumentType(Buffer.from(zipSync({ 'a.txt': strToU8('x') })))).toBeNull();
    expect(detectDocumentType(Buffer.from('MZ\x90\x00\x03\x00', 'latin1'))).toBeNull();
    expect(
      detectDocumentType(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
    ).toBeNull();
    expect(detectDocumentType(Buffer.from([0x68, 0x69, 0x00, 0x68]))).toBeNull();
    expect(detectDocumentType(Buffer.alloc(0))).toBeNull();
  });

  it('rejects invalid UTF-8 and tolerates a multi-byte character cut at the sample edge', () => {
    expect(looksLikeText(Buffer.from([0x61, 0xff, 0xfe, 0x61]))).toBe(false);
    const big = Buffer.from('a'.repeat(64 * 1024 - 1) + 'é' + 'b'.repeat(10));
    expect(looksLikeText(big)).toBe(true);
  });
});

describe('PDF extraction', () => {
  it('extracts the text layer', async () => {
    const result = await extractDocumentText(buildPdf([SAMPLE_RESUME_LINES]));
    expect(result).toMatchObject({
      mime: DOCUMENT_MIME.PDF,
      parser: 'unpdf',
      pages: 1,
      ocrUsed: false,
      warnings: [],
    });
    expect(result.text).toContain('idempotent payments ledger');
  });

  it('reads every page', async () => {
    const result = await extractDocumentText(
      buildPdf([SAMPLE_RESUME_LINES, ['Page two: open-source contributions to Fastify.']]),
    );
    expect(result.pages).toBe(2);
    expect(result.text).toContain('Fastify');
  });

  it('refuses PDFs over the page limit before extracting', async () => {
    const pages = Array.from({ length: 5 }, (_, i) => [`page ${i}`]);
    expect(await code(buildPdf(pages), { maxPdfPages: 4 })).toBe('TOO_MANY_PAGES');
  });

  it('treats a PDF without a text layer as scanned: NO_TEXT unless OCR succeeds', async () => {
    const scanned = buildPdf([[]]);
    expect(await code(scanned)).toBe('NO_TEXT');
    const withOcr = await extractDocumentText(scanned, {
      ocr: async () => SAMPLE_RESUME_LINES.join('\n'),
    });
    expect(withOcr).toMatchObject({ ocrUsed: true, parser: 'ocr', warnings: ['OCR_NEEDED'] });
    // An OCR failure falls back to the normal outcome.
    expect(
      await code(scanned, {
        ocr: async () => {
          throw new Error('ocr down');
        },
      }),
    ).toBe('NO_TEXT');
  });

  it('keeps a little text but flags OCR_NEEDED', async () => {
    const result = await extractDocumentText(buildPdf([['Priya Sharma']]));
    expect(result.warnings).toEqual(['OCR_NEEDED']);
    expect(result.text).toBe('Priya Sharma');
  });

  it('reports corrupt PDFs', async () => {
    expect(await code(Buffer.from('%PDF-1.4\nthis is not really a pdf'))).toBe('CORRUPT');
    const truncated = buildPdf([SAMPLE_RESUME_LINES]).subarray(0, 60);
    expect(await code(truncated)).toBe('CORRUPT');
  });
});

describe('DOCX extraction', () => {
  it('extracts paragraphs', async () => {
    const result = await extractDocumentText(buildDocx(SAMPLE_RESUME_LINES));
    expect(result).toMatchObject({ mime: DOCUMENT_MIME.DOCX, parser: 'mammoth' });
    expect(result.text).toContain('Kubernetes');
    expect(result.text.split('\n').filter(Boolean)).toHaveLength(SAMPLE_RESUME_LINES.length);
  });

  it('stops zip bombs before handing them to the parser', async () => {
    const bomb = buildDocxBomb(30);
    expect(bomb.length).toBeLessThan(200 * 1024);
    expect(await code(bomb)).toBe('TOO_LARGE');
  });

  it('does not trust sizes declared in zip headers', () => {
    const bomb = buildDocxBomb(30);
    // Rewrite every central-directory "uncompressed size" to 1 byte.
    const lying = Buffer.from(bomb);
    for (const entry of listZipEntries(lying)) {
      const at = lying.indexOf(Buffer.from(entry.name), 0);
      void at;
    }
    let p = lying.lastIndexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    while (p >= 0) {
      lying.writeUInt32LE(1, p + 24);
      p = lying.lastIndexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]), p - 1);
    }
    expect(listZipEntries(lying).every((e) => e.declaredSize === 1)).toBe(true);
    expect(() => assertZipWithinLimits(lying, 25 * 1024 * 1024)).toThrow(/TOO_LARGE/);
  });

  it('reports corrupt and encrypted archives', async () => {
    const docx = buildDocx(['x']);
    expect(await code(docx.subarray(0, docx.length - 30))).toBe('CORRUPT');
    const encrypted = Buffer.from(docx);
    let p = encrypted.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    while (p >= 0) {
      encrypted.writeUInt16LE(encrypted.readUInt16LE(p + 8) | 1, p + 8);
      p = encrypted.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]), p + 4);
    }
    expect(await code(encrypted)).toBe('ENCRYPTED');
  });
});

describe('plain text', () => {
  it('cleans control characters and whitespace, strips the BOM', async () => {
    const result = await extractDocumentText(
      Buffer.from('\uFEFFLine one\t\twith tabs\r\n\r\n\r\n\r\nLine two\x0c'),
    );
    expect(result.text).toBe('Line one with tabs\n\nLine two');
  });

  it('truncates very long text with a warning', async () => {
    const result = await extractDocumentText(Buffer.from('word '.repeat(100_000)), {
      maxTextChars: 1000,
    });
    expect(result.text).toHaveLength(1000);
    expect(result.warnings).toEqual(['TEXT_TRUNCATED']);
  });

  it('refuses unsupported and empty input', async () => {
    expect(await code(Buffer.from([0, 1, 2, 3]))).toBe('UNSUPPORTED_TYPE');
    expect(await code(Buffer.from('   \n\n  '))).toBe('NO_TEXT');
  });

  it('cleanText keeps paragraph breaks', () => {
    expect(cleanText('a\n\n\n\nb')).toBe('a\n\nb');
  });
});

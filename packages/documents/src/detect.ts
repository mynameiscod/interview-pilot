import { DOCUMENT_MIME, type DocumentMime } from '@cbi/shared-types';

/**
 * Identifies a document by its bytes, never by the file name or the
 * browser-declared type (both are attacker-controlled). Cheap enough to run
 * in the API before accepting an upload; full parsing happens in the worker.
 */
export function detectDocumentType(buf: Buffer): DocumentMime | null {
  if (buf.length >= 5 && buf.subarray(0, 5).toString('latin1') === '%PDF-')
    return DOCUMENT_MIME.PDF;
  if (buf.length >= 4 && buf.readUInt32LE(0) === 0x04034b50) {
    // A DOCX is a zip whose parts include word/document.xml (names appear in the central directory).
    return buf.includes('word/document.xml', 0, 'latin1') ? DOCUMENT_MIME.DOCX : null;
  }
  return looksLikeText(buf) ? DOCUMENT_MIME.TXT : null;
}

/** Valid UTF-8 (optionally with BOM) without NUL or other binary control bytes. */
export function looksLikeText(buf: Buffer): boolean {
  if (buf.length === 0) return false;
  const sample = buf.subarray(0, 64 * 1024);
  for (const byte of sample) {
    // Allow tab, LF, CR and form feed; any other C0 control byte means binary.
    if (byte < 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0d && byte !== 0x0c)
      return false;
  }
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(
      sample.length < buf.length ? trimPartial(sample) : sample,
    );
    return true;
  } catch {
    return false;
  }
}

/** Drops a trailing, possibly cut, multi-byte UTF-8 sequence from a sample. */
function trimPartial(sample: Buffer): Buffer {
  const end = sample.length;
  for (let i = 1; i <= 3 && end - i >= 0; i++) {
    const byte = sample[end - i]!;
    if ((byte & 0xc0) === 0xc0) return sample.subarray(0, end - i);
    if ((byte & 0x80) === 0) break;
  }
  return sample;
}

/** File extension used for storage keys. */
export const EXTENSION: Record<DocumentMime, string> = {
  [DOCUMENT_MIME.PDF]: 'pdf',
  [DOCUMENT_MIME.DOCX]: 'docx',
  [DOCUMENT_MIME.TXT]: 'txt',
};

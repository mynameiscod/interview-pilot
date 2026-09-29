import { readRange, type StorageProvider } from '@cbi/provider-adapters';

/** Inclusive byte offsets. */
export interface ByteRange {
  start: number;
  end: number;
}

/**
 * A single `Range: bytes=…` request against an object of `size` bytes.
 * Returns null to serve the whole object (no header, a malformed one or
 * several ranges, which HTTP allows a server to ignore) and 'unsatisfiable'
 * when the range starts past the end (416).
 */
export function parseRange(
  header: string | undefined,
  size: number,
): ByteRange | 'unsatisfiable' | null {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (m[1] === '' && m[2] === '')) return null;
  if (m[1] === '') {
    // Suffix: the last n bytes.
    const n = Number(m[2]);
    if (n === 0 || size === 0) return 'unsatisfiable';
    return { start: Math.max(0, size - n), end: size - 1 };
  }
  const start = Number(m[1]);
  if (m[2] !== '' && Number(m[2]) < start) return null;
  if (start >= size) return 'unsatisfiable';
  const end = m[2] === '' ? size - 1 : Number(m[2]);
  return { start, end: Math.min(end, size - 1) };
}

/** One stored object making up part of what is played (a segment, or the joined file). */
export interface Piece {
  key: string;
  bytes: number;
}

/** Storage reads per request are at most this large, so a big file is never held whole. */
export const READ_WINDOW_BYTES = 4 * 1024 * 1024;

/**
 * The bytes `range` of the pieces laid end to end, read window by window
 * (only the pieces the range touches are read).
 */
export async function* readPieces(
  storage: Pick<StorageProvider, 'get' | 'getRange'>,
  pieces: readonly Piece[],
  range: ByteRange,
  window = READ_WINDOW_BYTES,
): AsyncGenerator<Buffer> {
  let offset = 0;
  for (const piece of pieces) {
    const pieceStart = offset;
    const pieceEnd = offset + piece.bytes - 1;
    offset += piece.bytes;
    if (piece.bytes === 0 || pieceEnd < range.start) continue;
    if (pieceStart > range.end) return;
    let from = Math.max(range.start, pieceStart) - pieceStart;
    const to = Math.min(range.end, pieceEnd) - pieceStart;
    while (from <= to) {
      const last = Math.min(to, from + window - 1);
      const chunk = await readRange(storage, piece.key, from, last);
      if (chunk.length === 0) throw new Error('stored object is shorter than recorded');
      yield chunk;
      from += chunk.length;
    }
  }
}

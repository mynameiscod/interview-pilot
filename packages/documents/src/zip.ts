import { Inflate } from 'fflate';

export class ZipLimitError extends Error {
  constructor(public readonly reason: 'CORRUPT' | 'ENCRYPTED' | 'TOO_LARGE') {
    super(`zip rejected (${reason})`);
    this.name = 'ZipLimitError';
  }
}

export interface ZipEntry {
  name: string;
  method: number;
  encrypted: boolean;
  compressedSize: number;
  declaredSize: number;
  localHeaderOffset: number;
}

const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;
const MAX_ENTRIES = 5000;

/** Reads the central directory. Zip64 archives are rejected (DOCX files never need them). */
export function listZipEntries(buf: Buffer): ZipEntry[] {
  const floor = Math.max(0, buf.length - 65_557);
  let eocd = -1;
  for (let i = buf.length - 22; i >= floor; i--) {
    if (buf.readUInt32LE(i) === EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new ZipLimitError('CORRUPT');
  const count = buf.readUInt16LE(eocd + 10);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (count === 0xffff || cdOffset === 0xffffffff || count > MAX_ENTRIES)
    throw new ZipLimitError('CORRUPT');

  const entries: ZipEntry[] = [];
  let p = cdOffset;
  for (let i = 0; i < count; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== CENTRAL) throw new ZipLimitError('CORRUPT');
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    entries.push({
      encrypted: (buf.readUInt16LE(p + 8) & 1) === 1,
      method: buf.readUInt16LE(p + 10),
      compressedSize: buf.readUInt32LE(p + 20),
      declaredSize: buf.readUInt32LE(p + 24),
      localHeaderOffset: buf.readUInt32LE(p + 42),
      name: buf.toString('utf8', p + 46, p + 46 + nameLen),
    });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/**
 * Zip-bomb guard: actually inflates every entry, counting output bytes, and
 * stops as soon as the total exceeds `maxBytes`. Declared sizes in headers
 * are not trusted because an attacker controls them.
 */
export function assertZipWithinLimits(buf: Buffer, maxBytes: number): ZipEntry[] {
  const entries = listZipEntries(buf);
  let total = 0;
  for (const entry of entries) {
    if (entry.encrypted) throw new ZipLimitError('ENCRYPTED');
    const at = entry.localHeaderOffset;
    if (at + 30 > buf.length || buf.readUInt32LE(at) !== LOCAL) throw new ZipLimitError('CORRUPT');
    const start = at + 30 + buf.readUInt16LE(at + 26) + buf.readUInt16LE(at + 28);
    const end = start + entry.compressedSize;
    if (end > buf.length) throw new ZipLimitError('CORRUPT');
    const data = buf.subarray(start, end);

    if (entry.method === 0) {
      total += data.length;
    } else if (entry.method === 8) {
      const inflater = new Inflate((chunk) => {
        total += chunk.length;
        if (total > maxBytes) throw new ZipLimitError('TOO_LARGE');
      });
      try {
        // Feed in slices so the counter trips before a huge output is buffered.
        for (let i = 0; i < data.length; i += 16 * 1024) {
          inflater.push(data.subarray(i, i + 16 * 1024), i + 16 * 1024 >= data.length);
        }
        if (data.length === 0) inflater.push(new Uint8Array(0), true);
      } catch (err) {
        if (err instanceof ZipLimitError) throw err;
        throw new ZipLimitError('CORRUPT');
      }
    } else {
      throw new ZipLimitError('CORRUPT');
    }
    if (total > maxBytes) throw new ZipLimitError('TOO_LARGE');
  }
  return entries;
}

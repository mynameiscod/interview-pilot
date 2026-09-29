import { once } from 'node:events';
import type { Writable } from 'node:stream';
import { finished } from 'node:stream/promises';
import { crc32, createDeflateRaw, inflateRawSync } from 'node:zlib';

/** Entry data: a buffer, or chunks produced one at a time (strings are UTF-8). */
export type ZipSource = Buffer | Iterable<Buffer | string> | AsyncIterable<Buffer | string>;

const MAX_32 = 0xffffffff;
const MAX_ENTRIES = 0xffff;

/** DOS date and time (local fields are fine: archive viewers only display them). */
function dosDateTime(d: Date) {
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2);
  const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, date };
}

/**
 * A streaming ZIP writer (deflate, UTF-8 names, no ZIP64). Each entry is
 * compressed as it is written, with its CRC and sizes in a data descriptor
 * after the data, so only the central directory (a few dozen bytes per
 * entry) is kept in memory — never an entry's output or the archive.
 * Respects backpressure on `out`.
 */
export class ZipWriter {
  private offset = 0;
  private readonly central: Buffer[] = [];
  private readonly stamp: { time: number; date: number };
  /** The destination's error, surfaced on the next write (an unhandled 'error' would crash). */
  private failed: Error | null = null;
  entries = 0;

  constructor(
    private readonly out: Writable,
    now = new Date(),
  ) {
    this.stamp = dosDateTime(now);
    out.on('error', (err) => {
      this.failed ??= err;
    });
  }

  /** Bytes written so far. */
  get size() {
    return this.offset;
  }

  private async write(buf: Buffer) {
    if (this.failed) throw this.failed;
    this.offset += buf.length;
    if (!this.out.write(buf)) await once(this.out, 'drain');
  }

  async add(entryName: string, source: ZipSource): Promise<void> {
    if (this.entries >= MAX_ENTRIES) throw new Error('too many files for a ZIP without ZIP64');
    const name = Buffer.from(entryName.replace(/^\/+/, ''), 'utf8');
    const headerAt = this.offset;
    const { time, date } = this.stamp;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0808, 6); // UTF-8 names; CRC and sizes follow the data
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    // CRC and sizes (14–25) stay zero; they are in the data descriptor.
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    await this.write(Buffer.concat([local, name]));

    let crc = 0;
    let size = 0;
    let compressed = 0;
    const deflate = createDeflateRaw();
    const pump = (async () => {
      for await (const chunk of deflate as AsyncIterable<Buffer>) {
        compressed += chunk.length;
        await this.write(chunk);
      }
    })();
    // If writing out fails, stop feeding the compressor (its 'drain' would never come).
    pump.catch((err: unknown) => deflate.destroy(err as Error));
    try {
      const parts: Iterable<Buffer | string> | AsyncIterable<Buffer | string> = Buffer.isBuffer(
        source,
      )
        ? [source]
        : source;
      for await (const part of parts) {
        const buf = typeof part === 'string' ? Buffer.from(part, 'utf8') : part;
        if (buf.length === 0) continue;
        crc = crc32(buf, crc);
        size += buf.length;
        if (!deflate.write(buf)) await once(deflate, 'drain');
      }
      deflate.end();
    } catch (err) {
      deflate.destroy();
      await pump.catch(() => undefined);
      throw err;
    }
    await pump;
    if (size > MAX_32 || compressed > MAX_32 || headerAt > MAX_32) {
      throw new Error('export too large for a ZIP without ZIP64');
    }

    const descriptor = Buffer.alloc(16);
    descriptor.writeUInt32LE(0x08074b50, 0);
    descriptor.writeUInt32LE(crc, 4);
    descriptor.writeUInt32LE(compressed, 8);
    descriptor.writeUInt32LE(size, 12);
    await this.write(descriptor);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0808, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed, 20);
    central.writeUInt32LE(size, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(headerAt, 42);
    this.central.push(central, name);
    this.entries += 1;
  }

  /** Writes the central directory, ends `out` and waits until it is flushed. */
  async finish(): Promise<void> {
    const centralAt = this.offset;
    const centralSize = this.central.reduce((n, b) => n + b.length, 0);
    if (centralAt > MAX_32) throw new Error('export too large for a ZIP without ZIP64');
    for (const part of this.central) await this.write(part);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(this.entries, 8);
    end.writeUInt16LE(this.entries, 10);
    end.writeUInt32LE(centralSize, 12);
    end.writeUInt32LE(centralAt, 16);
    await this.write(end);
    this.out.end();
    await finished(this.out);
  }
}

/** Reads back a ZIP made by `ZipWriter` into memory (tests and tooling only). */
export function readZip(zip: Buffer): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  const endAt = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = zip.readUInt16LE(endAt + 10);
  let p = zip.readUInt32LE(endAt + 16);
  for (let i = 0; i < count; i++) {
    const size = zip.readUInt32LE(p + 20);
    const nameLen = zip.readUInt16LE(p + 28);
    const extraLen = zip.readUInt16LE(p + 30);
    const commentLen = zip.readUInt16LE(p + 32);
    const localAt = zip.readUInt32LE(p + 42);
    const name = zip.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    const dataAt = localAt + 30 + zip.readUInt16LE(localAt + 26) + zip.readUInt16LE(localAt + 28);
    out.set(name, inflateRawSync(zip.subarray(dataAt, dataAt + size)));
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

import { randomBytes } from 'node:crypto';
import { PassThrough, Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { readZip, ZipWriter } from './zip-writer.js';

/** Collects everything written, and how many bytes had arrived after each entry. */
function sink() {
  const chunks: Buffer[] = [];
  const out = new Writable({
    write(chunk: Buffer, _enc, cb) {
      chunks.push(chunk);
      cb();
    },
  });
  const bytes = () => chunks.reduce((n, c) => n + c.length, 0);
  return { out, chunks, bytes, all: () => Buffer.concat(chunks) };
}

describe('ZipWriter', () => {
  // Deflating 200 KB of random bytes is slow when the whole workspace is testing at once.
  it('round-trips buffers and streamed entries with UTF-8 names', async () => {
    const s = sink();
    const zip = new ZipWriter(s.out);
    const big = randomBytes(200_000);
    await zip.add('campaign.json', Buffer.from('{"a":1}'));
    await zip.add(
      'results.csv',
      (async function* () {
        yield '﻿Name,Email\r\n';
        yield 'ప్రియ,p@example.com\r\n';
        yield Buffer.from('Asha,a@example.com\r\n');
      })(),
    );
    await zip.add('reports/ప్రియ-1.pdf', big);
    await zip.add('empty.txt', Buffer.alloc(0));
    await zip.finish();

    const files = readZip(s.all());
    expect([...files.keys()]).toEqual([
      'campaign.json',
      'results.csv',
      'reports/ప్రియ-1.pdf',
      'empty.txt',
    ]);
    expect(files.get('results.csv')!.toString('utf8')).toBe(
      '﻿Name,Email\r\nప్రియ,p@example.com\r\nAsha,a@example.com\r\n',
    );
    expect(files.get('reports/ప్రియ-1.pdf')).toEqual(big);
    expect(files.get('empty.txt')!.length).toBe(0);
    expect(zip.entries).toBe(4);
    expect(zip.size).toBe(s.bytes());
  }, 20_000);

  it('writes each entry out as it goes instead of buffering the archive', async () => {
    const s = sink();
    const zip = new ZipWriter(s.out);
    await zip.add('one.bin', randomBytes(50_000));
    const afterFirst = s.bytes();
    // The first entry (incompressible) is already out, before the archive is finished.
    expect(afterFirst).toBeGreaterThan(50_000);
    await zip.add('two.bin', randomBytes(50_000));
    expect(s.bytes()).toBeGreaterThan(afterFirst + 50_000);
    await zip.finish();
  });

  it('waits for a slow destination (backpressure)', async () => {
    const out = new PassThrough({ highWaterMark: 1024 });
    const received: Buffer[] = [];
    // Drain slowly: the writer must pause instead of queueing everything.
    const reader = (async () => {
      for await (const chunk of out) {
        received.push(chunk as Buffer);
        await new Promise((r) => setTimeout(r, 1));
      }
    })();
    const zip = new ZipWriter(out);
    await zip.add('data.bin', randomBytes(100_000));
    await zip.finish();
    await reader;
    expect(readZip(Buffer.concat(received)).get('data.bin')!.length).toBe(100_000);
  });

  it('surfaces a failing destination instead of crashing', async () => {
    const out = new Writable({
      write(_chunk, _enc, cb) {
        cb(new Error('disk full'));
      },
    });
    const zip = new ZipWriter(out);
    await expect(
      (async () => {
        await zip.add('a.bin', randomBytes(10_000));
        await zip.add('b.bin', randomBytes(10_000));
        await zip.finish();
      })(),
    ).rejects.toThrow('disk full');
  });

  it('fails the entry when its source fails', async () => {
    const zip = new ZipWriter(sink().out);
    await expect(
      zip.add(
        'broken.csv',
        (async function* () {
          yield 'header\r\n';
          throw new Error('cursor lost');
        })(),
      ),
    ).rejects.toThrow('cursor lost');
  });
});

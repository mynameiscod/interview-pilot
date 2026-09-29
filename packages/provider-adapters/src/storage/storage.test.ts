import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import { afterAll, describe, expect, it } from 'vitest';
import { ProviderError } from '../errors.js';
import { createBunnyStorage } from './bunny.js';
import { createLocalStorage } from './local.js';
import { createMemoryStorage } from '../testing.js';
import { assertStorageKey, readRange, StorageNotFoundError } from './types.js';

describe('storage keys', () => {
  it.each(['resumes/u1/abc.pdf', 'jobs/u1/2026/x_y-z.txt'])('accepts %s', (key) => {
    expect(() => assertStorageKey(key)).not.toThrow();
  });
  it.each([
    '../etc/passwd',
    'resumes/../../x',
    '/abs/path',
    'a//b',
    'a/./b',
    'a\\b',
    '',
    'a b',
    'resumes/u1/',
  ])('rejects %s', (key) => {
    expect(() => assertStorageKey(key)).toThrow('invalid storage key');
  });
});

const dirs: string[] = [];
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

async function tempFile(content: Buffer) {
  const dir = await mkdtemp(join(tmpdir(), 'cbi-storage-'));
  dirs.push(dir);
  const path = join(dir, 'upload.bin');
  await writeFile(path, content);
  return path;
}

async function readAll(stream: Readable) {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

describe('Bunny storage', () => {
  function fake(status: number, body: string | null = null) {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(body, { status });
    }) as unknown as typeof fetch;
    const storage = createBunnyStorage({
      zone: 'cbi-private',
      accessKey: 'zone-password',
      regionHost: 'sg.storage.bunnycdn.com',
      fetchImpl,
    });
    return { storage, calls };
  }

  it('uploads with the access key and a SHA-256 checksum', async () => {
    const t = fake(201);
    const body = Buffer.from('%PDF-1.4 resume');
    await t.storage.put('resumes/u1/r1.pdf', body, 'application/pdf');
    const { url, init } = t.calls[0]!;
    expect(url).toBe('https://sg.storage.bunnycdn.com/cbi-private/resumes/u1/r1.pdf');
    expect(init.method).toBe('PUT');
    expect(init.headers).toMatchObject({
      AccessKey: 'zone-password',
      'Content-Type': 'application/pdf',
      Checksum: createHash('sha256').update(body).digest('hex').toUpperCase(),
    });
  });

  it('downloads, maps 404 to not-found and tolerates deleting missing objects', async () => {
    expect((await fake(200, 'hello').storage.get('a/b.txt')).toString()).toBe('hello');
    await expect(fake(404).storage.get('a/b.txt')).rejects.toBeInstanceOf(StorageNotFoundError);
    await expect(fake(404).storage.delete('a/b.txt')).resolves.toBeUndefined();
  });

  it('classifies failures without leaking the key', async () => {
    const err = (await fake(503)
      .storage.put('a/b.txt', Buffer.from('x'), 'text/plain')
      .catch((e: unknown) => e)) as ProviderError;
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.retryable).toBe(true);
    expect(err.message).not.toContain('zone-password');
    const denied = (await fake(401)
      .storage.get('a/b.txt')
      .catch((e: unknown) => e)) as ProviderError;
    expect(denied.retryable).toBe(false);
  });

  it('streams file uploads with the length and checksum of the whole file', async () => {
    const t = fake(201);
    const body = Buffer.alloc(300_000, 7);
    await t.storage.putFile('exports/c1/e1.zip', await tempFile(body), 'application/zip');
    const { init } = t.calls[0]!;
    expect(init.method).toBe('PUT');
    // A stream, not a buffer: the file is never read into memory at once.
    expect(init.body).toBeInstanceOf(ReadableStream);
    expect((init as { duplex?: string }).duplex).toBe('half');
    expect(init.headers).toMatchObject({
      'Content-Type': 'application/zip',
      'Content-Length': '300000',
      Checksum: createHash('sha256').update(body).digest('hex').toUpperCase(),
    });
    await expect(
      fake(503).storage.putFile('a/b.zip', await tempFile(body), 'application/zip'),
    ).rejects.toBeInstanceOf(ProviderError);
  });

  it('streams downloads and maps 404 to not-found', async () => {
    expect(
      (await readAll(await fake(200, 'zip-bytes').storage.getStream('a/b.zip'))).toString(),
    ).toBe('zip-bytes');
    await expect(fake(404).storage.getStream('a/b.zip')).rejects.toBeInstanceOf(
      StorageNotFoundError,
    );
  });

  it('reads byte ranges, slicing when Bunny ignores the Range header', async () => {
    const partial = fake(206, 'llo');
    expect((await partial.storage.getRange!('a/b.bin', 2, 4)).toString()).toBe('llo');
    expect(partial.calls[0]!.init.headers).toMatchObject({ Range: 'bytes=2-4' });
    expect((await fake(200, 'hello world').storage.getRange!('a/b.bin', 6, 10)).toString()).toBe(
      'world',
    );
    expect(await fake(416).storage.getRange!('a/b.bin', 99, 120)).toHaveLength(0);
    await expect(fake(404).storage.getRange!('a/b.bin', 0, 1)).rejects.toBeInstanceOf(
      StorageNotFoundError,
    );
  });

  it('refuses unsafe keys before any request', async () => {
    const t = fake(200);
    await expect(t.storage.get('../other-zone/x')).rejects.toThrow('invalid storage key');
    expect(t.calls).toHaveLength(0);
  });
});

describe('local storage', () => {
  it('round-trips, deletes idempotently and stays inside its root', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cbi-storage-'));
    dirs.push(dir);
    const storage = createLocalStorage(dir);
    await storage.put('resumes/u1/r1.txt', Buffer.from('resume text'), 'text/plain');
    expect((await storage.get('resumes/u1/r1.txt')).toString()).toBe('resume text');
    await storage.delete('resumes/u1/r1.txt');
    await storage.delete('resumes/u1/r1.txt');
    await expect(storage.get('resumes/u1/r1.txt')).rejects.toBeInstanceOf(StorageNotFoundError);
    await expect(storage.put('../escape.txt', Buffer.from('x'), 'text/plain')).rejects.toThrow(
      'invalid storage key',
    );
  });

  it('reads byte ranges without loading the whole file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cbi-storage-'));
    dirs.push(dir);
    const storage = createLocalStorage(dir);
    await storage.put('media/u1/rec.webm', Buffer.from('0123456789'), 'video/webm');
    expect((await storage.getRange!('media/u1/rec.webm', 2, 5)).toString()).toBe('2345');
    // Past the end: shortened, not padded.
    expect((await storage.getRange!('media/u1/rec.webm', 8, 20)).toString()).toBe('89');
    await expect(storage.getRange!('media/u1/none.webm', 0, 1)).rejects.toBeInstanceOf(
      StorageNotFoundError,
    );
  });
});

describe('readRange', () => {
  it('falls back to a whole read for providers without ranges', async () => {
    const storage = { get: async () => Buffer.from('abcdef') };
    expect((await readRange(storage, 'k', 1, 3)).toString()).toBe('bcd');
  });
});

describe('streaming files', () => {
  it('round-trips through local and in-memory storage', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cbi-storage-'));
    dirs.push(dir);
    const body = Buffer.from('PK package bytes');
    const source = await tempFile(body);
    for (const storage of [createLocalStorage(dir), createMemoryStorage().storage]) {
      await storage.putFile('exports/c1/e1.zip', source, 'application/zip');
      expect(await readAll(await storage.getStream('exports/c1/e1.zip'))).toEqual(body);
      await expect(storage.getStream('exports/c1/missing.zip')).rejects.toBeInstanceOf(
        StorageNotFoundError,
      );
      await expect(storage.putFile('../x.zip', source, 'application/zip')).rejects.toThrow(
        'invalid storage key',
      );
    }
  });
});

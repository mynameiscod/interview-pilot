import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { ProviderError } from '../errors.js';
import { createBunnyStorage } from './bunny.js';
import { createLocalStorage } from './local.js';
import { assertStorageKey, StorageNotFoundError } from './types.js';

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

  it('refuses unsafe keys before any request', async () => {
    const t = fake(200);
    await expect(t.storage.get('../other-zone/x')).rejects.toThrow('invalid storage key');
    expect(t.calls).toHaveLength(0);
  });
});

describe('local storage', () => {
  const dirs: string[] = [];
  afterAll(async () => {
    for (const d of dirs) await rm(d, { recursive: true, force: true });
  });

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
});

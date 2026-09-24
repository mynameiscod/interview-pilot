import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { extractReadableText, normalizeText } from './readable-text.js';
import {
  isPublicAddress,
  safeFetchText,
  SafeFetchError,
  UrlBlockedError,
  type Resolver,
  type SafeFetchOptions,
} from './safe-fetch.js';

/**
 * SSRF test suite (Phase 3 exit criterion). Blocking tests never open a
 * network connection. Positive-path tests use a loopback server that is
 * explicitly allowed through the injectable address check.
 */

const base: SafeFetchOptions = { timeoutMs: 2000, maxBytes: 64 * 1024 };
const publicResolver: Resolver = async () => [{ address: '93.184.216.34', family: 4 }];

async function blocked(url: string, opts: Partial<SafeFetchOptions> = {}) {
  const err = await safeFetchText(url, { ...base, resolve: publicResolver, ...opts }).catch(
    (e: unknown) => e,
  );
  expect(err, url).toBeInstanceOf(UrlBlockedError);
  return (err as UrlBlockedError).reason;
}

describe('isPublicAddress', () => {
  it.each([
    '127.0.0.1',
    '127.255.255.254',
    '10.0.0.1',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '169.254.169.254', // cloud metadata
    '100.64.0.1', // carrier-grade NAT
    '0.0.0.0',
    '255.255.255.255',
    '224.0.0.1',
    '198.18.0.1', // benchmarking
    '192.0.2.10', // documentation
    '::',
    '::1',
    'fc00::1',
    'fd12:3456::1',
    'fe80::1',
    'ff02::1',
    '::ffff:127.0.0.1',
    '::ffff:10.0.0.1',
    '::ffff:169.254.169.254',
    '64:ff9b::7f00:1', // NAT64 of 127.0.0.1
    '2002:7f00:1::1', // 6to4 of 127.0.0.1
    '2001:db8::1', // documentation
    'not-an-ip',
  ])('blocks %s', (ip) => {
    expect(isPublicAddress(ip)).toBe(false);
  });

  it.each(['93.184.216.34', '8.8.8.8', '2606:4700:4700::1111', '::ffff:8.8.8.8'])(
    'allows %s',
    (ip) => {
      expect(isPublicAddress(ip)).toBe(true);
    },
  );
});

describe('URL policy', () => {
  it.each([
    'file:///etc/passwd',
    'ftp://example.com/jd',
    'gopher://example.com',
    'javascript:alert(1)',
    'data:text/html,hi',
  ])('refuses the scheme of %s', async (url) => {
    expect(await blocked(url)).toBe('SCHEME');
  });

  it('refuses unparseable URLs', async () => {
    expect(await blocked('not a url')).toBe('SCHEME');
  });

  it('refuses credentials in the URL', async () => {
    expect(await blocked('https://user:pass@example.com/job')).toBe('CREDENTIALS');
    expect(await blocked('https://user@example.com/job')).toBe('CREDENTIALS');
  });

  it.each([
    'https://example.com:8443/job',
    'http://example.com:22/',
    'http://example.com:6379/',
    'http://example.com:443/',
  ])('refuses non-default port in %s', async (url) => {
    expect(await blocked(url)).toBe('PORT');
  });

  it.each([
    'http://127.0.0.1/',
    'http://localhost./', // resolved below to loopback
    'http://10.1.2.3/',
    'http://169.254.169.254/latest/meta-data/',
    'http://[::1]/',
    'http://[::ffff:127.0.0.1]/',
    'http://[::ffff:7f00:1]/',
    'http://[fe80::1]/',
    'http://0.0.0.0/',
    // Alternative IPv4 spellings are normalised by the URL parser before the check.
    'http://2130706433/', // decimal 127.0.0.1
    'http://0x7f000001/', // hex
    'http://0177.0.0.1/', // octal
    'http://127.1/', // short form
    'http://0x7f.1/',
  ])('refuses private address %s', async (url) => {
    const loopback: Resolver = async () => [{ address: '127.0.0.1', family: 4 }];
    expect(await blocked(url, { resolve: loopback })).toBe('PRIVATE_ADDRESS');
  });

  it('refuses hostnames that resolve to private addresses', async () => {
    const internal: Resolver = async () => [{ address: '10.0.0.5', family: 4 }];
    expect(await blocked('https://jobs.internal.example/', { resolve: internal })).toBe(
      'PRIVATE_ADDRESS',
    );
  });

  it('refuses when any resolved address is private', async () => {
    const mixed: Resolver = async () => [
      { address: '93.184.216.34', family: 4 },
      { address: '192.168.0.10', family: 4 },
    ];
    expect(await blocked('https://mixed.example/', { resolve: mixed })).toBe('PRIVATE_ADDRESS');
  });

  it('refuses IPv4-mapped IPv6 answers that hide a private address', async () => {
    const mapped: Resolver = async () => [{ address: '::ffff:169.254.169.254', family: 6 }];
    expect(await blocked('https://metadata.example/', { resolve: mapped })).toBe('PRIVATE_ADDRESS');
  });

  it('refuses hosts that do not resolve', async () => {
    const nx: Resolver = async () => {
      throw Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' });
    };
    expect(await blocked('https://does-not-exist.example/', { resolve: nx })).toBe('DNS');
    expect(await blocked('https://empty.example/', { resolve: async () => [] })).toBe('DNS');
  });
});

describe('fetching (loopback test server)', () => {
  let server: Server;
  let port: string;
  const hits: string[] = [];

  beforeAll(async () => {
    server = createServer((req, res) => {
      hits.push(req.url ?? '');
      switch (req.url) {
        case '/job':
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
          res.end(
            '<html><head><title>Backend Engineer</title><script>steal()</script></head><body><main><h1>Backend Engineer</h1><p>Build APIs in Node.js.</p></main></body></html>',
          );
          return;
        case '/redirect-internal':
          res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data/' });
          res.end();
          return;
        case '/redirect-ok':
          res.writeHead(301, { location: '/job' });
          res.end();
          return;
        case '/loop':
          res.writeHead(302, { location: '/loop' });
          res.end();
          return;
        case '/huge':
          res.writeHead(200, { 'content-type': 'text/plain' });
          res.end('x'.repeat(200 * 1024));
          return;
        case '/huge-chunked':
          res.writeHead(200, { 'content-type': 'text/plain' });
          for (let i = 0; i < 50; i++) res.write('y'.repeat(4096));
          res.end();
          return;
        case '/binary':
          res.writeHead(200, { 'content-type': 'application/octet-stream' });
          res.end(Buffer.alloc(10));
          return;
        case '/missing':
          res.writeHead(404, { 'content-type': 'text/html' });
          res.end('nope');
          return;
        case '/slow':
          // Never responds; the client must time out.
          return;
        case '/latin1':
          res.writeHead(200, { 'content-type': 'text/plain; charset=iso-8859-1' });
          res.end(Buffer.from([0x63, 0x61, 0x66, 0xe9])); // "café"
          return;
        default:
          res.writeHead(500);
          res.end();
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = String((server.address() as AddressInfo).port);
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });

  /** Resolves every test host to the loopback server and allows only that address. */
  const local = (overrides: Partial<SafeFetchOptions> = {}): SafeFetchOptions => ({
    ...base,
    extraPorts: [port],
    resolve: async () => [{ address: '127.0.0.1', family: 4 }],
    isAllowedAddress: (ip) => ip === '127.0.0.1' || isPublicAddress(ip),
    ...overrides,
  });

  it('fetches and decodes an allowed page', async () => {
    const result = await safeFetchText(`http://jobs.test:${port}/job`, local());
    expect(result).toMatchObject({ status: 200, contentType: 'text/html', redirects: 0 });
    expect(result.text).toContain('Build APIs in Node.js.');
  });

  it('pins the connection to the vetted address (DNS rebinding)', async () => {
    let lookups = 0;
    // A rebinding resolver: the second answer would point at an internal host.
    const rebinding: Resolver = async () => {
      lookups += 1;
      return [{ address: lookups === 1 ? '127.0.0.1' : '10.0.0.1', family: 4 }];
    };
    const result = await safeFetchText(
      `http://rebind.test:${port}/job`,
      local({ resolve: rebinding }),
    );
    expect(result.status).toBe(200);
    expect(lookups).toBe(1);
  });

  it('re-validates every redirect hop', async () => {
    const reason = await safeFetchText(`http://jobs.test:${port}/redirect-internal`, local()).catch(
      (e: UrlBlockedError) => e.reason,
    );
    expect(reason).toBe('PRIVATE_ADDRESS');
  });

  it('follows safe redirects and counts hops', async () => {
    const result = await safeFetchText(`http://jobs.test:${port}/redirect-ok`, local());
    expect(result.redirects).toBe(1);
    expect(result.finalUrl).toBe(`http://jobs.test:${port}/job`);
  });

  it('stops redirect loops', async () => {
    const reason = await safeFetchText(
      `http://jobs.test:${port}/loop`,
      local({ maxRedirects: 3 }),
    ).catch((e: UrlBlockedError) => e.reason);
    expect(reason).toBe('TOO_MANY_REDIRECTS');
  });

  it('enforces the size cap from Content-Length and while streaming', async () => {
    for (const path of ['/huge', '/huge-chunked']) {
      const err = await safeFetchText(`http://jobs.test:${port}${path}`, local()).catch(
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(SafeFetchError);
      expect((err as SafeFetchError).reason).toBe('TOO_LARGE');
    }
  });

  it('refuses non-text content, non-2xx statuses and slow servers', async () => {
    const reason = (path: string, opts: Partial<SafeFetchOptions> = {}) =>
      safeFetchText(`http://jobs.test:${port}${path}`, local(opts)).catch((e: SafeFetchError) => [
        e.reason,
        e.status,
      ]);
    expect(await reason('/binary')).toEqual(['CONTENT_TYPE', undefined]);
    expect(await reason('/missing')).toEqual(['HTTP_STATUS', 404]);
    expect(await reason('/slow', { timeoutMs: 300 })).toEqual(['TIMEOUT', undefined]);
  });

  it('honours the declared charset', async () => {
    expect((await safeFetchText(`http://jobs.test:${port}/latin1`, local())).text).toBe('café');
  });

  it('never reaches the server for a blocked host', async () => {
    const before = hits.length;
    await safeFetchText(`http://127.0.0.1:${port}/job`, { ...base, extraPorts: [port] }).catch(
      () => undefined,
    );
    expect(hits.length).toBe(before);
  });
});

describe('readable text extraction', () => {
  it('keeps the article text and drops scripts, styles and navigation', () => {
    const html = `<html><head><title>Senior Data Analyst</title><style>.x{}</style></head><body>
      <nav>Home | Jobs | Login</nav>
      <article><h1>Senior Data Analyst</h1>
      <p>${'You will build dashboards in SQL and Python for the finance team. '.repeat(6)}</p>
      <ul><li>5+ years of SQL</li><li>Experience with dbt</li></ul></article>
      <script>document.cookie</script></body></html>`;
    const { title, text } = extractReadableText(html);
    expect(title).toBe('Senior Data Analyst');
    expect(text).toContain('5+ years of SQL');
    expect(text).not.toContain('document.cookie');
    expect(text).not.toContain('.x{}');
  });

  it('falls back to body text for short pages', () => {
    const { text } = extractReadableText(
      '<body><div>QA Engineer</div><div>Selenium, API testing</div></body>',
    );
    expect(text).toContain('Selenium, API testing');
  });

  it('normalises whitespace but keeps paragraphs', () => {
    expect(normalizeText('a\t\t b\r\n\r\n\r\n\r\nc  ')).toBe('a b\n\nc');
  });
});

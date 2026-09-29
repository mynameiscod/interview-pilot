import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  isPublicAddress,
  safePostJson,
  SafeFetchError,
  UrlBlockedError,
  type Resolver,
} from './safe-fetch.js';

/** Webhook POSTs: the same SSRF rules as job-description fetching. */

describe('safePostJson', () => {
  let server: Server;
  let port: string;
  const received: { headers: Record<string, unknown>; body: string }[] = [];

  beforeAll(async () => {
    server = createServer((req, res) => {
      let body = '';
      req.on('data', (c: Buffer) => (body += c.toString()));
      req.on('end', () => {
        received.push({ headers: req.headers, body });
        if (req.url === '/redirect') {
          res.writeHead(302, { location: 'http://127.0.0.1/internal' }).end();
        } else if (req.url === '/slow') {
          setTimeout(() => res.writeHead(200).end(), 1_500);
        } else {
          res.writeHead(req.url === '/fail' ? 500 : 204).end();
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = String((server.address() as AddressInfo).port);
  });
  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  const loopback: Resolver = async () => [{ address: '127.0.0.1', family: 4 }];
  const local = () => ({
    timeoutMs: 1000,
    headers: { 'x-cb-signature': 't=1,v1=abc' },
    resolve: loopback,
    extraPorts: [port],
    allowHttp: true,
    isAllowedAddress: (ip: string) => ip === '127.0.0.1' || isPublicAddress(ip),
  });

  it('posts the body with its headers and reports the status', async () => {
    const res = await safePostJson(`http://hooks.test:${port}/ok`, '{"a":1}', local());
    expect(res.status).toBe(204);
    const last = received.at(-1)!;
    expect(last.body).toBe('{"a":1}');
    expect(last.headers['content-type']).toBe('application/json');
    expect(last.headers['x-cb-signature']).toBe('t=1,v1=abc');
  });

  it('does not follow redirects and passes error statuses back', async () => {
    expect((await safePostJson(`http://hooks.test:${port}/redirect`, '{}', local())).status).toBe(
      302,
    );
    expect((await safePostJson(`http://hooks.test:${port}/fail`, '{}', local())).status).toBe(500);
  });

  it('times out', async () => {
    const err = await safePostJson(`http://hooks.test:${port}/slow`, '{}', {
      ...local(),
      timeoutMs: 200,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SafeFetchError);
    expect((err as SafeFetchError).reason).toBe('TIMEOUT');
  });

  it('refuses private addresses, other ports and plain http by default', async () => {
    const reason = async (url: string, opts: Partial<ReturnType<typeof local>> = {}) => {
      const err = await safePostJson(url, '{}', {
        timeoutMs: 1000,
        headers: {},
        resolve: loopback,
        ...opts,
      }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(UrlBlockedError);
      return (err as UrlBlockedError).reason;
    };
    expect(await reason('https://hooks.test/x')).toBe('PRIVATE_ADDRESS');
    expect(await reason('https://169.254.169.254/latest')).toBe('PRIVATE_ADDRESS');
    expect(await reason('https://hooks.test:8443/x')).toBe('PORT');
    expect(await reason('http://hooks.test/x')).toBe('SCHEME');
    expect(await reason('ftp://hooks.test/x')).toBe('SCHEME');
  });
});

import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { isIP } from 'node:net';
import ipaddr from 'ipaddr.js';
import { Agent, request } from 'undici';

/**
 * SSRF-guarded HTTP GET for fetching job descriptions from user-supplied URLs.
 *
 * - http/https only, default ports only, no credentials in the URL.
 * - Every address the hostname resolves to must be public unicast; one
 *   private answer blocks the request (no "pick the safe one").
 * - The TCP connection is pinned to the vetted address, so a second DNS
 *   answer (DNS rebinding) is never used.
 * - Redirects are followed manually and every hop is re-validated.
 * - Response size, content type and total time are bounded.
 */

export type BlockReason =
  'SCHEME' | 'PORT' | 'CREDENTIALS' | 'PRIVATE_ADDRESS' | 'DNS' | 'TOO_MANY_REDIRECTS';
export type FetchFailure = 'TIMEOUT' | 'HTTP_STATUS' | 'TOO_LARGE' | 'CONTENT_TYPE' | 'NETWORK';

export class UrlBlockedError extends Error {
  constructor(public readonly reason: BlockReason) {
    super(`URL blocked (${reason})`);
    this.name = 'UrlBlockedError';
  }
}

export class SafeFetchError extends Error {
  constructor(
    public readonly reason: FetchFailure,
    public readonly status?: number,
    options?: { cause?: unknown },
  ) {
    super(`fetch failed (${reason}${status ? ` ${status}` : ''})`, options);
    this.name = 'SafeFetchError';
  }
}

/** True only for globally routable unicast addresses (IPv4-mapped IPv6 is unwrapped first). */
export function isPublicAddress(address: string): boolean {
  if (!ipaddr.isValid(address)) return false;
  let parsed = ipaddr.parse(address);
  if (parsed.kind() === 'ipv6' && (parsed as ipaddr.IPv6).isIPv4MappedAddress()) {
    parsed = (parsed as ipaddr.IPv6).toIPv4Address();
  }
  return parsed.range() === 'unicast';
}

export type Resolver = (hostname: string) => Promise<LookupAddress[]>;

const systemResolver: Resolver = (hostname) =>
  new Promise((resolve, reject) =>
    dnsLookup(hostname, { all: true, verbatim: true }, (err, addresses) =>
      err ? reject(err) : resolve(addresses),
    ),
  );

export interface SafeFetchOptions {
  timeoutMs: number;
  maxBytes: number;
  maxRedirects?: number;
  /** Accepted `Content-Type` media types (lower-case, no parameters). */
  contentTypes?: readonly string[];
  userAgent?: string;
  /** Injected in tests. */
  resolve?: Resolver;
  /** Injected in tests to allow a loopback test server; defaults to isPublicAddress. */
  isAllowedAddress?: (address: string) => boolean;
  /** Explicit ports allowed besides the scheme default. Tests only; production allows none. */
  extraPorts?: readonly string[];
}

export interface SafeFetchResult {
  finalUrl: string;
  status: number;
  contentType: string;
  text: string;
  /** Hops taken, for logging (hosts only). */
  redirects: number;
}

const DEFAULT_CONTENT_TYPES = ['text/html', 'application/xhtml+xml', 'text/plain'];
const REDIRECT = new Set([301, 302, 303, 307, 308]);

function validateUrl(url: URL, extraPorts: readonly string[]): void {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new UrlBlockedError('SCHEME');
  if (url.username || url.password) throw new UrlBlockedError('CREDENTIALS');
  // WHATWG URL drops default ports, so any explicit port is non-default.
  if (url.port !== '' && !extraPorts.includes(url.port)) throw new UrlBlockedError('PORT');
}

async function vetHost(
  url: URL,
  resolve: Resolver,
  allowed: (ip: string) => boolean,
): Promise<LookupAddress> {
  // URL normalises IPv4 forms (decimal, hex, octal, short) to dotted quads; IPv6 keeps brackets.
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (isIP(host)) {
    if (!allowed(host)) throw new UrlBlockedError('PRIVATE_ADDRESS');
    return { address: host, family: isIP(host) };
  }
  let answers: LookupAddress[];
  try {
    answers = await resolve(host);
  } catch {
    throw new UrlBlockedError('DNS');
  }
  if (answers.length === 0) throw new UrlBlockedError('DNS');
  if (answers.some((a) => !allowed(a.address))) throw new UrlBlockedError('PRIVATE_ADDRESS');
  return answers[0]!;
}

function pinnedAgent(vetted: LookupAddress, timeoutMs: number) {
  return new Agent({
    connect: {
      timeout: timeoutMs,
      // Every connection goes to the address that passed validation.
      lookup: ((
        _hostname: string,
        options: { all?: boolean },
        callback: (...args: unknown[]) => void,
      ) => {
        if (options?.all) callback(null, [{ address: vetted.address, family: vetted.family }]);
        else callback(null, vetted.address, vetted.family);
      }) as never,
    },
    connections: 1,
    pipelining: 0,
  });
}

function charsetOf(contentType: string): string {
  const match = /charset\s*=\s*"?([\w-]+)"?/i.exec(contentType);
  return match?.[1]?.toLowerCase() ?? 'utf-8';
}

function decode(bytes: Uint8Array, charset: string): string {
  try {
    return new TextDecoder(charset, { fatal: false }).decode(bytes);
  } catch {
    return new TextDecoder('utf-8').decode(bytes);
  }
}

export async function safeFetchText(
  input: string,
  opts: SafeFetchOptions,
): Promise<SafeFetchResult> {
  const resolve = opts.resolve ?? systemResolver;
  const allowed = opts.isAllowedAddress ?? isPublicAddress;
  const maxRedirects = opts.maxRedirects ?? 5;
  const accepted = opts.contentTypes ?? DEFAULT_CONTENT_TYPES;
  const deadline = AbortSignal.timeout(opts.timeoutMs);

  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new UrlBlockedError('SCHEME');
  }

  for (let hop = 0; hop <= maxRedirects; hop++) {
    validateUrl(url, opts.extraPorts ?? []);
    const vetted = await vetHost(url, resolve, allowed);
    const agent = pinnedAgent(vetted, opts.timeoutMs);
    try {
      let res;
      try {
        res = await request(url, {
          method: 'GET',
          dispatcher: agent,
          signal: deadline,
          headersTimeout: opts.timeoutMs,
          bodyTimeout: opts.timeoutMs,
          headers: {
            'user-agent':
              opts.userAgent ??
              'CareerPilotInterview-JDFetcher/1.0 (+https://interview.codebegun.com)',
            accept: 'text/html,application/xhtml+xml,text/plain;q=0.9',
            'accept-encoding': 'identity',
          },
        });
      } catch (err) {
        throw new SafeFetchError(deadline.aborted ? 'TIMEOUT' : 'NETWORK', undefined, {
          cause: err,
        });
      }

      const location = res.headers.location;
      if (REDIRECT.has(res.statusCode) && typeof location === 'string') {
        await res.body.dump();
        if (hop === maxRedirects) throw new UrlBlockedError('TOO_MANY_REDIRECTS');
        try {
          url = new URL(location, url);
        } catch {
          throw new SafeFetchError('HTTP_STATUS', res.statusCode);
        }
        continue;
      }
      if (res.statusCode < 200 || res.statusCode >= 300) {
        await res.body.dump();
        throw new SafeFetchError('HTTP_STATUS', res.statusCode);
      }

      const contentType = String(res.headers['content-type'] ?? '');
      const mediaType = contentType.split(';')[0]!.trim().toLowerCase();
      if (!accepted.includes(mediaType)) {
        await res.body.dump();
        throw new SafeFetchError('CONTENT_TYPE');
      }
      const declared = Number(res.headers['content-length']);
      if (Number.isFinite(declared) && declared > opts.maxBytes) {
        res.body.destroy();
        throw new SafeFetchError('TOO_LARGE');
      }

      const chunks: Uint8Array[] = [];
      let total = 0;
      try {
        for await (const chunk of res.body) {
          total += (chunk as Uint8Array).byteLength;
          if (total > opts.maxBytes) {
            res.body.destroy();
            throw new SafeFetchError('TOO_LARGE');
          }
          chunks.push(chunk as Uint8Array);
        }
      } catch (err) {
        if (err instanceof SafeFetchError) throw err;
        throw new SafeFetchError(deadline.aborted ? 'TIMEOUT' : 'NETWORK', undefined, {
          cause: err,
        });
      }
      const bytes = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return {
        finalUrl: url.toString(),
        status: res.statusCode,
        contentType: mediaType,
        text: decode(bytes, charsetOf(contentType)),
        redirects: hop,
      };
    } finally {
      await agent.close().catch(() => undefined);
    }
  }
  throw new UrlBlockedError('TOO_MANY_REDIRECTS');
}

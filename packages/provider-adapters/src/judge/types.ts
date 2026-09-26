import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { CodingLanguage, JudgeVerdict } from '@cbi/shared-types';
import { ProviderError } from '../errors.js';

/**
 * Code judge (Phase 9, decision D9). Candidate code runs only on an external
 * judge on a separate host; this package never executes it. Requests are
 * signed with HMAC-SHA256 over `timestamp.METHOD.path.sha256(body)`.
 */
export interface JudgeTestCase {
  input: string;
  expectedOutput: string;
}

export interface JudgeRequest {
  language: CodingLanguage;
  source: string;
  tests: JudgeTestCase[];
  limits: { cpuMs: number; memoryMb: number };
}

export interface JudgeTestResult {
  verdict: JudgeVerdict;
  stdout: string | null;
  stderr: string | null;
  timeMs: number | null;
  memoryKb: number | null;
}

export interface JudgeResult {
  compileOutput: string | null;
  /** In the order of the request's tests. */
  tests: JudgeTestResult[];
}

export type JudgeStatus = 'QUEUED' | 'RUNNING' | 'DONE';

export interface JudgeAdapter {
  readonly name: 'codebegun' | 'judge0' | 'mock' | 'none';
  listLanguages(): Promise<CodingLanguage[]>;
  submit(request: JudgeRequest): Promise<{ token: string }>;
  status(token: string): Promise<JudgeStatus>;
  result(token: string): Promise<JudgeResult>;
}

/** The judge could not be reached, refused, or did not finish in time. */
export class JudgeUnavailableError extends ProviderError {
  constructor(provider: string, message: string, options?: { cause?: unknown }) {
    super(provider, message, true, options);
    this.name = 'JudgeUnavailableError';
  }
}

export const JUDGE_TIMESTAMP_HEADER = 'x-cb-timestamp';
export const JUDGE_SIGNATURE_HEADER = 'x-cb-signature';
/** Signatures older or newer than this are rejected by the judge. */
export const JUDGE_CLOCK_WINDOW_MS = 5 * 60_000;

const canonical = (ts: string, method: string, path: string, body: string) =>
  `${ts}.${method.toUpperCase()}.${path}.${createHash('sha256').update(body).digest('hex')}`;

/** Headers for a signed judge request (`path` includes the query string). */
export function signJudgeRequest(
  secret: string,
  method: string,
  path: string,
  body: string,
  now = Date.now(),
): Record<string, string> {
  const ts = String(Math.floor(now / 1000));
  return {
    [JUDGE_TIMESTAMP_HEADER]: ts,
    [JUDGE_SIGNATURE_HEADER]: createHmac('sha256', secret)
      .update(canonical(ts, method, path, body))
      .digest('hex'),
  };
}

/** What a judge does with an incoming request (used by tests and the future CodeBegun judge). */
export function verifyJudgeSignature(
  secret: string,
  req: { method: string; path: string; body: string; timestamp?: string; signature?: string },
  now = Date.now(),
): boolean {
  if (!req.timestamp || !req.signature || !/^[a-f0-9]{64}$/i.test(req.signature)) return false;
  const ts = Number(req.timestamp);
  if (!Number.isInteger(ts) || Math.abs(now - ts * 1000) > JUDGE_CLOCK_WINDOW_MS) return false;
  const expected = Buffer.from(
    createHmac('sha256', secret)
      .update(canonical(req.timestamp, req.method, req.path, req.body))
      .digest('hex'),
  );
  const given = Buffer.from(req.signature.toLowerCase());
  return expected.length === given.length && timingSafeEqual(expected, given);
}

/**
 * Submits and waits for the result, polling until `waitMs`. Any transport
 * failure, refusal or timeout becomes JudgeUnavailableError: callers treat
 * the judge as down, never the interview.
 */
export async function runOnJudge(
  judge: JudgeAdapter,
  request: JudgeRequest,
  opts: { waitMs: number; pollMs?: number; sleep?: (ms: number) => Promise<void> } = {
    waitMs: 20_000,
  },
): Promise<JudgeResult> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const deadline = Date.now() + opts.waitMs;
  const wrap = (err: unknown) =>
    err instanceof JudgeUnavailableError
      ? err
      : new JudgeUnavailableError(judge.name, 'judge request failed', { cause: err });
  let token: string;
  try {
    token = (await judge.submit(request)).token;
  } catch (err) {
    throw wrap(err);
  }
  let pause = opts.pollMs ?? 400;
  for (;;) {
    let state: JudgeStatus;
    try {
      state = await judge.status(token);
    } catch (err) {
      throw wrap(err);
    }
    if (state === 'DONE') {
      try {
        return await judge.result(token);
      } catch (err) {
        throw wrap(err);
      }
    }
    if (Date.now() + pause > deadline) {
      throw new JudgeUnavailableError(judge.name, 'judge did not finish in time');
    }
    await sleep(pause);
    pause = Math.min(pause * 1.5, 2000);
  }
}

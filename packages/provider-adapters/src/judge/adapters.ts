import type { CodingLanguage, JudgeVerdict } from '@cbi/shared-types';
import {
  JudgeUnavailableError,
  signJudgeRequest,
  type JudgeAdapter,
  type JudgeRequest,
  type JudgeResult,
  type JudgeStatus,
} from './types.js';

type FetchLike = typeof fetch;

interface HttpOptions {
  baseUrl: string;
  hmacSecret: string;
  timeoutMs?: number;
  fetchImpl?: FetchLike;
  /** Extra headers (e.g. Judge0's X-Auth-Token). */
  headers?: Record<string, string>;
}

/** A signed JSON call to the judge host; failures become JudgeUnavailableError (bodies are never echoed). */
function client(provider: string, opts: HttpOptions) {
  const base = opts.baseUrl.replace(/\/$/, '');
  const basePath = new URL(base).pathname.replace(/\/$/, '');
  const fetchImpl = opts.fetchImpl ?? fetch;
  return async function call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    const payload = body === undefined ? '' : JSON.stringify(body);
    let res: Response;
    try {
      res = await fetchImpl(`${base}${path}`, {
        method,
        headers: {
          'Content-Type': 'application/json',
          ...opts.headers,
          ...signJudgeRequest(opts.hmacSecret, method, `${basePath}${path}`, payload),
        },
        body: body === undefined ? undefined : payload,
        signal: AbortSignal.timeout(opts.timeoutMs ?? 10_000),
      });
    } catch (err) {
      throw new JudgeUnavailableError(provider, `${method} failed (network/timeout)`, {
        cause: err,
      });
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined);
      throw new JudgeUnavailableError(provider, `${method} rejected (HTTP ${res.status})`);
    }
    return (await res.json()) as T;
  };
}

// ---- CodeBegun Judge (target) ----------------------------------------------------------------

/**
 * The future CodeBegun Judge API: `GET /v1/languages`, `POST /v1/submissions`
 * → `{token}`, `GET /v1/submissions/:token` → `{status, result?}`.
 */
export function createCodeBegunJudge(opts: HttpOptions): JudgeAdapter {
  const call = client('codebegun-judge', opts);
  return {
    name: 'codebegun',
    async listLanguages() {
      return (await call<{ languages: CodingLanguage[] }>('GET', '/v1/languages')).languages;
    },
    async submit(request) {
      return call<{ token: string }>('POST', '/v1/submissions', request);
    },
    async status(token) {
      const r = await call<{ status: JudgeStatus }>(
        'GET',
        `/v1/submissions/${encodeURIComponent(token)}`,
      );
      return r.status;
    },
    async result(token) {
      const r = await call<{ status: JudgeStatus; result?: JudgeResult }>(
        'GET',
        `/v1/submissions/${encodeURIComponent(token)}`,
      );
      if (r.status !== 'DONE' || !r.result) {
        throw new JudgeUnavailableError('codebegun-judge', 'result not ready');
      }
      return r.result;
    },
  };
}

// ---- Judge0 (interim, self-hosted on a separate host) ------------------------------------------

/** Judge0 CE language ids. */
export const JUDGE0_LANGUAGE_IDS: Readonly<Record<CodingLanguage, number>> = {
  python: 71,
  javascript: 63,
  java: 62,
  cpp: 54,
};

const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');
const unb64 = (s: string | null | undefined) =>
  s == null ? null : Buffer.from(s, 'base64').toString('utf8');

/** Judge0 status id → verdict. */
export function judge0Verdict(statusId: number): JudgeVerdict {
  if (statusId === 3) return 'ACCEPTED';
  if (statusId === 4) return 'WRONG_ANSWER';
  if (statusId === 5) return 'TIME_LIMIT';
  if (statusId === 6) return 'COMPILE_ERROR';
  if (statusId >= 7 && statusId <= 12) return 'RUNTIME_ERROR';
  if (statusId === 14) return 'RUNTIME_ERROR';
  return 'JUDGE_ERROR';
}

interface Judge0Submission {
  token?: string;
  status_id?: number;
  status?: { id: number };
  stdout?: string | null;
  stderr?: string | null;
  compile_output?: string | null;
  time?: string | null;
  memory?: number | null;
}

/**
 * Judge0 CE batch API: one Judge0 submission per test. Our token encodes the
 * batch's tokens. Requests carry the HMAC headers too, for a verifying proxy
 * in front of the judge host.
 */
export function createJudge0Adapter(opts: HttpOptions & { authToken?: string }): JudgeAdapter {
  const call = client('judge0', {
    ...opts,
    headers: { ...opts.headers, ...(opts.authToken ? { 'X-Auth-Token': opts.authToken } : {}) },
  });
  const decode = (token: string) =>
    JSON.parse(Buffer.from(token, 'base64url').toString('utf8')) as string[];
  const fetchBatch = (token: string, fields: string) =>
    call<{ submissions: Judge0Submission[] }>(
      'GET',
      `/submissions/batch?tokens=${decode(token).join(',')}&base64_encoded=true&fields=${fields}`,
    );
  return {
    name: 'judge0',
    async listLanguages() {
      const langs = await call<{ id: number }[]>('GET', '/languages');
      const available = new Set(langs.map((l) => l.id));
      return (Object.entries(JUDGE0_LANGUAGE_IDS) as [CodingLanguage, number][])
        .filter(([, id]) => available.has(id))
        .map(([lang]) => lang);
    },
    async submit(request: JudgeRequest) {
      const res = await call<{ token: string }[]>(
        'POST',
        '/submissions/batch?base64_encoded=true',
        {
          submissions: request.tests.map((t) => ({
            language_id: JUDGE0_LANGUAGE_IDS[request.language],
            source_code: b64(request.source),
            stdin: b64(t.input),
            expected_output: b64(t.expectedOutput),
            cpu_time_limit: request.limits.cpuMs / 1000,
            memory_limit: request.limits.memoryMb * 1024,
          })),
        },
      );
      return { token: Buffer.from(JSON.stringify(res.map((r) => r.token))).toString('base64url') };
    },
    async status(token) {
      const { submissions } = await fetchBatch(token, 'token,status_id');
      const ids = submissions.map((s) => s.status_id ?? s.status?.id ?? 1);
      if (ids.every((id) => id > 2)) return 'DONE';
      return ids.some((id) => id === 2) ? 'RUNNING' : 'QUEUED';
    },
    async result(token) {
      const { submissions } = await fetchBatch(
        token,
        'status_id,stdout,stderr,compile_output,time,memory',
      );
      const compile = submissions.map((s) => unb64(s.compile_output)).find((c) => c);
      return {
        compileOutput: compile ?? null,
        tests: submissions.map((s) => ({
          verdict: judge0Verdict(s.status_id ?? s.status?.id ?? 13),
          stdout: unb64(s.stdout),
          stderr: unb64(s.stderr),
          timeMs: s.time != null ? Math.round(Number(s.time) * 1000) : null,
          memoryKb: s.memory ?? null,
        })),
      };
    },
  };
}

// ---- Mock (development/test only) ---------------------------------------------------------------

/**
 * DEVELOPMENT/TEST ONLY. Never executes code: the outcome comes from markers
 * in the source, so tests and demos are deterministic and safe.
 * - `MOCK_JUDGE_DOWN`: the judge is unreachable.
 * - `MOCK_COMPILE_ERROR`: compilation fails.
 * - `MOCK_TIMEOUT`: every test exceeds the time limit.
 * - `MOCK_PASS_<n>`: the first n tests pass, the rest are wrong answers.
 * - otherwise every test passes.
 * `setDown(true)` makes every call fail (a judge outage).
 */
export function createMockJudge() {
  let down = false;
  const pending = new Map<string, JudgeResult>();
  let seq = 0;
  const adapter: JudgeAdapter = {
    name: 'mock',
    async listLanguages() {
      if (down) throw new JudgeUnavailableError('mock-judge', 'judge down');
      return ['python', 'javascript', 'java', 'cpp'];
    },
    async submit(request) {
      if (down || request.source.includes('MOCK_JUDGE_DOWN')) {
        throw new JudgeUnavailableError('mock-judge', 'judge down');
      }
      const compileError = request.source.includes('MOCK_COMPILE_ERROR');
      const timeout = request.source.includes('MOCK_TIMEOUT');
      const passN = /MOCK_PASS_(\d+)/.exec(request.source);
      const limit = passN ? Number(passN[1]) : Infinity;
      const result: JudgeResult = {
        compileOutput: compileError ? 'error: expected expression (mock)' : null,
        tests: request.tests.map((t, i) => {
          const verdict: JudgeVerdict = compileError
            ? 'COMPILE_ERROR'
            : timeout
              ? 'TIME_LIMIT'
              : i < limit
                ? 'ACCEPTED'
                : 'WRONG_ANSWER';
          return {
            verdict,
            stdout:
              verdict === 'ACCEPTED'
                ? t.expectedOutput
                : verdict === 'WRONG_ANSWER'
                  ? 'mock output\n'
                  : null,
            stderr: null,
            timeMs: verdict === 'TIME_LIMIT' ? request.limits.cpuMs : 12,
            memoryKb: 2048,
          };
        }),
      };
      const token = `mock-${++seq}`;
      pending.set(token, result);
      return { token };
    },
    async status(token) {
      if (down) throw new JudgeUnavailableError('mock-judge', 'judge down');
      if (!pending.has(token)) throw new JudgeUnavailableError('mock-judge', 'unknown token');
      return 'DONE';
    },
    async result(token) {
      if (down) throw new JudgeUnavailableError('mock-judge', 'judge down');
      const r = pending.get(token);
      if (!r) throw new JudgeUnavailableError('mock-judge', 'unknown token');
      pending.delete(token);
      return r;
    },
  };
  return {
    adapter,
    setDown(value: boolean) {
      down = value;
    },
  };
}

// ---- Factory -----------------------------------------------------------------------------------

export interface JudgeSettings {
  JUDGE_PROVIDER: 'codebegun' | 'judge0' | 'mock';
  JUDGE_BASE_URL?: string;
  JUDGE_HMAC_SECRET?: string;
  JUDGE0_AUTH_TOKEN?: string;
}

let sharedMock: ReturnType<typeof createMockJudge> | null = null;

/** The judge from environment settings (the mock is refused outside development/test by env validation). */
export function createJudge(env: JudgeSettings): JudgeAdapter {
  switch (env.JUDGE_PROVIDER) {
    case 'codebegun':
      return createCodeBegunJudge({
        baseUrl: env.JUDGE_BASE_URL!,
        hmacSecret: env.JUDGE_HMAC_SECRET!,
      });
    case 'judge0':
      return createJudge0Adapter({
        baseUrl: env.JUDGE_BASE_URL!,
        hmacSecret: env.JUDGE_HMAC_SECRET!,
        authToken: env.JUDGE0_AUTH_TOKEN,
      });
    case 'mock':
      sharedMock ??= createMockJudge();
      return sharedMock.adapter;
  }
}

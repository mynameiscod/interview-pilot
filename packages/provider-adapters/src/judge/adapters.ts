import { CodingLanguage, parseLanguageIds, type JudgeVerdict } from '@cbi/shared-types';
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

/**
 * Judge0 CE language ids (the ids of the Judge0 CE 1.13 image: Python 3.8.1,
 * Node.js 12.14.0, OpenJDK 13.0.1, GCC 9.2.0, TypeScript 3.7.4, Go 1.13.5,
 * Mono 6.6.0.161, Kotlin 1.3.70, Rust 1.40.0 and SQLite 3.27.2). Installs with
 * newer compilers use other ids (e.g. TypeScript 5.0.3 is 94): override them
 * per language with `JUDGE0_LANGUAGE_IDS` or the admin integration settings.
 */
export const JUDGE0_LANGUAGE_IDS: Readonly<Record<CodingLanguage, number>> = {
  python: 71,
  javascript: 63,
  java: 62,
  cpp: 54,
  typescript: 74,
  go: 60,
  csharp: 51,
  c: 50,
  kotlin: 78,
  rust: 73,
  sql: 82,
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

/** Judge0's default MAX_SUBMISSION_BATCH_SIZE: larger batches are refused. */
export const JUDGE0_DEFAULT_BATCH_SIZE = 20;

/** Splits `items` into chunks of at most `size`, in order. */
function chunks<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * Judge0 CE batch API: one Judge0 submission per test, sent (and read back)
 * in batches of at most `maxBatchSize` (the judge's MAX_SUBMISSION_BATCH_SIZE).
 * Our token encodes every batch's tokens, in test order. Requests carry the
 * HMAC headers too, for a verifying proxy in front of the judge host.
 */
export function createJudge0Adapter(
  opts: HttpOptions & {
    authToken?: string;
    maxBatchSize?: number;
    /** Per-language id overrides for this install (the rest keep JUDGE0_LANGUAGE_IDS). */
    languageIds?: Partial<Record<CodingLanguage, number>>;
  },
): JudgeAdapter {
  const call = client('judge0', {
    ...opts,
    headers: { ...opts.headers, ...(opts.authToken ? { 'X-Auth-Token': opts.authToken } : {}) },
  });
  const batchSize = Math.max(1, Math.floor(opts.maxBatchSize ?? JUDGE0_DEFAULT_BATCH_SIZE));
  const languageIds: Record<CodingLanguage, number> = {
    ...JUDGE0_LANGUAGE_IDS,
    ...opts.languageIds,
  };
  const decode = (token: string) =>
    JSON.parse(Buffer.from(token, 'base64url').toString('utf8')) as string[];
  const fetchBatch = async (token: string, fields: string) => {
    const pages = await Promise.all(
      chunks(decode(token), batchSize).map((tokens) =>
        call<{ submissions: Judge0Submission[] }>(
          'GET',
          `/submissions/batch?tokens=${tokens.join(',')}&base64_encoded=true&fields=${fields}`,
        ),
      ),
    );
    return { submissions: pages.flatMap((p) => p.submissions) };
  };
  return {
    name: 'judge0',
    async listLanguages() {
      const langs = await call<{ id: number }[]>('GET', '/languages');
      const available = new Set(langs.map((l) => l.id));
      return (Object.entries(languageIds) as [CodingLanguage, number][])
        .filter(([, id]) => available.has(id))
        .map(([lang]) => lang);
    },
    async submit(request: JudgeRequest) {
      const tokens: string[] = [];
      // One batch at a time, so the tokens stay in test order.
      for (const tests of chunks(request.tests, batchSize)) {
        const res = await call<{ token: string }[]>(
          'POST',
          '/submissions/batch?base64_encoded=true',
          {
            submissions: tests.map((t) => ({
              language_id: languageIds[request.language],
              // SQL: the schema and the test's rows run first, in the same script.
              source_code: b64(t.prelude ? `${t.prelude}\n${request.source}` : request.source),
              stdin: b64(t.input),
              // Only exact comparisons are left to Judge0; the others just run.
              ...((t.compare ?? 'EXACT') === 'EXACT'
                ? { expected_output: b64(t.expectedOutput) }
                : {}),
              cpu_time_limit: request.limits.cpuMs / 1000,
              memory_limit: request.limits.memoryMb * 1024,
            })),
          },
        );
        tokens.push(...res.map((r) => r.token));
      }
      return { token: Buffer.from(JSON.stringify(tokens)).toString('base64url') };
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
 * - `MOCK_RUNTIME_ERROR`: every test crashes (with a message on stderr).
 * - `MOCK_PASS_<n>`: the first n tests pass, the rest are wrong answers.
 * - otherwise every test passes.
 * Tests that compare nothing (custom input) report a fixed line, never a
 * program's output. `setDown(true)` makes every call fail (a judge outage).
 */
export function createMockJudge() {
  let down = false;
  const pending = new Map<string, JudgeResult>();
  let seq = 0;
  const adapter: JudgeAdapter = {
    name: 'mock',
    async listLanguages() {
      if (down) throw new JudgeUnavailableError('mock-judge', 'judge down');
      return [...CodingLanguage.options];
    },
    async submit(request) {
      if (down || request.source.includes('MOCK_JUDGE_DOWN')) {
        throw new JudgeUnavailableError('mock-judge', 'judge down');
      }
      const compileError = request.source.includes('MOCK_COMPILE_ERROR');
      const timeout = request.source.includes('MOCK_TIMEOUT');
      const crash = request.source.includes('MOCK_RUNTIME_ERROR');
      const passN = /MOCK_PASS_(\d+)/.exec(request.source);
      const limit = passN ? Number(passN[1]) : Infinity;
      const result: JudgeResult = {
        compileOutput: compileError ? 'error: expected expression (mock)' : null,
        tests: request.tests.map((t, i) => {
          const custom = t.compare === 'NONE';
          const verdict: JudgeVerdict = compileError
            ? 'COMPILE_ERROR'
            : timeout
              ? 'TIME_LIMIT'
              : crash
                ? 'RUNTIME_ERROR'
                : custom || i < limit
                  ? 'ACCEPTED'
                  : 'WRONG_ANSWER';
          return {
            verdict,
            stdout:
              verdict === 'ACCEPTED'
                ? custom
                  ? `[mock judge] read ${t.input.length} characters of input\n`
                  : t.expectedOutput
                : verdict === 'WRONG_ANSWER'
                  ? 'mock output\n'
                  : null,
            stderr: verdict === 'RUNTIME_ERROR' ? 'mock: the program crashed\n' : null,
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
  JUDGE_PROVIDER: 'codebegun' | 'judge0' | 'mock' | 'none';
  JUDGE_BASE_URL?: string;
  JUDGE_HMAC_SECRET?: string;
  JUDGE0_AUTH_TOKEN?: string;
  /** Judge0's MAX_SUBMISSION_BATCH_SIZE (default 20). */
  JUDGE0_MAX_BATCH_SIZE?: number;
  /** Judge0 language id overrides, `language=id,…` (validated with the environment). */
  JUDGE0_LANGUAGE_IDS?: string;
}

/** Language id overrides from `language=id,…`; an invalid value is refused by env validation first. */
export function judge0LanguageIds(
  value: string | undefined,
): Partial<Record<CodingLanguage, number>> {
  const parsed = parseLanguageIds(value);
  return parsed.ok ? parsed.ids : {};
}

let sharedMock: ReturnType<typeof createMockJudge> | null = null;

/** The judge from environment settings (the mock is refused outside development/test by env validation). */
export function createJudge(env: JudgeSettings): JudgeAdapter | null {
  switch (env.JUDGE_PROVIDER) {
    case 'none':
      return null;
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
        maxBatchSize: env.JUDGE0_MAX_BATCH_SIZE,
        languageIds: judge0LanguageIds(env.JUDGE0_LANGUAGE_IDS),
      });
    case 'mock':
      sharedMock ??= createMockJudge();
      return sharedMock.adapter;
  }
}

import { describe, expect, it, vi } from 'vitest';
import {
  createCodeBegunJudge,
  createJudge0Adapter,
  createMockJudge,
  judge0LanguageIds,
  judge0Verdict,
} from './adapters.js';
import {
  JudgeUnavailableError,
  runOnJudge,
  signJudgeRequest,
  verifyJudgeSignature,
  type JudgeRequest,
} from './types.js';

const request: JudgeRequest = {
  language: 'python',
  source: 'print(input())',
  tests: [
    { input: '1\n', expectedOutput: '1\n' },
    { input: '2\n', expectedOutput: '2\n' },
    { input: '3\n', expectedOutput: '3\n' },
  ],
  limits: { cpuMs: 2000, memoryMb: 128 },
};
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const noSleep = async () => undefined;

describe('request signing', () => {
  it('signs timestamp.METHOD.path.bodyHash and verifies within the clock window', () => {
    const now = Date.parse('2026-09-24T12:00:00Z');
    const body = '{"a":1}';
    const h = signJudgeRequest('s3cret', 'post', '/v1/submissions', body, now);
    const req = {
      method: 'POST',
      path: '/v1/submissions',
      body,
      timestamp: h['x-cb-timestamp'],
      signature: h['x-cb-signature'],
    };
    expect(verifyJudgeSignature('s3cret', req, now)).toBe(true);
    expect(verifyJudgeSignature('s3cret', req, now + 4 * 60_000)).toBe(true);
    expect(verifyJudgeSignature('s3cret', req, now + 6 * 60_000)).toBe(false);
    expect(verifyJudgeSignature('other', req, now)).toBe(false);
    expect(verifyJudgeSignature('s3cret', { ...req, body: '{"a":2}' }, now)).toBe(false);
    expect(verifyJudgeSignature('s3cret', { ...req, path: '/v1/languages' }, now)).toBe(false);
    expect(verifyJudgeSignature('s3cret', { ...req, signature: undefined }, now)).toBe(false);
  });
});

describe('CodeBegun judge adapter', () => {
  it('sends signed requests and returns the result when done', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(json(200, { token: 'tok-1' }))
      .mockResolvedValueOnce(json(200, { status: 'RUNNING' }))
      .mockResolvedValueOnce(json(200, { status: 'DONE' }))
      .mockResolvedValueOnce(
        json(200, {
          status: 'DONE',
          result: {
            compileOutput: null,
            tests: [{ verdict: 'ACCEPTED', stdout: '1\n', stderr: null, timeMs: 5, memoryKb: 1 }],
          },
        }),
      );
    const judge = createCodeBegunJudge({
      baseUrl: 'https://judge.internal/api',
      hmacSecret: 'k',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const result = await runOnJudge(judge, request, { waitMs: 5000, sleep: noSleep });
    expect(result.tests[0]!.verdict).toBe('ACCEPTED');
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe('https://judge.internal/api/v1/submissions');
    // The signature covers the path as the judge sees it (with the base path).
    expect(
      verifyJudgeSignature('k', {
        method: 'POST',
        path: '/api/v1/submissions',
        body: init.body,
        timestamp: init.headers['x-cb-timestamp'],
        signature: init.headers['x-cb-signature'],
      }),
    ).toBe(true);
  });

  it('reports outages and slow judges as unavailable', async () => {
    const down = createCodeBegunJudge({
      baseUrl: 'https://judge.internal',
      hmacSecret: 'k',
      fetchImpl: vi
        .fn()
        .mockRejectedValue(new TypeError('fetch failed')) as unknown as typeof fetch,
    });
    await expect(
      runOnJudge(down, request, { waitMs: 1000, sleep: noSleep }),
    ).rejects.toBeInstanceOf(JudgeUnavailableError);
    const refusing = createCodeBegunJudge({
      baseUrl: 'https://judge.internal',
      hmacSecret: 'k',
      fetchImpl: vi
        .fn()
        .mockResolvedValue(
          json(401, { error: 'bad signature: secret' }),
        ) as unknown as typeof fetch,
    });
    const err = await runOnJudge(refusing, request, { waitMs: 1000, sleep: noSleep }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(JudgeUnavailableError);
    expect(String((err as Error).message)).not.toContain('secret');
    const slow = createCodeBegunJudge({
      baseUrl: 'https://judge.internal',
      hmacSecret: 'k',
      fetchImpl: vi.fn(async (url: string) =>
        String(url).endsWith('/v1/submissions')
          ? json(200, { token: 't' })
          : json(200, { status: 'QUEUED' }),
      ) as unknown as typeof fetch,
    });
    await expect(runOnJudge(slow, request, { waitMs: 0, sleep: noSleep })).rejects.toThrow(
      /in time/,
    );
  });
});

describe('Judge0 adapter', () => {
  it('submits one base64 submission per test and maps statuses and verdicts', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(json(201, [{ token: 'a' }, { token: 'b' }, { token: 'c' }]))
      .mockResolvedValueOnce(
        json(200, { submissions: [{ status_id: 3 }, { status_id: 2 }, { status_id: 1 }] }),
      )
      .mockResolvedValueOnce(
        json(200, { submissions: [{ status_id: 3 }, { status_id: 4 }, { status_id: 5 }] }),
      )
      .mockResolvedValueOnce(
        json(200, {
          submissions: [
            {
              status_id: 3,
              stdout: Buffer.from('1\n').toString('base64'),
              time: '0.012',
              memory: 3000,
            },
            {
              status_id: 4,
              stdout: Buffer.from('9\n').toString('base64'),
              time: '0.010',
              memory: 3000,
            },
            { status_id: 5, stdout: null, time: '2.001', memory: 3000 },
          ],
        }),
      );
    const judge = createJudge0Adapter({
      baseUrl: 'http://judge0.internal:2358',
      hmacSecret: 'k',
      authToken: 'j0-token',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const result = await runOnJudge(judge, request, { waitMs: 5000, sleep: noSleep });
    expect(result.tests.map((t) => t.verdict)).toEqual(['ACCEPTED', 'WRONG_ANSWER', 'TIME_LIMIT']);
    expect(result.tests[0]).toMatchObject({ stdout: '1\n', timeMs: 12 });
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe('http://judge0.internal:2358/submissions/batch?base64_encoded=true');
    expect(init.headers['X-Auth-Token']).toBe('j0-token');
    const body = JSON.parse(init.body);
    expect(body.submissions).toHaveLength(3);
    expect(body.submissions[0]).toMatchObject({
      language_id: 71,
      source_code: Buffer.from('print(input())').toString('base64'),
      cpu_time_limit: 2,
      memory_limit: 131072,
    });
    expect(String(fetchImpl.mock.calls[1]![0])).toContain('tokens=a,b,c');
  });

  it('splits large test sets into batches the judge accepts and merges the results in order', async () => {
    const tests = Array.from({ length: 45 }, (_, i) => ({
      input: `${i}\n`,
      expectedOutput: `${i}\n`,
    }));
    const posted: number[] = [];
    const read: number[] = [];
    const fetchImpl = vi.fn(async (url: string, init: { method: string; body?: string }) => {
      if (init.method === 'POST') {
        const { submissions } = JSON.parse(init.body!) as { submissions: { stdin: string }[] };
        posted.push(submissions.length);
        // Judge0's default MAX_SUBMISSION_BATCH_SIZE.
        if (submissions.length > 20) return json(422, { error: 'too many submissions' });
        return json(
          201,
          submissions.map((s) => ({
            token: `t${Buffer.from(s.stdin, 'base64').toString().trim()}`,
          })),
        );
      }
      const tokens = new URL(url).searchParams.get('tokens')!.split(',');
      read.push(tokens.length);
      if (tokens.length > 20) return json(422, { error: 'too many tokens' });
      return json(200, {
        submissions: tokens.map((t) => ({
          status_id: 3,
          stdout: Buffer.from(`${t.slice(1)}\n`).toString('base64'),
        })),
      });
    });
    const judge = createJudge0Adapter({
      baseUrl: 'http://judge0.internal:2358',
      hmacSecret: 'k',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const result = await runOnJudge(judge, { ...request, tests }, { waitMs: 5000, sleep: noSleep });
    expect(posted).toEqual([20, 20, 5]);
    expect(read.slice(-3)).toEqual([20, 20, 5]);
    expect(result.tests).toHaveLength(45);
    expect(result.tests.map((t) => t.stdout)).toEqual(tests.map((t) => t.expectedOutput));

    // The batch size is configurable (a judge set up with a smaller limit).
    posted.length = 0;
    const small = createJudge0Adapter({
      baseUrl: 'http://judge0.internal:2358',
      hmacSecret: 'k',
      maxBatchSize: 8,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await runOnJudge(
      small,
      { ...request, tests: tests.slice(0, 20) },
      { waitMs: 5000, sleep: noSleep },
    );
    expect(posted).toEqual([8, 8, 4]);
  });

  it('uses per-install language ids, prepends SQL preludes and leaves unordered checks to the caller', async () => {
    const bodies: { submissions: Record<string, unknown>[] }[] = [];
    const fetchImpl = vi.fn(async (url: string, init: { method: string; body?: string }) => {
      if (init.method === 'POST') {
        bodies.push(JSON.parse(init.body!));
        return json(201, [{ token: 'a' }, { token: 'b' }]);
      }
      if (String(url).endsWith('/languages')) return json(200, [{ id: 94 }, { id: 82 }]);
      return json(200, { submissions: [{ status_id: 3 }, { status_id: 3 }] });
    });
    const judge = createJudge0Adapter({
      baseUrl: 'http://judge0.internal:2358',
      hmacSecret: 'k',
      languageIds: judge0LanguageIds('typescript=94'),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await judge.submit({
      language: 'typescript',
      source: 'console.log(1)',
      tests: [{ input: '', expectedOutput: '1\n' }],
      limits: { cpuMs: 1000, memoryMb: 64 },
    });
    expect(bodies[0]!.submissions[0]).toMatchObject({ language_id: 94 });
    await judge.submit({
      language: 'sql',
      source: 'SELECT 1;',
      tests: [
        {
          input: '',
          expectedOutput: '1\n',
          prelude: 'CREATE TABLE t(x);',
          compare: 'UNORDERED_LINES',
        },
        { input: '', expectedOutput: '1\n', prelude: 'CREATE TABLE t(x);', compare: 'EXACT' },
      ],
      limits: { cpuMs: 1000, memoryMb: 64 },
    });
    const [unordered, exact] = bodies[1]!.submissions;
    expect(unordered).toMatchObject({ language_id: 82 });
    expect(Buffer.from(String(unordered!.source_code), 'base64').toString()).toBe(
      'CREATE TABLE t(x);\nSELECT 1;',
    );
    expect(unordered).not.toHaveProperty('expected_output');
    expect(exact).toHaveProperty('expected_output');
    // Only languages whose (overridden) id the install has are offered.
    expect(await judge.listLanguages()).toEqual(['typescript', 'sql']);
    expect(judge0LanguageIds('nonsense')).toEqual({});
    expect(judge0LanguageIds(undefined)).toEqual({});
  });

  it('maps every Judge0 status to a verdict', () => {
    expect([3, 4, 5, 6, 7, 11, 13, 14].map(judge0Verdict)).toEqual([
      'ACCEPTED',
      'WRONG_ANSWER',
      'TIME_LIMIT',
      'COMPILE_ERROR',
      'RUNTIME_ERROR',
      'RUNTIME_ERROR',
      'JUDGE_ERROR',
      'RUNTIME_ERROR',
    ]);
  });
});

describe('mock judge', () => {
  it('decides outcomes from markers without running code, and can be taken down', async () => {
    const mock = createMockJudge();
    const run = (source: string) =>
      runOnJudge(mock.adapter, { ...request, source }, { waitMs: 1000, sleep: noSleep });
    expect((await run('print(1)')).tests.every((t) => t.verdict === 'ACCEPTED')).toBe(true);
    expect((await run('# MOCK_PASS_2')).tests.map((t) => t.verdict)).toEqual([
      'ACCEPTED',
      'ACCEPTED',
      'WRONG_ANSWER',
    ]);
    const compile = await run('MOCK_COMPILE_ERROR');
    expect(compile.compileOutput).toContain('error');
    expect((await run('MOCK_TIMEOUT')).tests[0]!.verdict).toBe('TIME_LIMIT');
    await expect(run('MOCK_JUDGE_DOWN')).rejects.toBeInstanceOf(JudgeUnavailableError);
    mock.setDown(true);
    await expect(run('print(1)')).rejects.toBeInstanceOf(JudgeUnavailableError);
    mock.setDown(false);
    expect(await mock.adapter.listLanguages()).toContain('cpp');
    expect(await mock.adapter.listLanguages()).toContain('sql');
  });

  it('answers custom-input runs with a fixed line and reports crashes', async () => {
    const mock = createMockJudge();
    const custom = await runOnJudge(
      mock.adapter,
      {
        ...request,
        source: 'print(input()) # MOCK_PASS_0',
        tests: [{ input: 'hello\n', expectedOutput: '', compare: 'NONE' }],
      },
      { waitMs: 1000, sleep: noSleep },
    );
    expect(custom.tests[0]).toMatchObject({
      verdict: 'ACCEPTED',
      stdout: '[mock judge] read 6 characters of input\n',
    });
    const crashed = await runOnJudge(
      mock.adapter,
      { ...request, source: 'MOCK_RUNTIME_ERROR' },
      { waitMs: 1000, sleep: noSleep },
    );
    expect(crashed.tests.every((t) => t.verdict === 'RUNTIME_ERROR' && t.stderr)).toBe(true);
  });
});

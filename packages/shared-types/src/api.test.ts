import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ApiErrorBody, apiSuccess, ErrorCode } from './api.js';
import { ReadinessResponse } from './health.js';

describe('API contracts', () => {
  it('accepts a well-formed error body', () => {
    const parsed = ApiErrorBody.parse({
      error: { code: 'NOT_FOUND', message: 'Route not found', requestId: 'abc' },
    });
    expect(parsed.error.code).toBe('NOT_FOUND');
  });

  it('rejects unknown error codes', () => {
    expect(ErrorCode.safeParse('TEAPOT').success).toBe(false);
  });

  it('wraps data in a success envelope', () => {
    const schema = apiSuccess(z.object({ id: z.string() }));
    expect(schema.parse({ data: { id: '1' } })).toEqual({ data: { id: '1' } });
    expect(schema.safeParse({ id: '1' }).success).toBe(false);
  });

  it('validates readiness payloads', () => {
    const ok = ReadinessResponse.safeParse({
      status: 'ready',
      env: 'development',
      checks: { mongo: { status: 'up', latencyMs: 3 } },
    });
    expect(ok.success).toBe(true);
    expect(ReadinessResponse.safeParse({ status: 'ready', env: 'prod', checks: {} }).success).toBe(
      false,
    );
  });
});

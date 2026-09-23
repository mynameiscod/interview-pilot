import { createLogger } from '@cbi/config';
import { ApiErrorBody, LivenessResponse, ReadinessResponse } from '@cbi/shared-types';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp, type AppDependencies } from './app.js';
import { buildTestApp } from './test-support/harness.js';

const ALLOWED = 'http://localhost:5173';

async function buildApp(
  overrides: {
    probes?: AppDependencies['probes'];
    isDraining?: () => boolean;
    env?: Record<string, string>;
  } = {},
) {
  const { container } = await buildTestApp({
    env: { APP_VERSION: '1.2.3-test', REQUEST_BODY_LIMIT: '1kb', ...overrides.env },
  });
  return createApp({
    container,
    logger: createLogger({ service: 'api-test', level: 'silent' }),
    probes: overrides.probes ?? { mongo: async () => undefined, redis: async () => undefined },
    isDraining: overrides.isDraining ?? (() => false),
  });
}

describe('health endpoints', () => {
  it('GET /healthz reports liveness without touching dependencies', async () => {
    const app = await buildApp({
      probes: {
        mongo: () => Promise.reject(new Error('down')),
      },
    });
    const res = await request(app).get('/healthz').expect(200);
    const body = LivenessResponse.parse(res.body);
    expect(body.version).toBe('1.2.3-test');
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('GET /readyz is 200 when all probes pass', async () => {
    const res = await request(await buildApp())
      .get('/readyz')
      .expect(200);
    const body = ReadinessResponse.parse(res.body);
    expect(body.status).toBe('ready');
    expect(body.checks.mongo?.status).toBe('up');
  });

  it('GET /readyz is 503 with a sanitized reason when a probe fails', async () => {
    const app = await buildApp({
      probes: {
        mongo: () => Promise.reject(new Error('connect ECONNREFUSED mongodb://admin:pw@db')),
        redis: async () => undefined,
      },
    });
    const res = await request(app).get('/readyz').expect(503);
    expect(res.body.checks.mongo).toMatchObject({ status: 'down', reason: 'unreachable' });
    expect(JSON.stringify(res.body)).not.toContain('pw@db');
  });

  it('GET /readyz is 503 while draining', async () => {
    const res = await request(await buildApp({ isDraining: () => true }))
      .get('/readyz')
      .expect(503);
    expect(res.body.checks.process).toMatchObject({ status: 'down', reason: 'draining' });
  });
});

describe('request ids', () => {
  it('generates a request id when none is supplied', async () => {
    const res = await request(await buildApp()).get('/healthz');
    expect(res.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('reuses a well-formed upstream request id', async () => {
    const res = await request(await buildApp())
      .get('/healthz')
      .set('X-Request-Id', 'nginx-abc12345');
    expect(res.headers['x-request-id']).toBe('nginx-abc12345');
  });

  it('replaces a malformed upstream request id', async () => {
    const res = await request(await buildApp())
      .get('/healthz')
      .set('X-Request-Id', 'bad id<script>');
    expect(res.headers['x-request-id']).not.toContain('<script>');
  });
});

describe('error envelope', () => {
  it('returns NOT_FOUND for unknown v1 routes', async () => {
    const res = await request(await buildApp())
      .get('/api/v1/nope')
      .expect(404);
    const body = ApiErrorBody.parse(res.body);
    expect(body.error.code).toBe('NOT_FOUND');
    expect(body.error.requestId).toBe(res.headers['x-request-id']);
  });

  it('returns NOT_FOUND for unknown non-API routes', async () => {
    const res = await request(await buildApp())
      .get('/wp-admin')
      .expect(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('rejects malformed JSON without echoing input', async () => {
    const res = await request(await buildApp())
      .post('/api/v1/anything')
      .set('Content-Type', 'application/json')
      .send('{"secret": "abc"')
      .expect(400);
    expect(res.body.error.code).toBe('BAD_REQUEST');
    expect(JSON.stringify(res.body)).not.toContain('abc');
  });

  it('rejects bodies over the configured limit', async () => {
    const res = await request(await buildApp())
      .post('/api/v1/anything')
      .send({ blob: 'x'.repeat(2048) })
      .expect(413);
    expect(res.body.error.code).toBe('PAYLOAD_TOO_LARGE');
  });
});

describe('security headers and origin policy', () => {
  it('sets helmet headers and hides the framework', async () => {
    const res = await request(await buildApp()).get('/api/v1/x');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['strict-transport-security']).toBeDefined();
    expect(res.headers['x-powered-by']).toBeUndefined();
  });

  it('allows CORS preflight from an allowlisted origin with credentials', async () => {
    const res = await request(await buildApp())
      .options('/api/v1/x')
      .set('Origin', ALLOWED)
      .set('Access-Control-Request-Method', 'POST')
      .expect(204);
    expect(res.headers['access-control-allow-origin']).toBe(ALLOWED);
    expect(res.headers['access-control-allow-credentials']).toBe('true');
  });

  it('rejects requests from origins outside the allowlist', async () => {
    const res = await request(await buildApp())
      .get('/api/v1/x')
      .set('Origin', 'https://evil.example')
      .expect(403);
    expect(res.body.error.code).toBe('ORIGIN_NOT_ALLOWED');
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('allows server-to-server requests that send no Origin', async () => {
    await request(await buildApp())
      .get('/api/v1/x')
      .expect(404);
  });
});

describe('API docs', () => {
  it('are not served unless enabled', async () => {
    await request(await buildApp())
      .get('/api/docs/openapi.json')
      .expect(404);
  });

  it('serve the generated OpenAPI document when enabled', async () => {
    const enabled = await buildApp({ env: { APP_ENV: 'development', API_DOCS_ENABLED: 'true' } });
    const res = await request(enabled).get('/api/docs/openapi.json').expect(200);
    expect(res.body.openapi).toBe('3.1.0');
    expect(Object.keys(res.body.paths)).toEqual(
      expect.arrayContaining([
        '/healthz',
        '/readyz',
        '/api/v1/auth/otp/request',
        '/api/v1/admin/users',
      ]),
    );
  });
});

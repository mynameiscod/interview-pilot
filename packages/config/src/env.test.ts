import { describe, expect, it } from 'vitest';
import { apiEnvSchema, EnvValidationError, loadEnv, workerEnvSchema } from './env.js';

const base = {
  APP_ENV: 'development',
  MONGODB_URI: 'mongodb://localhost:27017/interview?directConnection=true',
  REDIS_URL: 'redis://localhost:6379',
  CORS_ALLOWED_ORIGINS: 'http://localhost:5173, http://localhost:5174',
};

describe('loadEnv', () => {
  it('parses a valid API environment with defaults', () => {
    const env = loadEnv(apiEnvSchema, base);
    expect(env.PORT_API).toBe(4000);
    expect(env.CORS_ALLOWED_ORIGINS).toEqual(['http://localhost:5173', 'http://localhost:5174']);
    expect(env.API_DOCS_ENABLED).toBe(false);
    expect(env.LOG_LEVEL).toBe('info');
  });

  it('reports invalid variables by name without echoing values', () => {
    try {
      loadEnv(apiEnvSchema, { ...base, MONGODB_URI: 'postgres://user:hunter2@db' });
      expect.fail('should throw');
    } catch (err) {
      expect(err).toBeInstanceOf(EnvValidationError);
      const message = (err as Error).message;
      expect(message).toContain('MONGODB_URI');
      expect(message).not.toContain('hunter2');
    }
  });

  it('reports missing required variables', () => {
    const { REDIS_URL: _omit, ...rest } = base;
    expect(() => loadEnv(apiEnvSchema, rest)).toThrow(/REDIS_URL/);
  });

  it('rejects origins with paths', () => {
    expect(() =>
      loadEnv(apiEnvSchema, {
        ...base,
        CORS_ALLOWED_ORIGINS: 'https://interview.codebegun.com/app',
      }),
    ).toThrow(/CORS_ALLOWED_ORIGINS/);
  });

  it('rejects non-HTTPS origins in production', () => {
    expect(() => loadEnv(apiEnvSchema, { ...base, APP_ENV: 'production' })).toThrow(
      /non-HTTPS origins/,
    );
  });

  it('refuses interactive API docs in production', () => {
    expect(() =>
      loadEnv(apiEnvSchema, {
        ...base,
        APP_ENV: 'production',
        CORS_ALLOWED_ORIGINS: 'https://interview.codebegun.com',
        API_DOCS_ENABLED: 'true',
      }),
    ).toThrow(/API_DOCS_ENABLED/);
  });

  it('parses worker environment', () => {
    const env = loadEnv(workerEnvSchema, base);
    expect(env.WORKER_HEALTH_PORT).toBe(4100);
  });
});

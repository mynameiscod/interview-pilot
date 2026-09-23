import { describe, expect, it } from 'vitest';
import { apiEnvSchema, EnvValidationError, loadEnv, workerEnvSchema } from './env.js';

const base = {
  APP_ENV: 'development',
  MONGODB_URI: 'mongodb://localhost:27017/interview?directConnection=true',
  REDIS_URL: 'redis://localhost:6379',
  CORS_ALLOWED_ORIGINS: 'http://localhost:5173, http://localhost:5174',
  PUBLIC_CANDIDATE_URL: 'http://localhost:5173',
  PUBLIC_ADMIN_URL: 'http://localhost:5174',
  JWT_ACCESS_SECRET: 'jwt-secret-for-tests-0123456789abcdef',
  OTP_HMAC_SECRET: 'otp-secret-for-tests-0123456789abcdef',
  EMAIL_PROVIDER: 'smtp',
  EMAIL_FROM: 'dev@localhost',
  SMTP_HOST: 'localhost',
  SMS_PROVIDER: 'dev-mailbox',
};

const deployed = {
  ...base,
  APP_ENV: 'production',
  CORS_ALLOWED_ORIGINS: 'https://interview.codebegun.com',
  SMS_PROVIDER: 'disabled',
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
    expect(() =>
      loadEnv(apiEnvSchema, { ...deployed, CORS_ALLOWED_ORIGINS: base.CORS_ALLOWED_ORIGINS }),
    ).toThrow(/non-HTTPS origins/);
  });

  it('refuses interactive API docs in production', () => {
    expect(() => loadEnv(apiEnvSchema, { ...deployed, API_DOCS_ENABLED: 'true' })).toThrow(
      /API_DOCS_ENABLED/,
    );
  });

  it('accepts a valid production configuration', () => {
    expect(loadEnv(apiEnvSchema, deployed).SMS_PROVIDER).toBe('disabled');
  });

  it('refuses the dev-mailbox SMS provider outside development', () => {
    expect(() => loadEnv(apiEnvSchema, { ...deployed, SMS_PROVIDER: 'dev-mailbox' })).toThrow(
      /SMS_PROVIDER/,
    );
  });

  it('refuses example secrets and plaintext SMTP in production', () => {
    expect(() =>
      loadEnv(apiEnvSchema, {
        ...deployed,
        JWT_ACCESS_SECRET: 'dev-only-jwt-secret-change-me-0123456789',
      }),
    ).toThrow(/JWT_ACCESS_SECRET/);
    expect(() => loadEnv(apiEnvSchema, { ...deployed, SMTP_REQUIRE_TLS: 'false' })).toThrow(
      /SMTP_REQUIRE_TLS/,
    );
  });

  it('requires provider credentials for the selected providers', () => {
    expect(() => loadEnv(apiEnvSchema, { ...base, EMAIL_PROVIDER: 'ses' })).toThrow(/SES_REGION/);
    expect(() => loadEnv(apiEnvSchema, { ...base, SMS_PROVIDER: 'msg91' })).toThrow(
      /MSG91_AUTH_KEY/,
    );
  });

  it('requires distinct JWT and OTP secrets', () => {
    expect(() =>
      loadEnv(apiEnvSchema, { ...base, OTP_HMAC_SECRET: base.JWT_ACCESS_SECRET }),
    ).toThrow(/OTP_HMAC_SECRET/);
  });

  it('parses worker environment', () => {
    const env = loadEnv(workerEnvSchema, base);
    expect(env.WORKER_HEALTH_PORT).toBe(4100);
  });
});

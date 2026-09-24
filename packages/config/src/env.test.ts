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
  AI_SECRETS_MASTER_KEY: 'ZGV2LW9ubHktYWktbWFzdGVyLWtleS1jaGFuZ2UtbWU=',
  STORAGE_PROVIDER: 'local',
};

const productionAiKey = Buffer.alloc(32, 7).toString('base64');

const deployed = {
  ...base,
  APP_ENV: 'production',
  CORS_ALLOWED_ORIGINS: 'https://interview.codebegun.com',
  SMS_PROVIDER: 'disabled',
  AI_SECRETS_MASTER_KEY: productionAiKey,
  STORAGE_PROVIDER: 'bunny',
  BUNNY_STORAGE_ZONE: 'cbi-private',
  BUNNY_STORAGE_ACCESS_KEY: 'bunny-storage-password',
  PAYMENT_PROVIDER: 'razorpay',
  RAZORPAY_KEY_ID: 'rzp_live_example',
  RAZORPAY_KEY_SECRET: 'razorpay-secret',
  RAZORPAY_WEBHOOK_SECRET: 'razorpay-webhook-secret',
};

describe('payment settings', () => {
  it('defaults to the mock gateway in development', () => {
    expect(loadEnv(apiEnvSchema, base).PAYMENT_PROVIDER).toBe('mock');
  });

  it('requires all Razorpay keys when Razorpay is selected', () => {
    expect(() =>
      loadEnv(apiEnvSchema, {
        ...base,
        PAYMENT_PROVIDER: 'razorpay',
        RAZORPAY_KEY_ID: 'rzp_test_x',
      }),
    ).toThrow(/RAZORPAY_KEY_ID/);
  });

  it('refuses the mock gateway in production', () => {
    expect(() => loadEnv(apiEnvSchema, { ...deployed, PAYMENT_PROVIDER: 'mock' })).toThrow(
      /PAYMENT_PROVIDER/,
    );
  });
});

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
    expect(env.JD_FETCH_MAX_BYTES).toBe(2 * 1024 * 1024);
    expect(env.UPLOAD_MAX_MB).toBe(8);
  });

  it('applies the shared AI and storage rules to the worker too', () => {
    expect(() => loadEnv(workerEnvSchema, { ...deployed, AI_MOCK_MODE: 'true' })).toThrow(
      /AI_MOCK_MODE/,
    );
    expect(() => loadEnv(workerEnvSchema, { ...deployed, STORAGE_PROVIDER: 'local' })).toThrow(
      /local storage is for development only/,
    );
  });

  it('requires Bunny credentials when STORAGE_PROVIDER=bunny', () => {
    expect(() =>
      loadEnv(apiEnvSchema, { ...base, STORAGE_PROVIDER: 'bunny', BUNNY_STORAGE_ZONE: 'zone' }),
    ).toThrow(/BUNNY_STORAGE_ACCESS_KEY/);
  });
});

describe('AI provider settings', () => {
  it('requires a 32-byte base64 master key', () => {
    expect(loadEnv(apiEnvSchema, base).AI_SECRETS_KEY_ID).toBe('k1');
    const { AI_SECRETS_MASTER_KEY: _omit, ...rest } = base;
    expect(() => loadEnv(apiEnvSchema, rest)).toThrow(/AI_SECRETS_MASTER_KEY/);
    expect(() =>
      loadEnv(apiEnvSchema, {
        ...base,
        AI_SECRETS_MASTER_KEY: Buffer.alloc(16).toString('base64'),
      }),
    ).toThrow(/32 bytes/);
  });

  it('refuses the mock provider and the example key when deployed', () => {
    expect(() => loadEnv(apiEnvSchema, { ...deployed, AI_MOCK_MODE: 'true' })).toThrow(
      /AI_MOCK_MODE/,
    );
    expect(() =>
      loadEnv(apiEnvSchema, { ...deployed, AI_SECRETS_MASTER_KEY: base.AI_SECRETS_MASTER_KEY }),
    ).toThrow(/example development key/);
    expect(loadEnv(apiEnvSchema, { ...base, AI_MOCK_MODE: 'true' }).AI_MOCK_MODE).toBe(true);
  });

  it('validates previous rotation keys', () => {
    const k0 = Buffer.alloc(32, 1).toString('base64');
    expect(
      loadEnv(apiEnvSchema, { ...base, AI_SECRETS_PREVIOUS_KEYS: `k0:${k0}` })
        .AI_SECRETS_PREVIOUS_KEYS,
    ).toBe(`k0:${k0}`);
    expect(() => loadEnv(apiEnvSchema, { ...base, AI_SECRETS_PREVIOUS_KEYS: 'k0:short' })).toThrow(
      /AI_SECRETS_PREVIOUS_KEYS/,
    );
    expect(() => loadEnv(apiEnvSchema, { ...base, AI_SECRETS_PREVIOUS_KEYS: `k1:${k0}` })).toThrow(
      /must not repeat/,
    );
  });
});

import { describe, expect, it } from 'vitest';
import { PII_FILTERED, scrubBreadcrumb, scrubErrorEvent, scrubPii, scrubText } from './pii.js';

describe('scrubText', () => {
  it('removes email addresses and phone numbers', () => {
    expect(scrubText('user asha.k+test@example.co.in failed')).toBe(`user ${PII_FILTERED} failed`);
    expect(scrubText('sms to +91 98765 43210 bounced')).toBe(`sms to ${PII_FILTERED} bounced`);
    expect(scrubText('otp for 9876543210')).toBe(`otp for ${PII_FILTERED}`);
  });

  it('removes bearer tokens, JWTs and credential query parameters', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.c2lnbmF0dXJl';
    expect(scrubText('Authorization: Bearer abc.def-ghi')).toBe(
      `Authorization: Bearer ${PII_FILTERED}`,
    );
    expect(scrubText(`token ${jwt} rejected`)).toBe(`token ${PII_FILTERED} rejected`);
    expect(scrubText('GET /cb?code=4/0Ab&state=x&token=s3cr3t')).toBe(
      `GET /cb?code=${PII_FILTERED}&state=x&token=${PII_FILTERED}`,
    );
  });

  it('keeps ordinary diagnostics readable', () => {
    const line = 'Timeout after 30000 ms at pipeline.ts:120:7 (session 66f1c2a9b8e4d1a2b3c4d5e6)';
    expect(scrubText(line)).toBe(line);
  });
});

describe('scrubPii', () => {
  it('filters sensitive keys at any depth and scrubs strings', () => {
    const out = scrubPii({
      headers: { Authorization: 'Bearer x', cookie: 'a=b', 'user-agent': 'UA' },
      body: { email: 'a@b.co', note: 'call 9876543210', nested: [{ password: 'p' }] },
      count: 3,
    });
    expect(out).toEqual({
      headers: { Authorization: PII_FILTERED, cookie: PII_FILTERED, 'user-agent': 'UA' },
      body: {
        email: PII_FILTERED,
        note: `call ${PII_FILTERED}`,
        nested: [{ password: PII_FILTERED }],
      },
      count: 3,
    });
  });

  it('does not mutate its input', () => {
    const input = { message: 'mail a@b.co' };
    scrubPii(input);
    expect(input.message).toBe('mail a@b.co');
  });
});

describe('scrubErrorEvent', () => {
  it('keeps only the user id and drops cookies', () => {
    const event = scrubErrorEvent({
      message: 'failed for a@b.co',
      user: { id: 'u1', email: 'a@b.co', ip_address: '1.2.3.4' },
      request: {
        url: 'https://api.example.com/x?token=abc',
        cookies: { refresh: 'r' },
        headers: { authorization: 'Bearer t' },
      },
      exception: { values: [{ type: 'Error', value: 'no user +919876543210' }] },
    });
    expect(event.user).toEqual({ id: 'u1' });
    expect(event.message).toBe(`failed for ${PII_FILTERED}`);
    expect(event.request).toEqual({
      url: `https://api.example.com/x?token=${PII_FILTERED}`,
      headers: { authorization: PII_FILTERED },
    });
    expect(JSON.stringify(event)).not.toMatch(/9876543210|a@b\.co|1\.2\.3\.4/);
  });

  it('removes an anonymous user entirely', () => {
    expect(scrubErrorEvent({ user: { ip_address: '1.2.3.4' } })).not.toHaveProperty('user');
  });
});

describe('scrubBreadcrumb', () => {
  it('scrubs fetch breadcrumb URLs', () => {
    expect(
      scrubBreadcrumb({ category: 'fetch', data: { url: '/auth?otp=123456', status_code: 400 } }),
    ).toEqual({ category: 'fetch', data: { url: `/auth?otp=${PII_FILTERED}`, status_code: 400 } });
  });
});

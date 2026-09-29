import { describe, expect, it } from 'vitest';
import { InviteAdminBody } from './admin.js';
import { OtpRequestBody, OtpVerifyBody } from './auth.js';
import { UpdateProfileBody } from './users.js';

describe('auth and profile contracts', () => {
  it('accepts only 6-digit OTP codes', () => {
    expect(OtpVerifyBody.safeParse({ challengeId: 'c', code: '123456' }).success).toBe(true);
    expect(OtpVerifyBody.safeParse({ challengeId: 'c', code: '12345' }).success).toBe(false);
    expect(OtpVerifyBody.safeParse({ challengeId: 'c', code: '12345a' }).success).toBe(false);
  });

  it('accepts an optional supported language on OTP requests', () => {
    const base = { channel: 'EMAIL', destination: 'asha@example.com' } as const;
    expect(OtpRequestBody.parse(base).lang).toBeUndefined();
    expect(OtpRequestBody.parse({ ...base, lang: 'te' }).lang).toBe('te');
    expect(OtpRequestBody.parse({ ...base, lang: 'hi' }).lang).toBe('hi');
    expect(OtpRequestBody.safeParse({ ...base, lang: 'fr' }).success).toBe(false);
    expect(OtpRequestBody.safeParse({ ...base, lang: 'hi-IN' }).success).toBe(false);
  });

  it('trims profile text and requires a name', () => {
    const parsed = UpdateProfileBody.parse({
      displayName: '  Asha  ',
      preferredInterviewLanguage: 'auto',
    });
    expect(parsed.displayName).toBe('Asha');
    expect(parsed.productUpdatesOptIn).toBe(false);
    expect(
      UpdateProfileBody.safeParse({ displayName: '   ', preferredInterviewLanguage: 'en' }).success,
    ).toBe(false);
  });

  it('normalizes invite emails and de-duplicates roles', () => {
    const parsed = InviteAdminBody.parse({
      email: 'Ops@CodeBegun.com',
      roles: ['SUPPORT_ADMIN', 'SUPPORT_ADMIN'],
    });
    expect(parsed.email).toBe('ops@codebegun.com');
    expect(parsed.roles).toEqual(['SUPPORT_ADMIN']);
  });
});

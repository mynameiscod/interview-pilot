import { describe, expect, it } from 'vitest';
import { InviteAdminBody } from './admin.js';
import { OtpVerifyBody } from './auth.js';
import { UpdateProfileBody } from './users.js';

describe('auth and profile contracts', () => {
  it('accepts only 6-digit OTP codes', () => {
    expect(OtpVerifyBody.safeParse({ challengeId: 'c', code: '123456' }).success).toBe(true);
    expect(OtpVerifyBody.safeParse({ challengeId: 'c', code: '12345' }).success).toBe(false);
    expect(OtpVerifyBody.safeParse({ challengeId: 'c', code: '12345a' }).success).toBe(false);
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

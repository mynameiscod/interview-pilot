import { describe, expect, it } from 'vitest';
import { CandidateSearchQuery, SuspendCandidateBody } from './admin.js';
import { isMfaChallenge, MfaVerifyBody, type AdminSignInResponse } from './auth.js';
import { hasPermission } from './permissions.js';
import { DeleteAccountBody } from './privacy.js';

describe('data rights contracts', () => {
  it('accepts deletion with a code or the typed confirmation only', () => {
    expect(
      DeleteAccountBody.safeParse({ method: 'OTP', challengeId: 'c1', code: '123456' }).success,
    ).toBe(true);
    expect(DeleteAccountBody.safeParse({ method: 'TYPED', confirmText: 'DELETE' }).success).toBe(
      true,
    );
    expect(DeleteAccountBody.safeParse({ method: 'TYPED', confirmText: 'delete' }).success).toBe(
      false,
    );
    expect(DeleteAccountBody.safeParse({ method: 'OTP', challengeId: 'c1' }).success).toBe(false);
    expect(DeleteAccountBody.safeParse({}).success).toBe(false);
  });
});

describe('admin two-factor contracts', () => {
  const token = 'x'.repeat(43);

  it('needs exactly one of an authenticator code or a recovery code', () => {
    expect(MfaVerifyBody.safeParse({ mfaToken: token, code: '123456' }).success).toBe(true);
    expect(MfaVerifyBody.safeParse({ mfaToken: token, recoveryCode: 'abcd-efgh-ij' }).success).toBe(
      true,
    );
    expect(MfaVerifyBody.safeParse({ mfaToken: token }).success).toBe(false);
    expect(
      MfaVerifyBody.safeParse({ mfaToken: token, code: '123456', recoveryCode: 'abcd-efgh-ij' })
        .success,
    ).toBe(false);
    expect(MfaVerifyBody.safeParse({ mfaToken: token, code: '12345' }).success).toBe(false);
  });

  it('tells a second-factor challenge apart from a session', () => {
    const challenge: AdminSignInResponse = {
      mfaRequired: true,
      mfaToken: token,
      mode: 'VERIFY',
      enrollment: null,
      expiresAt: new Date().toISOString(),
    };
    expect(isMfaChallenge(challenge)).toBe(true);
    expect(
      isMfaChallenge({
        accessToken: 't',
        accessTokenExpiresAt: new Date().toISOString(),
      } as AdminSignInResponse),
    ).toBe(false);
  });
});

describe('candidates console contracts', () => {
  it('defaults the search and requires a suspension reason', () => {
    expect(CandidateSearchQuery.parse({})).toMatchObject({ q: '', limit: 25 });
    expect(SuspendCandidateBody.safeParse({ reason: 'x' }).success).toBe(false);
    expect(SuspendCandidateBody.safeParse({ reason: 'Abusive uploads' }).success).toBe(true);
  });

  it('lets support read candidates but not suspend them', () => {
    expect(hasPermission(['SUPPORT_ADMIN'], 'candidates.read')).toBe(true);
    expect(hasPermission(['SUPPORT_ADMIN'], 'candidates.manage')).toBe(false);
    expect(hasPermission(['OPERATIONS_ADMIN'], 'candidates.manage')).toBe(true);
  });
});

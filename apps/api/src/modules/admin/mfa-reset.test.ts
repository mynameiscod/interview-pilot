import { describe, expect, it } from 'vitest';
import { parseResetArgs } from './mfa-reset.js';

describe('reset-admin-mfa CLI arguments', () => {
  it('normalises the emails and requires a reason', () => {
    expect(
      parseResetArgs({
        email: ' Ravi@CodeBegun.com ',
        operator: 'ops@codebegun.com',
        reason: ' Lost phone ',
      }),
    ).toEqual({
      targetEmail: 'ravi@codebegun.com',
      operatorEmail: 'ops@codebegun.com',
      reason: 'Lost phone',
    });
  });

  it('says what is missing or wrong', () => {
    expect(parseResetArgs({ operator: 'a@b.co', reason: 'why' })).toEqual({
      error: 'Provide --email <admin whose 2FA to reset>',
    });
    expect(parseResetArgs({ email: 'x@b.co', reason: 'why' })).toMatchObject({
      error: expect.stringContaining('--operator'),
    });
    expect(parseResetArgs({ email: 'x@b.co', operator: 'a@b.co', reason: 'no' })).toMatchObject({
      error: expect.stringContaining('--reason'),
    });
    // Your own 2FA is managed on the account page.
    expect(parseResetArgs({ email: 'a@b.co', operator: 'A@b.co', reason: 'why' })).toMatchObject({
      error: expect.stringContaining('account page'),
    });
  });
});

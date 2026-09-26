import { describe, expect, it } from 'vitest';
import { hashPassword, passwordProblem, verifyAgainstDummy, verifyPassword } from './password.js';

describe('admin passwords', () => {
  it('hashes with a random salt and verifies', async () => {
    const a = await hashPassword('correct horse battery');
    const b = await hashPassword('correct horse battery');
    expect(a).toMatch(/^scrypt\$32768\$8\$1\$/);
    expect(a).not.toBe(b);
    expect(await verifyPassword('correct horse battery', a)).toBe(true);
    expect(await verifyPassword('correct horse batterx', a)).toBe(false);
    expect(await verifyPassword('anything', 'not-a-hash')).toBe(false);
    expect(await verifyAgainstDummy('anything')).toBe(false);
  });

  it('rejects weak passwords', () => {
    expect(passwordProblem('short')).toMatch(/12 characters/);
    expect(passwordProblem('aaaaaaaaaaaaaaa')).toMatch(/repetitive/);
    expect(passwordProblem('codebegun-2026-admin', 'codebegun@gmail.com')).toMatch(/email/);
    expect(passwordProblem('Blue-Tiger-Runs-42')).toBeNull();
  });
});

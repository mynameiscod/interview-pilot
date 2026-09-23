import { describe, expect, it } from 'vitest';
import {
  AdminRole,
  hasPermission,
  Permission,
  permissionsFor,
  ROLE_PERMISSIONS,
} from './permissions.js';

describe('admin permission matrix', () => {
  it('defines an entry for every role', () => {
    expect(Object.keys(ROLE_PERMISSIONS).sort()).toEqual([...AdminRole.options].sort());
  });

  it('grants SUPER_ADMIN every permission', () => {
    expect(permissionsFor(['SUPER_ADMIN'])).toEqual(new Set(Permission.options));
  });

  it('reserves admin management to SUPER_ADMIN', () => {
    for (const role of AdminRole.options.filter((r) => r !== 'SUPER_ADMIN')) {
      expect(hasPermission([role], 'admin_users.manage')).toBe(false);
    }
  });

  it('unions permissions across roles', () => {
    const perms = permissionsFor(['SUPPORT_ADMIN', 'FINANCE_ADMIN']);
    expect(perms.has('candidates.read')).toBe(true);
    expect(perms.has('audit.read')).toBe(true);
    expect(perms.has('admin_users.manage')).toBe(false);
  });

  it('grants nothing with no roles', () => {
    expect(permissionsFor([]).size).toBe(0);
  });
});

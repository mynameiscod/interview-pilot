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

  it('reserves AI provider secrets and routing to SUPER_ADMIN', () => {
    for (const role of AdminRole.options.filter((r) => r !== 'SUPER_ADMIN')) {
      expect(hasPermission([role], 'ai.manage')).toBe(false);
    }
  });

  it('lets finance see AI cost without seeing provider configuration', () => {
    expect(hasPermission(['FINANCE_ADMIN'], 'ai_usage.read')).toBe(true);
    expect(hasPermission(['FINANCE_ADMIN'], 'ai.read')).toBe(false);
  });

  it('lets content admins manage prompts', () => {
    expect(hasPermission(['CONTENT_ADMIN'], 'prompts.manage')).toBe(true);
    expect(hasPermission(['OPERATIONS_ADMIN'], 'prompts.manage')).toBe(false);
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

import { z } from 'zod';

export const AdminRole = z.enum([
  'SUPER_ADMIN',
  'OPERATIONS_ADMIN',
  'CONTENT_ADMIN',
  'SUPPORT_ADMIN',
  'FINANCE_ADMIN',
]);
export type AdminRole = z.infer<typeof AdminRole>;

/**
 * Fine-grained admin permissions. Endpoints check permissions, never role
 * names, so the role matrix can change without touching route code.
 * Permissions are added as each phase delivers its module.
 */
export const Permission = z.enum([
  'admin_users.read',
  'admin_users.manage',
  'audit.read',
  'candidates.read',
  // AI provider layer (Phase 2)
  'ai.read',
  'ai.manage',
  'ai_usage.read',
  'prompts.read',
  'prompts.manage',
  // Interview library: roles, blueprints, companies, templates (Phase 3)
  'library.read',
  'library.manage',
  // Interview operations: re-run evaluation (Phase 5)
  'interviews.manage',
  // Plans, coupons, purchases, payments and refunds (Phase 6)
  'payments.read',
  'payments.manage',
]);
export type Permission = z.infer<typeof Permission>;

export const ROLE_PERMISSIONS: Readonly<Record<AdminRole, readonly Permission[]>> = {
  SUPER_ADMIN: Permission.options,
  OPERATIONS_ADMIN: [
    'admin_users.read',
    'audit.read',
    'candidates.read',
    'ai.read',
    'ai_usage.read',
    'prompts.read',
    'library.read',
    'library.manage',
    'interviews.manage',
  ],
  CONTENT_ADMIN: ['prompts.read', 'prompts.manage', 'library.read', 'library.manage'],
  SUPPORT_ADMIN: ['candidates.read', 'payments.read'],
  FINANCE_ADMIN: ['audit.read', 'ai_usage.read', 'payments.read', 'payments.manage'],
};

export function permissionsFor(roles: readonly AdminRole[]): Set<Permission> {
  return new Set(roles.flatMap((role) => ROLE_PERMISSIONS[role]));
}

export function hasPermission(roles: readonly AdminRole[], permission: Permission): boolean {
  return roles.some((role) => ROLE_PERMISSIONS[role].includes(permission));
}

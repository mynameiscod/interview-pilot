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
]);
export type Permission = z.infer<typeof Permission>;

export const ROLE_PERMISSIONS: Readonly<Record<AdminRole, readonly Permission[]>> = {
  SUPER_ADMIN: Permission.options,
  OPERATIONS_ADMIN: ['admin_users.read', 'audit.read', 'candidates.read'],
  CONTENT_ADMIN: [],
  SUPPORT_ADMIN: ['candidates.read'],
  FINANCE_ADMIN: ['audit.read'],
};

export function permissionsFor(roles: readonly AdminRole[]): Set<Permission> {
  return new Set(roles.flatMap((role) => ROLE_PERMISSIONS[role]));
}

export function hasPermission(roles: readonly AdminRole[], permission: Permission): boolean {
  return roles.some((role) => ROLE_PERMISSIONS[role].includes(permission));
}

import { z } from 'zod';
import { AdminRole, Permission } from './permissions.js';
import { MeResponse, UserStatus } from './users.js';

export const AdminUserSummary = z.object({
  id: z.string(),
  email: z.email().nullable(),
  displayName: z.string().nullable(),
  roles: z.array(AdminRole),
  status: UserStatus,
  emailVerified: z.boolean(),
  lastLoginAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
});
export type AdminUserSummary = z.infer<typeof AdminUserSummary>;

const roleList = z
  .array(AdminRole)
  .min(1, 'Choose at least one role')
  .transform((roles) => [...new Set(roles)]);

export const InviteAdminBody = z.object({
  email: z.email().trim().toLowerCase(),
  roles: roleList,
});
export type InviteAdminBody = z.infer<typeof InviteAdminBody>;

export const UpdateAdminRolesBody = z.object({
  roles: roleList,
  reason: z.string().trim().min(3).max(300),
});
export type UpdateAdminRolesBody = z.infer<typeof UpdateAdminRolesBody>;

/**
 * Removes all admin roles and ends the person's admin sessions. Their
 * candidate account (if any) is unaffected; account suspension belongs to the
 * Candidates module.
 */
export const RevokeAdminAccessBody = z.object({
  reason: z.string().trim().min(3).max(300),
});
export type RevokeAdminAccessBody = z.infer<typeof RevokeAdminAccessBody>;

export const InviteAdminResponse = z.object({
  admin: AdminUserSummary,
  inviteEmailSent: z.boolean(),
});
export type InviteAdminResponse = z.infer<typeof InviteAdminResponse>;

export const AuditActorType = z.enum(['USER', 'ADMIN', 'SYSTEM', 'ANONYMOUS']);
export type AuditActorType = z.infer<typeof AuditActorType>;

export const AuditLogEntry = z.object({
  id: z.string(),
  at: z.iso.datetime(),
  actorType: AuditActorType,
  actorId: z.string().nullable(),
  action: z.string(),
  resourceType: z.string().nullable(),
  resourceId: z.string().nullable(),
  outcome: z.enum(['SUCCESS', 'FAILURE']),
  requestId: z.string().nullable(),
  details: z.record(z.string(), z.unknown()).nullable(),
});
export type AuditLogEntry = z.infer<typeof AuditLogEntry>;

export const AuditLogQuery = z.object({
  action: z.string().max(80).optional(),
  actorId: z.string().max(64).optional(),
  resourceId: z.string().max(64).optional(),
  /** Cursor: return entries older than this entry id. */
  before: z.string().max(64).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export type AuditLogQuery = z.infer<typeof AuditLogQuery>;

export const AuditLogPage = z.object({
  items: z.array(AuditLogEntry),
  nextCursor: z.string().nullable(),
});
export type AuditLogPage = z.infer<typeof AuditLogPage>;

export const AdminMeResponse = MeResponse.extend({
  permissions: z.array(Permission),
});
export type AdminMeResponse = z.infer<typeof AdminMeResponse>;

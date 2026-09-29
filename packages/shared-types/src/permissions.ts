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
  /** Download the audit log as CSV (SUPER_ADMIN only; each export is audited). */
  'audit.export',
  'candidates.read',
  /** Suspend and reinstate candidate accounts. */
  'candidates.manage',
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
  // Grant or deduct a candidate's credits by hand (audited, with a reason)
  'credits.adjust',
  // Recordings and integrity observations; consent texts (Phase 8)
  'media.read',
  'media.manage',
  'consent.read',
  'consent.manage',
  // Campaigns, results and manual review (Phase 10)
  'campaigns.read',
  'campaigns.manage',
  'interviews.read',
  'interviews.review',
  // Analytics, costs and operations (Phase 11)
  'analytics.read',
  'system.read',
  'system.manage',
  'queues.manage',
  // Employer and college organisations (self-serve portal)
  /** List and view organisations, their members and wallets. */
  'orgs.read',
  /** Create organisations, invite their owners, change seats, quotas and wallets. */
  'orgs.manage',
]);
export type Permission = z.infer<typeof Permission>;

export const ROLE_PERMISSIONS: Readonly<Record<AdminRole, readonly Permission[]>> = {
  SUPER_ADMIN: Permission.options,
  OPERATIONS_ADMIN: [
    'admin_users.read',
    'audit.read',
    'candidates.read',
    'candidates.manage',
    'ai.read',
    'ai_usage.read',
    'prompts.read',
    'library.read',
    'library.manage',
    'interviews.manage',
    'media.read',
    'media.manage',
    'consent.read',
    'campaigns.read',
    'campaigns.manage',
    'interviews.read',
    'interviews.review',
    'analytics.read',
    'system.read',
    'queues.manage',
    'orgs.read',
  ],
  CONTENT_ADMIN: [
    'prompts.read',
    'prompts.manage',
    'library.read',
    'library.manage',
    'consent.read',
  ],
  SUPPORT_ADMIN: [
    'candidates.read',
    'payments.read',
    'campaigns.read',
    'interviews.read',
    'orgs.read',
  ],
  FINANCE_ADMIN: [
    'audit.read',
    'ai_usage.read',
    'payments.read',
    'payments.manage',
    'credits.adjust',
    'analytics.read',
  ],
};

export function permissionsFor(roles: readonly AdminRole[]): Set<Permission> {
  return new Set(roles.flatMap((role) => ROLE_PERMISSIONS[role]));
}

export function hasPermission(roles: readonly AdminRole[], permission: Permission): boolean {
  return roles.some((role) => ROLE_PERMISSIONS[role].includes(permission));
}

// ---- Organisation (employer / college) portal ---------------------------------------------------

/**
 * Roles of an organisation member in the org portal. They are separate from
 * CodeBegun admin roles: an org token never opens admin routes, and org
 * endpoints check org permissions, never role names.
 */
export const OrgRole = z.enum(['ORG_OWNER', 'ORG_RECRUITER', 'ORG_VIEWER']);
export type OrgRole = z.infer<typeof OrgRole>;

export const OrgPermission = z.enum([
  /** Campaigns, results, pipeline, analytics (the organisation's own only). */
  'org.read',
  /** Create and change campaigns, send and revoke invites. */
  'org.campaigns.manage',
  /** Move candidates between pipeline stages; verify identity captures. */
  'org.pipeline.manage',
  /** Notes and scorecards. */
  'org.review',
  /** CSV exports of results and cohort reports (personal data; audited). */
  'org.export',
  /** Invite, change and remove members. */
  'org.members.manage',
  /** Webhooks and API keys. */
  'org.integrations.manage',
]);
export type OrgPermission = z.infer<typeof OrgPermission>;

export const ORG_ROLE_PERMISSIONS: Readonly<Record<OrgRole, readonly OrgPermission[]>> = {
  ORG_OWNER: OrgPermission.options,
  ORG_RECRUITER: [
    'org.read',
    'org.campaigns.manage',
    'org.pipeline.manage',
    'org.review',
    'org.export',
  ],
  ORG_VIEWER: ['org.read', 'org.review'],
};

export function orgPermissionsFor(role: OrgRole): OrgPermission[] {
  return [...ORG_ROLE_PERMISSIONS[role]];
}

export function hasOrgPermission(role: OrgRole, permission: OrgPermission): boolean {
  return ORG_ROLE_PERMISSIONS[role].includes(permission);
}

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
  /** Two-factor authentication (TOTP) is on. */
  mfaEnabled: z.boolean(),
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

/**
 * A super admin resets another admin's 2FA (lost phone and recovery codes):
 * confirmed with the acting super admin's own authenticator code.
 */
export const ResetAdminMfaBody = z.object({
  code: z
    .string()
    .trim()
    .regex(/^\d{6}$/, 'Enter the 6-digit code'),
  reason: z.string().trim().min(3).max(300),
});
export type ResetAdminMfaBody = z.infer<typeof ResetAdminMfaBody>;

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

const auditLogFilters = z.object({
  action: z.string().max(80).optional(),
  actorId: z.string().max(64).optional(),
  resourceId: z.string().max(64).optional(),
  /** Entries at or after this instant (ISO 8601 with offset). */
  from: z.iso.datetime({ offset: true }).optional(),
  /** Entries before this instant (exclusive). */
  to: z.iso.datetime({ offset: true }).optional(),
});

const fromBeforeTo = (q: { from?: string; to?: string }) =>
  !q.from || !q.to || Date.parse(q.from) < Date.parse(q.to);
const RANGE_MESSAGE = { message: '`from` must be before `to`', path: ['to'] };

export const AuditLogQuery = auditLogFilters
  .extend({
    /** Cursor: return entries older than this entry id. */
    before: z.string().max(64).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .refine(fromBeforeTo, RANGE_MESSAGE);
export type AuditLogQuery = z.infer<typeof AuditLogQuery>;

/** `GET /admin/audit-logs/export.csv`: the same filters, every matching entry (newest first). */
export const AuditLogExportQuery = auditLogFilters.refine(fromBeforeTo, RANGE_MESSAGE);
export type AuditLogExportQuery = z.infer<typeof AuditLogExportQuery>;

export const AuditLogPage = z.object({
  items: z.array(AuditLogEntry),
  nextCursor: z.string().nullable(),
});
export type AuditLogPage = z.infer<typeof AuditLogPage>;

export const AdminMeResponse = MeResponse.extend({
  permissions: z.array(Permission),
  /** Whether this admin can sign in with a password (set on the server or in the console). */
  hasPassword: z.boolean().optional(),
  /** Whether an authenticator app (TOTP) is set up for this admin. */
  mfaEnabled: z.boolean().optional(),
});
export type AdminMeResponse = z.infer<typeof AdminMeResponse>;

// ---- Candidates console (support) ------------------------------------------

export const CandidateSearchQuery = z.object({
  /** Email, mobile number or (part of) a name. Empty lists the newest candidates. */
  q: z.string().trim().max(120).default(''),
  status: UserStatus.optional(),
  /** Cursor: candidates created before this user id. */
  before: z.string().max(64).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(25),
});
export type CandidateSearchQuery = z.infer<typeof CandidateSearchQuery>;

export const CandidateListItem = z.object({
  id: z.string(),
  displayName: z.string().nullable(),
  email: z.string().nullable(),
  mobile: z.string().nullable(),
  status: UserStatus,
  lastLoginAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
});
export type CandidateListItem = z.infer<typeof CandidateListItem>;

export const CandidatePage = z.object({
  items: z.array(CandidateListItem),
  nextCursor: z.string().nullable(),
});
export type CandidatePage = z.infer<typeof CandidatePage>;

export const CandidateDetail = z.object({
  candidate: CandidateListItem.extend({
    experienceLevel: z.string().nullable(),
    currentRole: z.string().nullable(),
    preferredInterviewLanguage: z.string(),
    productUpdatesOptIn: z.boolean(),
    identities: z.array(z.object({ provider: z.string(), display: z.string() })),
    /** Set while an account deletion is pending. */
    deletionScheduledFor: z.iso.datetime().nullable(),
    suspension: z
      .object({ at: z.iso.datetime(), reason: z.string(), by: z.string().nullable() })
      .nullable(),
  }),
  credits: z.object({ available: z.number().int(), reserved: z.number().int() }),
  interviews: z.array(
    z.object({
      id: z.string(),
      state: z.string(),
      mode: z.string().nullable(),
      roleTitle: z.string().nullable(),
      campaign: z.string().nullable(),
      createdAt: z.iso.datetime(),
    }),
  ),
  purchases: z.array(
    z.object({
      id: z.string(),
      planName: z.string().nullable(),
      status: z.string(),
      amountPaise: z.number().int().nullable(),
      createdAt: z.iso.datetime(),
    }),
  ),
  consents: z.array(
    z.object({
      type: z.string(),
      accepted: z.boolean(),
      version: z.number().int().nullable(),
      at: z.iso.datetime(),
    }),
  ),
});
export type CandidateDetail = z.infer<typeof CandidateDetail>;

/** Suspending ends every session at once; the reason is audited and shown to other admins. */
export const SuspendCandidateBody = z.object({
  reason: z.string().trim().min(3).max(300),
});
export type SuspendCandidateBody = z.infer<typeof SuspendCandidateBody>;

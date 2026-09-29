import { normalizeEmail } from '@cbi/auth-core';
import { AuditLogModel, AuthIdentityModel, RefreshTokenModel, UserModel } from '@cbi/db';
import type { ClientSession, Types } from 'mongoose';
import { transaction } from '../../lib/transaction.js';

/**
 * Operator 2FA reset, shared by the super-admin action (admin-users service)
 * and the CLI (scripts/reset-admin-mfa.ts): removes an admin's TOTP factor
 * and recovery codes, and signs them out everywhere (refresh families
 * revoked, tokenVersion bumped), so their next sign-in sets up a new
 * authenticator. Returns the revoked session ids, or null when the admin has
 * no 2FA to reset.
 */
export async function clearAdminMfa(
  targetId: Types.ObjectId | string,
  session?: ClientSession,
): Promise<string[] | null> {
  const opts = session ? { session } : {};
  const cleared = await UserModel.updateOne(
    { _id: targetId, 'adminRoles.0': { $exists: true }, 'mfa.enabledAt': { $ne: null } },
    { $unset: { mfa: '' }, $inc: { tokenVersion: 1 } },
    opts,
  );
  if (cleared.modifiedCount === 0) return null;
  const live = { userId: targetId, revokedAt: { $exists: false } };
  const families: string[] = await RefreshTokenModel.distinct('familyId', live, opts);
  await RefreshTokenModel.updateMany(
    live,
    { $set: { revokedAt: new Date(), revokedReason: 'MFA_RESET' } },
    opts,
  );
  return families;
}

export interface CliResetInput {
  /** The admin whose 2FA is reset. */
  targetEmail: string;
  /** The super admin running the command (recorded in the audit log). */
  operatorEmail: string;
  reason: string;
}

export type CliResetResult =
  { ok: true; targetId: string; sessionsEnded: number } | { ok: false; error: string };

/** Parses the CLI's flags; returns the input or what is missing. */
export function parseResetArgs(values: {
  email?: string;
  operator?: string;
  reason?: string;
}): CliResetInput | { error: string } {
  const targetEmail = normalizeEmail(values.email ?? '');
  const operatorEmail = normalizeEmail(values.operator ?? '');
  const reason = (values.reason ?? '').trim();
  if (!targetEmail) return { error: 'Provide --email <admin whose 2FA to reset>' };
  if (!operatorEmail) return { error: 'Provide --operator <your super admin email>' };
  if (reason.length < 3 || reason.length > 300) {
    return { error: 'Provide --reason "<why>" (3 to 300 characters)' };
  }
  if (targetEmail === operatorEmail) {
    return { error: 'Reset your own 2FA from the admin account page, not with this command.' };
  }
  return { targetEmail, operatorEmail, reason };
}

async function userByEmail(email: string) {
  const identity = await AuthIdentityModel.findOne({ provider: 'EMAIL', subject: email }).lean();
  return identity
    ? UserModel.findById(identity.userId).lean()
    : UserModel.findOne({ primaryEmail: email }).lean();
}

/**
 * The CLI reset (scripts/reset-admin-mfa.ts), for when no super admin can use
 * the console action: the operator must be an active super admin; the reset
 * and its audit entry (`admin.mfa_reset`, actor SYSTEM, via `cli`, with the
 * operator) are written in one transaction.
 */
export async function resetAdminMfaFromCli(input: CliResetInput): Promise<CliResetResult> {
  const operator = await userByEmail(input.operatorEmail);
  if (!operator || operator.status !== 'ACTIVE' || !operator.adminRoles.includes('SUPER_ADMIN')) {
    return { ok: false, error: `${input.operatorEmail} is not an active super admin.` };
  }
  const target = await userByEmail(input.targetEmail);
  if (!target || target.adminRoles.length === 0) {
    return { ok: false, error: `${input.targetEmail} is not an admin.` };
  }
  if (String(target._id) === String(operator._id)) {
    return { ok: false, error: 'Reset your own 2FA from the admin account page.' };
  }
  const targetId = String(target._id);
  const families = await transaction(async (session) => {
    const revoked = await clearAdminMfa(targetId, session);
    if (revoked === null) return null;
    await AuditLogModel.create(
      [
        {
          actorType: 'SYSTEM',
          action: 'admin.mfa_reset',
          resourceType: 'user',
          resourceId: targetId,
          outcome: 'SUCCESS',
          details: {
            via: 'cli',
            operatorId: String(operator._id),
            operatorEmail: input.operatorEmail,
            reason: input.reason,
            sessionsEnded: revoked.length,
          },
        },
      ],
      { session },
    );
    return revoked;
  });
  if (families === null) {
    return { ok: false, error: `${input.targetEmail} does not have two-factor authentication on.` };
  }
  return { ok: true, targetId, sessionsEnded: families.length };
}

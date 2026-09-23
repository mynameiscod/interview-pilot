import type { Logger } from '@cbi/config';
import { mongoose, UserModel, UserProfileModel } from '@cbi/db';
import type { EmailProvider } from '@cbi/provider-adapters';
import type {
  AdminRole,
  AdminUserSummary,
  InviteAdminResponse,
  UserStatus,
} from '@cbi/shared-types';
import type { ClientSession, Types } from 'mongoose';
import type { AuditService } from '../../lib/audit.js';
import { AppError } from '../../lib/errors.js';
import type { ClientContext } from '../../lib/request-context.js';
import type { AccountService } from '../auth/account.service.js';
import { adminInviteEmail } from '../auth/messages.js';
import type { SessionService } from '../auth/session.service.js';
import type { UserStateCache } from '../auth/user-state.js';

interface Deps {
  accounts: AccountService;
  sessions: SessionService;
  userState: UserStateCache;
  audit: AuditService;
  email: EmailProvider;
  logger: Logger;
  adminUrl: string;
}

interface UserLike {
  _id: Types.ObjectId;
  primaryEmail?: string | null;
  emailVerifiedAt?: Date | null;
  adminRoles: string[];
  status: string;
  lastLoginAt?: Date | null;
  createdAt: Date;
}

function toSummary(user: UserLike, displayName: string | null): AdminUserSummary {
  return {
    id: String(user._id),
    email: user.primaryEmail ?? null,
    displayName,
    roles: user.adminRoles as AdminRole[],
    status: user.status as UserStatus,
    emailVerified: Boolean(user.emailVerifiedAt),
    lastLoginAt: user.lastLoginAt?.toISOString() ?? null,
    createdAt: user.createdAt.toISOString(),
  };
}

async function transaction<T>(fn: (session: ClientSession) => Promise<T>): Promise<T> {
  const session = await mongoose.startSession();
  try {
    let result!: T;
    await session.withTransaction(async () => {
      result = await fn(session);
    });
    return result;
  } finally {
    await session.endSession();
  }
}

/**
 * Staff account management. Every mutation is audited inside the same
 * transaction, and the platform always keeps at least one active SUPER_ADMIN.
 */
export function createAdminUserService(deps: Deps) {
  async function displayNameOf(userId: Types.ObjectId) {
    const profile = await UserProfileModel.findOne({ userId }, { displayName: 1 }).lean();
    return profile?.displayName ?? null;
  }

  async function assertAnotherSuperAdmin(excludingId: string, session: ClientSession) {
    const others = await UserModel.countDocuments(
      { _id: { $ne: excludingId }, adminRoles: 'SUPER_ADMIN', status: 'ACTIVE' },
      { session },
    );
    if (others === 0) {
      throw AppError.conflict('At least one active super admin must remain.');
    }
  }

  return {
    async list(): Promise<AdminUserSummary[]> {
      const users = await UserModel.find({ 'adminRoles.0': { $exists: true } })
        .sort({ createdAt: 1 })
        .lean();
      const profiles = await UserProfileModel.find(
        { userId: { $in: users.map((u) => u._id) } },
        { userId: 1, displayName: 1 },
      ).lean();
      const names = new Map(profiles.map((p) => [String(p.userId), p.displayName ?? null]));
      return users.map((u) => toSummary(u, names.get(String(u._id)) ?? null));
    },

    async invite(
      input: { email: string; roles: AdminRole[] },
      actorId: string,
      ctx: ClientContext,
    ): Promise<InviteAdminResponse> {
      const user = await transaction(async (session) => {
        let target = await deps.accounts.findUserByContact('EMAIL', input.email, session);
        if (target && target.adminRoles.length > 0) {
          throw AppError.conflict('This person already has admin access.');
        }
        if (target) {
          target.adminRoles = input.roles;
          target.invitedBy = new mongoose.Types.ObjectId(actorId);
          await target.save({ session });
        } else {
          target = new UserModel({
            primaryEmail: input.email,
            adminRoles: input.roles,
            invitedBy: actorId,
          });
          await target.save({ session });
          await UserProfileModel.create([{ userId: target._id }], { session });
        }
        await deps.audit.record(
          {
            actorType: 'ADMIN',
            actorId,
            action: 'admin.user_invited',
            resourceType: 'user',
            resourceId: String(target!._id),
            details: { roles: input.roles },
          },
          ctx,
          session,
        );
        return target!;
      });
      await deps.userState.invalidate(String(user._id));

      let inviteEmailSent = true;
      try {
        await deps.email.send(adminInviteEmail(input.email, deps.adminUrl, input.roles));
      } catch (err) {
        inviteEmailSent = false;
        deps.logger.warn({ err, userId: String(user._id) }, 'admin invite email failed');
      }
      return {
        admin: toSummary(user.toObject(), await displayNameOf(user._id)),
        inviteEmailSent,
      };
    },

    async updateRoles(
      targetId: string,
      input: { roles: AdminRole[]; reason: string },
      actorId: string,
      ctx: ClientContext,
    ): Promise<AdminUserSummary> {
      if (!mongoose.isValidObjectId(targetId)) throw AppError.notFound('Admin not found');
      const user = await transaction(async (session) => {
        const target = await UserModel.findById(targetId, null, { session });
        if (!target || target.adminRoles.length === 0) throw AppError.notFound('Admin not found');
        const before = [...target.adminRoles] as AdminRole[];
        const losingSuper = before.includes('SUPER_ADMIN') && !input.roles.includes('SUPER_ADMIN');
        if (losingSuper && targetId === actorId) {
          throw AppError.conflict('You cannot remove your own super admin role.');
        }
        if (losingSuper) await assertAnotherSuperAdmin(targetId, session);
        target.adminRoles = input.roles;
        await target.save({ session });
        await deps.audit.record(
          {
            actorType: 'ADMIN',
            actorId,
            action: 'admin.user_roles_changed',
            resourceType: 'user',
            resourceId: targetId,
            details: { before, after: input.roles, reason: input.reason },
          },
          ctx,
          session,
        );
        return target;
      });
      await deps.userState.invalidate(targetId);
      return toSummary(user.toObject(), await displayNameOf(user._id));
    },

    async revokeAccess(
      targetId: string,
      reason: string,
      actorId: string,
      ctx: ClientContext,
    ): Promise<void> {
      if (!mongoose.isValidObjectId(targetId)) throw AppError.notFound('Admin not found');
      if (targetId === actorId) throw AppError.conflict('You cannot revoke your own admin access.');
      await transaction(async (session) => {
        const target = await UserModel.findById(targetId, null, { session });
        if (!target || target.adminRoles.length === 0) throw AppError.notFound('Admin not found');
        const before = [...target.adminRoles];
        if (before.includes('SUPER_ADMIN')) await assertAnotherSuperAdmin(targetId, session);
        target.adminRoles = [];
        await target.save({ session });
        await deps.sessions.revokeAll(targetId, 'ROLE_CHANGE', { audience: 'admin', session });
        await deps.audit.record(
          {
            actorType: 'ADMIN',
            actorId,
            action: 'admin.user_access_revoked',
            resourceType: 'user',
            resourceId: targetId,
            details: { before, reason },
          },
          ctx,
          session,
        );
      });
      await deps.userState.invalidate(targetId);
    },
  };
}

export type AdminUserService = ReturnType<typeof createAdminUserService>;

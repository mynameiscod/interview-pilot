import type { Redis } from '@cbi/db';
import { OrgMemberModel, OrgModel, UserModel } from '@cbi/db';
import type { AdminRole, OrgRole, OrgStatus, UserStatus } from '@cbi/shared-types';

/** Authorization-relevant user state, checked on every authenticated request. */
export interface UserState {
  status: UserStatus;
  tokenVersion: number;
  adminRoles: AdminRole[];
  /** The live org membership (INVITED or ACTIVE) and its organisation's status, if any. */
  org?: { orgId: string; role: OrgRole; orgStatus: OrgStatus } | null;
}

export interface UserStateCache {
  get(userId: string): Promise<UserState | null>;
  invalidate(userId: string): Promise<void>;
}

/**
 * Read-through cache (Redis → MongoDB). MongoDB is the source of truth; every
 * write path that changes status, roles, tokenVersion or an org membership
 * (or an organisation's status) calls `invalidate`, so changes apply
 * immediately. If Redis is unavailable, reads fall back to MongoDB.
 */
export function createUserStateCache(redis: Redis, ttlSec = 60): UserStateCache {
  const key = (userId: string) => `cbi:user-state:${userId}`;

  return {
    async get(userId) {
      try {
        const cached = await redis.get(key(userId));
        if (cached) return JSON.parse(cached) as UserState;
      } catch {
        // Redis down: fall through to MongoDB.
      }
      const [user, member] = await Promise.all([
        UserModel.findById(userId, { status: 1, tokenVersion: 1, adminRoles: 1 }).lean(),
        OrgMemberModel.findOne(
          { userId, status: { $in: ['INVITED', 'ACTIVE'] } },
          { orgId: 1, role: 1 },
        ).lean(),
      ]);
      if (!user) return null;
      const org = member ? await OrgModel.findById(member.orgId, { status: 1 }).lean() : null;
      const state: UserState = {
        status: user.status as UserStatus,
        tokenVersion: user.tokenVersion,
        adminRoles: user.adminRoles as AdminRole[],
        org:
          member && org
            ? { orgId: String(member.orgId), role: member.role, orgStatus: org.status }
            : null,
      };
      redis.set(key(userId), JSON.stringify(state), 'EX', ttlSec).catch(() => undefined);
      return state;
    },
    async invalidate(userId) {
      await redis.del(key(userId)).catch(() => undefined);
    },
  };
}

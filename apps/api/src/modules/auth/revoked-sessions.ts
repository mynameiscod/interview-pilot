import type { Logger } from '@cbi/config';
import type { Redis } from '@cbi/db';

/**
 * Sessions (refresh-token families) signed out before their access tokens
 * expire. Signing one device out revokes its refresh tokens, but an access
 * token already issued would stay valid until it expires (JWT_ACCESS_TTL_SEC);
 * each revoked session id is kept in Redis for that long (plus clock skew),
 * and `authenticate` and the Socket.IO handshake refuse its tokens.
 *
 * One key per session (`cbi:revoked-session:<id>`), so each expires on its
 * own. If Redis is unreachable the check lets the request through (logged):
 * refresh-token revocation still ends the session within one access-token
 * lifetime, as before this check existed.
 */
export interface RevokedSessions {
  revoke(sessionIds: readonly string[]): Promise<void>;
  isRevoked(sessionId: string): Promise<boolean>;
}

/** Extra seconds kept beyond the access-token lifetime (clock skew between servers). */
const SKEW_SEC = 60;

export function createRevokedSessions(
  redis: Redis,
  accessTtlSec: number,
  logger?: Logger,
): RevokedSessions {
  const key = (id: string) => `cbi:revoked-session:${id}`;
  const ttl = accessTtlSec + SKEW_SEC;
  return {
    async revoke(sessionIds) {
      const unique = [...new Set(sessionIds)];
      if (unique.length === 0) return;
      const tx = redis.multi();
      for (const id of unique) tx.set(key(id), '1', 'EX', ttl);
      try {
        await tx.exec();
      } catch (err) {
        logger?.warn({ err, count: unique.length }, 'revoked sessions not recorded');
      }
    },
    async isRevoked(sessionId) {
      try {
        return (await redis.exists(key(sessionId))) === 1;
      } catch (err) {
        logger?.warn({ err }, 'revoked-session check skipped (Redis unavailable)');
        return false;
      }
    },
  };
}

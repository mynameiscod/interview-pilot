import type { AdminRole, SessionAudience } from '@cbi/shared-types';

export interface AuthContext {
  userId: string;
  audience: SessionAudience;
  /** Refresh-token family (one per signed-in device). */
  sessionId: string;
  /** Current roles from the user record (not the token), so revocation is immediate. */
  adminRoles: AdminRole[];
}

declare global {
  namespace Express {
    interface Request {
      auth?: AuthContext;
    }
  }
}

import type { AdminRole, OrgRole, SessionAudience } from '@cbi/shared-types';

export interface AuthContext {
  userId: string;
  audience: SessionAudience;
  /** Refresh-token family (one per signed-in device). */
  sessionId: string;
  /** Current roles from the user record (not the token), so revocation is immediate. */
  adminRoles: AdminRole[];
  /** Org sessions only: the member's organisation and role (live, from the membership). */
  org?: { orgId: string; role: OrgRole };
}

/** A request authenticated with an org API key (ATS integrations). */
export interface ApiKeyContext {
  id: string;
  orgId: string;
  scopes: string[];
}

declare global {
  namespace Express {
    interface Request {
      auth?: AuthContext;
      apiKey?: ApiKeyContext;
    }
  }
}

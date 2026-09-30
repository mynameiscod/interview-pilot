import type { OrgMeResponse, OrgPermission, SessionResponse } from '@cbi/shared-types';
import { useAuth, type SessionManager } from '@cbi/web-core';
import { createContext } from 'react';

/**
 * The org portal runs in the admin web app under `/org` with its own
 * session (the `org` audience: its own refresh cookie, tokens and tab
 * channel). Staff sessions and org sessions never mix.
 */
export const OrgManagerContext = createContext<SessionManager | null>(null);

export const useOrgAuth = () => useAuth<OrgMeResponse>();

/** Org sessions load /org/me so the UI knows the organisation and the member's permissions. */
export function loadOrgUser(_session: SessionResponse, manager: SessionManager) {
  return manager.api.get<OrgMeResponse>('/org/me');
}

export function useOrgCan(permission: OrgPermission): boolean {
  const { user } = useOrgAuth();
  return user?.orgPermissions.includes(permission) ?? false;
}

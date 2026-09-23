import type { AdminMeResponse, Permission, SessionResponse } from '@cbi/shared-types';
import { useAuth, type SessionManager } from '@cbi/web-core';

export const useAdminAuth = () => useAuth<AdminMeResponse>();

/** Admin sessions load /admin/me so the UI knows the effective permissions. */
export function loadAdminUser(_session: SessionResponse, manager: SessionManager) {
  return manager.api.get<AdminMeResponse>('/admin/me');
}

export function useCan(permission: Permission): boolean {
  const { user } = useAdminAuth();
  return user?.permissions.includes(permission) ?? false;
}

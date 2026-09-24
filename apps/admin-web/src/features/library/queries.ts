import type { BlueprintSummary, RoleSummary } from '@cbi/shared-types';
import { useQuery } from '@tanstack/react-query';
import { useAdminAuth } from '../../app/session';

export function useRoles() {
  const { manager } = useAdminAuth();
  return useQuery({
    queryKey: ['library', 'roles'],
    queryFn: () => manager.api.get<RoleSummary[]>('/admin/roles'),
  });
}

export function useRoleBlueprints(roleId: string) {
  const { manager } = useAdminAuth();
  return useQuery({
    queryKey: ['library', 'roles', roleId, 'blueprints'],
    queryFn: () => manager.api.get<BlueprintSummary[]>(`/admin/roles/${roleId}/blueprints`),
  });
}

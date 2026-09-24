import type { CostGroupBy, CostReport, Dashboard } from '@cbi/shared-types';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useAdminAuth } from '../../app/session';
import type { DayRange } from './format';

export const analyticsKeys = {
  all: ['analytics'] as const,
  dashboard: (range: DayRange) => ['analytics', 'dashboard', range.from, range.to] as const,
  costs: (range: DayRange, groupBy: CostGroupBy) =>
    ['analytics', 'costs', range.from, range.to, groupBy] as const,
};

export function useDashboard(range: DayRange) {
  const { manager } = useAdminAuth();
  return useQuery({
    queryKey: analyticsKeys.dashboard(range),
    queryFn: () => {
      const params = new URLSearchParams({ from: range.from, to: range.to });
      return manager.api.get<Dashboard>(`/admin/analytics/dashboard?${params.toString()}`);
    },
    // Keep the last range on screen while the next one loads.
    placeholderData: keepPreviousData,
  });
}

export function useCosts(range: DayRange, groupBy: CostGroupBy) {
  const { manager } = useAdminAuth();
  return useQuery({
    queryKey: analyticsKeys.costs(range, groupBy),
    queryFn: () => {
      const params = new URLSearchParams({ from: range.from, to: range.to, groupBy });
      return manager.api.get<CostReport>(`/admin/analytics/costs?${params.toString()}`);
    },
    placeholderData: keepPreviousData,
  });
}

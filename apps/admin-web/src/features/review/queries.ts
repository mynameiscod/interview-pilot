import type { AdminInterviewDetail, AdminInterviewRow } from '@cbi/shared-types';
import { useQuery } from '@tanstack/react-query';
import { useAdminAuth } from '../../app/session';

export const reviewKeys = {
  interviews: ['review', 'interviews'] as const,
  interview: (id: string) => ['review', 'interview', id] as const,
};

export type InterviewFilters = { state: string; campaignId: string; flagged: string; q: string };

export function useAdminInterviews(filters: InterviewFilters) {
  const { manager } = useAdminAuth();
  return useQuery({
    queryKey: [...reviewKeys.interviews, filters],
    queryFn: () => {
      const params = new URLSearchParams({ limit: '100' });
      if (filters.state) params.set('state', filters.state);
      if (filters.campaignId) params.set('campaignId', filters.campaignId);
      if (filters.flagged) params.set('flagged', filters.flagged);
      if (filters.q) params.set('q', filters.q);
      return manager.api.get<AdminInterviewRow[]>(`/admin/interviews?${params.toString()}`);
    },
  });
}

export function useAdminInterview(id: string) {
  const { manager } = useAdminAuth();
  return useQuery({
    queryKey: reviewKeys.interview(id),
    queryFn: () =>
      manager.api.get<AdminInterviewDetail>(`/admin/interviews/${encodeURIComponent(id)}`),
    // Every view is audited server-side; do not refetch in the background.
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });
}

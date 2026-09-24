import type {
  CampaignResults,
  CampaignSummary,
  CompanySummary,
  TemplateSummary,
} from '@cbi/shared-types';
import { useQuery } from '@tanstack/react-query';
import { useAdminAuth } from '../../app/session';

export const campaignKeys = {
  all: ['campaigns'] as const,
  list: ['campaigns', 'list'] as const,
  campaign: (id: string) => ['campaigns', 'campaign', id] as const,
  results: (id: string) => ['campaigns', 'results', id] as const,
};

/** Results filters as the API takes them (`dimension` is `key:min`). */
export type ResultsFilters = { status: string; minOverall: string; dimension: string };

export function resultsQuery(filters: ResultsFilters): string {
  const params = new URLSearchParams();
  if (filters.status) params.set('status', filters.status);
  if (filters.minOverall) params.set('minOverall', filters.minOverall);
  if (filters.dimension) params.set('dimension', filters.dimension);
  const query = params.toString();
  return query ? `?${query}` : '';
}

export function useCampaigns() {
  const { manager } = useAdminAuth();
  return useQuery({
    queryKey: campaignKeys.list,
    queryFn: () => manager.api.get<CampaignSummary[]>('/admin/campaigns'),
  });
}

export function useCampaign(id: string) {
  const { manager } = useAdminAuth();
  return useQuery({
    queryKey: campaignKeys.campaign(id),
    queryFn: () => manager.api.get<CampaignSummary>(`/admin/campaigns/${encodeURIComponent(id)}`),
  });
}

export function useCampaignResults(id: string, filters: ResultsFilters) {
  const { manager } = useAdminAuth();
  return useQuery({
    queryKey: [...campaignKeys.results(id), filters],
    queryFn: () =>
      manager.api.get<CampaignResults>(
        `/admin/campaigns/${encodeURIComponent(id)}/results${resultsQuery(filters)}`,
      ),
  });
}

/** Library lists used by the create form (same keys as the library pages). */
export function useTemplates() {
  const { manager } = useAdminAuth();
  return useQuery({
    queryKey: ['library', 'templates'],
    queryFn: () => manager.api.get<TemplateSummary[]>('/admin/templates'),
  });
}

export function useCompanies() {
  const { manager } = useAdminAuth();
  return useQuery({
    queryKey: ['library', 'companies'],
    queryFn: () => manager.api.get<CompanySummary[]>('/admin/companies'),
  });
}

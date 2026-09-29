import type {
  CampaignExport,
  CampaignListPage,
  CampaignResults,
  CampaignSummary,
  CompanySummary,
  TemplateSummary,
} from '@cbi/shared-types';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useAdminAuth } from '../../app/session';

export const campaignKeys = {
  all: ['campaigns'] as const,
  list: ['campaigns', 'list'] as const,
  campaign: (id: string) => ['campaigns', 'campaign', id] as const,
  results: (id: string) => ['campaigns', 'results', id] as const,
  export: (id: string, exportId: string) => ['campaigns', 'export', id, exportId] as const,
};

/** Campaigns per page on the list page. */
export const CAMPAIGNS_PAGE_SIZE = 25;
/** Candidates per page in the results grid (the API's default). */
export const RESULTS_PAGE_SIZE = 50;

/**
 * Results filters and order as the API takes them (`dimension` is `key:min`;
 * an empty `sort` is the server's default, best first).
 */
export type ResultsFilters = {
  status: string;
  minOverall: string;
  dimension: string;
  sort: string;
};

/** The query string for the grid (with `page`) or the CSV (without). Defaults are left out. */
export function resultsQuery(filters: ResultsFilters, page = 1): string {
  const params = new URLSearchParams();
  if (filters.status) params.set('status', filters.status);
  if (filters.minOverall) params.set('minOverall', filters.minOverall);
  if (filters.dimension) params.set('dimension', filters.dimension);
  if (filters.sort) params.set('sort', filters.sort);
  if (page > 1) params.set('page', String(page));
  const query = params.toString();
  return query ? `?${query}` : '';
}

export function useCampaigns(page: number) {
  const { manager } = useAdminAuth();
  return useQuery({
    queryKey: [...campaignKeys.list, page],
    queryFn: () =>
      manager.api.get<CampaignListPage>(
        `/admin/campaigns?page=${page}&pageSize=${CAMPAIGNS_PAGE_SIZE}`,
      ),
    // Keep the current page on screen while the next one loads.
    placeholderData: keepPreviousData,
  });
}

/** The most recent campaigns, for filter dropdowns (the API's largest page). */
export function useCampaignOptions() {
  const { manager } = useAdminAuth();
  return useQuery({
    queryKey: [...campaignKeys.list, 'options'],
    queryFn: async () =>
      (await manager.api.get<CampaignListPage>('/admin/campaigns?pageSize=100')).items,
  });
}

export function useCampaign(id: string) {
  const { manager } = useAdminAuth();
  return useQuery({
    queryKey: campaignKeys.campaign(id),
    queryFn: () => manager.api.get<CampaignSummary>(`/admin/campaigns/${encodeURIComponent(id)}`),
  });
}

export function useCampaignResults(id: string, filters: ResultsFilters, page: number) {
  const { manager } = useAdminAuth();
  return useQuery({
    queryKey: [...campaignKeys.results(id), filters, page],
    queryFn: () =>
      manager.api.get<CampaignResults>(
        `/admin/campaigns/${encodeURIComponent(id)}/results${resultsQuery(filters, page)}`,
      ),
    placeholderData: keepPreviousData,
  });
}

/** How often a package being built is checked. */
export const EXPORT_POLL_MS = 2_000;

/** A package export, polled until it is ready or has failed. */
export function useCampaignExport(id: string, exportId: string | null) {
  const { manager } = useAdminAuth();
  return useQuery({
    queryKey: campaignKeys.export(id, exportId ?? ''),
    queryFn: () =>
      manager.api.get<CampaignExport>(
        `/admin/campaigns/${encodeURIComponent(id)}/exports/${encodeURIComponent(exportId!)}`,
      ),
    enabled: exportId !== null,
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      return status === 'QUEUED' || status === 'RUNNING' ? EXPORT_POLL_MS : false;
    },
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

import type {
  ApiKeySummary,
  CampaignListPage,
  CampaignSummary,
  CohortAnalytics,
  InviteListPage,
  OrgCandidateDetail,
  OrgMemberSummary,
  OrgResults,
  OrgSummary,
  WebhookDelivery,
  WebhookSummary,
} from '@cbi/shared-types';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useOrgAuth } from './session';

export const orgKeys = {
  all: ['org'] as const,
  organisation: ['org', 'organisation'] as const,
  library: ['org', 'library'] as const,
  campaigns: ['org', 'campaigns'] as const,
  campaign: (id: string) => ['org', 'campaign', id] as const,
  results: (id: string) => ['org', 'results', id] as const,
  invites: (id: string) => ['org', 'invites', id] as const,
  candidate: (id: string, appId: string) => ['org', 'candidate', id, appId] as const,
  cohort: ['org', 'cohort'] as const,
  members: ['org', 'members'] as const,
  webhooks: ['org', 'webhooks'] as const,
  deliveries: (id: string) => ['org', 'deliveries', id] as const,
  apiKeys: ['org', 'api-keys'] as const,
};

const enc = encodeURIComponent;

/** Query string without empty values (and without page 1). */
export function queryString(values: Record<string, string | number | undefined>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined || value === '' || (key === 'page' && value === 1)) continue;
    params.set(key, String(value));
  }
  const query = params.toString();
  return query ? `?${query}` : '';
}

export type OrgLibrary = {
  roles: { id: string; title: string }[];
  templates: { key: string; name: string; modes: string[] }[];
};

export function useOrganisation() {
  const { manager } = useOrgAuth();
  return useQuery({
    queryKey: orgKeys.organisation,
    queryFn: () => manager.api.get<OrgSummary>('/org/organisation'),
  });
}

export function useOrgLibrary() {
  const { manager } = useOrgAuth();
  return useQuery({
    queryKey: orgKeys.library,
    queryFn: () => manager.api.get<OrgLibrary>('/org/library'),
  });
}

export function useOrgCampaigns(page: number) {
  const { manager } = useOrgAuth();
  return useQuery({
    queryKey: [...orgKeys.campaigns, page],
    queryFn: () =>
      manager.api.get<CampaignListPage>(`/org/campaigns${queryString({ page, pageSize: 25 })}`),
    placeholderData: keepPreviousData,
  });
}

export function useOrgCampaign(id: string) {
  const { manager } = useOrgAuth();
  return useQuery({
    queryKey: orgKeys.campaign(id),
    queryFn: () => manager.api.get<CampaignSummary>(`/org/campaigns/${enc(id)}`),
  });
}

export type PipelineFilters = {
  status: string;
  stage: string;
  minOverall: string;
  minScorecard: string;
  dimension: string;
  sort: string;
};

export const EMPTY_FILTERS: PipelineFilters = {
  status: '',
  stage: '',
  minOverall: '',
  minScorecard: '',
  dimension: '',
  sort: '',
};

export function useOrgResults(id: string, filters: PipelineFilters, page: number) {
  const { manager } = useOrgAuth();
  return useQuery({
    queryKey: [...orgKeys.results(id), filters, page],
    queryFn: () =>
      manager.api.get<OrgResults>(
        `/org/campaigns/${enc(id)}/results${queryString({ ...filters, page })}`,
      ),
    placeholderData: keepPreviousData,
  });
}

export function useOrgInvites(id: string, status: string, page: number) {
  const { manager } = useOrgAuth();
  return useQuery({
    queryKey: [...orgKeys.invites(id), status, page],
    queryFn: () =>
      manager.api.get<InviteListPage>(
        `/org/campaigns/${enc(id)}/invites${queryString({ status, page })}`,
      ),
    placeholderData: keepPreviousData,
  });
}

export function useOrgCandidate(id: string, appId: string) {
  const { manager } = useOrgAuth();
  return useQuery({
    queryKey: orgKeys.candidate(id, appId),
    queryFn: () =>
      manager.api.get<OrgCandidateDetail>(`/org/campaigns/${enc(id)}/candidates/${enc(appId)}`),
  });
}

export type CohortFilters = { campaignId: string; batch: string; branch: string; year: string };

export function useCohort(filters: CohortFilters) {
  const { manager } = useOrgAuth();
  return useQuery({
    queryKey: [...orgKeys.cohort, filters],
    queryFn: () => manager.api.get<CohortAnalytics>(`/org/analytics/cohort${queryString(filters)}`),
    placeholderData: keepPreviousData,
  });
}

export function useOrgMembers() {
  const { manager } = useOrgAuth();
  return useQuery({
    queryKey: orgKeys.members,
    queryFn: () => manager.api.get<OrgMemberSummary[]>('/org/members'),
  });
}

export function useWebhooks() {
  const { manager } = useOrgAuth();
  return useQuery({
    queryKey: orgKeys.webhooks,
    queryFn: () => manager.api.get<WebhookSummary[]>('/org/webhooks'),
  });
}

export function useDeliveries(webhookId: string | null) {
  const { manager } = useOrgAuth();
  return useQuery({
    queryKey: orgKeys.deliveries(webhookId ?? ''),
    queryFn: () =>
      manager.api.get<WebhookDelivery[]>(`/org/webhooks/${enc(webhookId!)}/deliveries`),
    enabled: webhookId !== null,
  });
}

export function useApiKeys() {
  const { manager } = useOrgAuth();
  return useQuery({
    queryKey: orgKeys.apiKeys,
    queryFn: () => manager.api.get<ApiKeySummary[]>('/org/api-keys'),
  });
}

import type { JoinCampaignResult, PublicCampaign } from '@cbi/shared-types';
import type { ApiClient } from '@cbi/web-core';
import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { useCandidateAuth } from '../../app/session';

function campaignsApi(api: ApiClient) {
  const enc = encodeURIComponent;
  return {
    /** Public: works signed out; signed in, it also says whether the candidate already joined. */
    getPublic: (token: string) => api.get<PublicCampaign>(`/campaigns/${enc(token)}`),
    /** Creates the candidate's interview (or returns the one they already have). */
    join: (token: string, resumeId: string | null) =>
      api.post<JoinCampaignResult>(`/campaigns/${enc(token)}/join`, { resumeId }),
  };
}

export type CampaignsApi = ReturnType<typeof campaignsApi>;

export function useCampaignsApi(): CampaignsApi {
  const { manager } = useCandidateAuth();
  return useMemo(() => campaignsApi(manager.api), [manager]);
}

export const campaignKeys = {
  /** Keyed by the viewer too: signing in changes `joinedInterviewId`. */
  public: (token: string, userId: string | null) => ['campaigns', token, userId] as const,
};

/** The campaign behind an invite link, loaded once the session is known. */
export function usePublicCampaign(token: string) {
  const api = useCampaignsApi();
  const { status, user } = useCandidateAuth();
  return useQuery({
    queryKey: campaignKeys.public(token, user?.id ?? null),
    queryFn: () => api.getPublic(token),
    enabled: status !== 'loading',
  });
}

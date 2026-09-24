import type {
  ConsentDecisionBody,
  InterviewSummary,
  SessionConsents,
  UserConsentEntry,
} from '@cbi/shared-types';
import type { ApiClient } from '@cbi/web-core';
import { useQuery, type QueryClient } from '@tanstack/react-query';
import { useMemo } from 'react';
import { useCandidateAuth } from '../../app/session';
import { queryKeys } from '../interviews/interviews-api';

const path = (id: string) => `/interviews/${encodeURIComponent(id)}/consents`;

function consentApi(api: ApiClient) {
  return {
    /** The consents this interview asks for (from its mode and template), with any decisions. */
    forInterview: (id: string) => api.get<SessionConsents>(path(id)),
    /** Records decisions before the interview starts. */
    decide: (id: string, decisions: ConsentDecisionBody['decisions']) =>
      api.post<SessionConsents>(path(id), { decisions }),
    /** Every consent decision the candidate has made (privacy). */
    history: () => api.get<UserConsentEntry[]>('/users/me/consents'),
  };
}

export type ConsentApi = ReturnType<typeof consentApi>;

export function useConsentApi(): ConsentApi {
  const { manager } = useCandidateAuth();
  return useMemo(() => consentApi(manager.api), [manager]);
}

export const consentKeys = {
  session: (id: string) => ['interviews', id, 'consents'] as const,
  history: ['users', 'me', 'consents'] as const,
};

export function useSessionConsents(id: string) {
  const api = useConsentApi();
  return useQuery({ queryKey: consentKeys.session(id), queryFn: () => api.forInterview(id) });
}

export function useConsentHistory() {
  const api = useConsentApi();
  return useQuery({ queryKey: consentKeys.history, queryFn: api.history });
}

/**
 * After new decisions: update the cached interview straight away (so the next
 * screen knows at once) and refetch it for the server's own readiness.
 */
export function applyConsents(queryClient: QueryClient, id: string, consents: SessionConsents) {
  queryClient.setQueryData(consentKeys.session(id), consents);
  queryClient.setQueryData<InterviewSummary>(queryKeys.interview(id), (old) => {
    if (!old) return old;
    const voice = old.voice
      ? {
          ...old.voice,
          consentsComplete: consents.complete,
          ready: consents.complete && old.voice.deviceCheck?.passed === true,
          recording: consents.items.some(
            (item) => item.type === 'RECORDING' && item.decision?.accepted === true,
          ),
        }
      : null;
    return { ...old, consentsPending: !consents.complete, voice };
  });
  void queryClient.invalidateQueries({ queryKey: queryKeys.interview(id), exact: true });
  void queryClient.invalidateQueries({ queryKey: consentKeys.history });
}

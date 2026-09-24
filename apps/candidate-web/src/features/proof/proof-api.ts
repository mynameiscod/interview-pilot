import type { CreatedShareLink, ProofView, ShareLinkSummary } from '@cbi/shared-types';
import type { ApiClient } from '@cbi/web-core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo } from 'react';
import { useCandidateAuth } from '../../app/session';

/** Share-link lifetimes offered to candidates (the API accepts 1–30 days). */
export const EXPIRY_CHOICES = [1, 7, 14, 30] as const;
export const DEFAULT_EXPIRY_DAYS = 14;

function proofApi(api: ApiClient) {
  const enc = encodeURIComponent;
  return {
    listShares: (sessionId: string) =>
      api.get<ShareLinkSummary[]>(`/reports/${enc(sessionId)}/shares`),
    createShare: (sessionId: string, expiresInDays: number) =>
      api.post<CreatedShareLink>(`/reports/${enc(sessionId)}/shares`, { expiresInDays }),
    revokeShare: (id: string) => api.delete<ShareLinkSummary>(`/reports/shares/${enc(id)}`),
    /** Public: no sign-in needed. */
    getProof: (token: string) => api.get<ProofView>(`/proof/${enc(token)}`),
  };
}

export type ProofApi = ReturnType<typeof proofApi>;

export function useProofApi(): ProofApi {
  const { manager } = useCandidateAuth();
  return useMemo(() => proofApi(manager.api), [manager]);
}

export const proofKeys = {
  shares: (sessionId: string) => ['reports', sessionId, 'shares'] as const,
  proof: (token: string) => ['proof', token] as const,
};

export function useShareLinks(sessionId: string, enabled: boolean) {
  const api = useProofApi();
  return useQuery({
    queryKey: proofKeys.shares(sessionId),
    queryFn: () => api.listShares(sessionId),
    enabled,
  });
}

export function useCreateShare(sessionId: string) {
  const api = useProofApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (expiresInDays: number) => api.createShare(sessionId, expiresInDays),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: proofKeys.shares(sessionId) }),
  });
}

export function useRevokeShare(sessionId: string) {
  const api = useProofApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.revokeShare(id),
    onSuccess: (revoked) =>
      queryClient.setQueryData<ShareLinkSummary[]>(proofKeys.shares(sessionId), (old) =>
        old?.map((link) => (link.id === revoked.id ? revoked : link)),
      ),
  });
}

export function useProof(token: string) {
  const api = useProofApi();
  return useQuery({
    queryKey: proofKeys.proof(token),
    queryFn: () => api.getProof(token),
    // Expired, revoked and unknown links answer 404; retrying will not change that.
    retry: false,
  });
}

export type ShareState = 'active' | 'expired' | 'revoked';

export function shareState(link: ShareLinkSummary, now = Date.now()): ShareState {
  if (link.revokedAt) return 'revoked';
  if (new Date(link.expiresAt).getTime() <= now) return 'expired';
  return 'active';
}

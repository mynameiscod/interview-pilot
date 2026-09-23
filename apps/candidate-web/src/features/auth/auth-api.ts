import type {
  AuthProvidersResponse,
  MeResponse,
  OtpChannel,
  OtpRequestResponse,
  SessionResponse,
  UpdateProfileBody,
} from '@cbi/shared-types';
import type { ApiClient } from '@cbi/web-core';
import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { useCandidateAuth } from '../../app/session';

function candidateApi(api: ApiClient) {
  return {
    providers: () => api.get<AuthProvidersResponse>('/auth/providers'),
    requestOtp: (channel: OtpChannel, destination: string) =>
      api.post<OtpRequestResponse>(
        '/auth/otp/request',
        { channel, destination },
        { noRefresh: true },
      ),
    verifyOtp: (challengeId: string, code: string) =>
      api.post<SessionResponse>('/auth/otp/verify', { challengeId, code }, { noRefresh: true }),
    google: (idToken: string) =>
      api.post<SessionResponse>('/auth/google', { idToken }, { noRefresh: true }),
    requestLinkOtp: (channel: OtpChannel, destination: string) =>
      api.post<OtpRequestResponse>('/auth/link/otp/request', { channel, destination }),
    verifyLinkOtp: (challengeId: string, code: string) =>
      api.post<MeResponse>('/auth/link/otp/verify', { challengeId, code }),
    linkGoogle: (idToken: string) => api.post<MeResponse>('/auth/link/google', { idToken }),
    updateProfile: (body: UpdateProfileBody) => api.patch<MeResponse>('/users/me/profile', body),
  };
}

export type CandidateApi = ReturnType<typeof candidateApi>;

export function useCandidateApi(): CandidateApi {
  const { manager } = useCandidateAuth();
  return useMemo(() => candidateApi(manager.api), [manager]);
}

export function useAuthProviders() {
  const api = useCandidateApi();
  return useQuery({ queryKey: ['auth', 'providers'], queryFn: api.providers, staleTime: 300_000 });
}

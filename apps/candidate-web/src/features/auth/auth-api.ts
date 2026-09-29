import type {
  AuthProvidersResponse,
  MeResponse,
  OtpChannel,
  OtpRequestResponse,
  SessionResponse,
  UiLocale,
  UpdateProfileBody,
} from '@cbi/shared-types';
import { toUiLocale, type ApiClient } from '@cbi/web-core';
import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useCandidateAuth } from '../../app/session';

/** `lang` is read at call time so a language switch applies to the next code sent. */
function candidateApi(api: ApiClient, lang: () => UiLocale | undefined) {
  return {
    providers: () => api.get<AuthProvidersResponse>('/auth/providers'),
    requestOtp: (channel: OtpChannel, destination: string) =>
      api.post<OtpRequestResponse>(
        '/auth/otp/request',
        { channel, destination, lang: lang() },
        { noRefresh: true },
      ),
    verifyOtp: (challengeId: string, code: string) =>
      api.post<SessionResponse>('/auth/otp/verify', { challengeId, code }, { noRefresh: true }),
    google: (idToken: string) =>
      api.post<SessionResponse>('/auth/google', { idToken }, { noRefresh: true }),
    requestLinkOtp: (channel: OtpChannel, destination: string) =>
      api.post<OtpRequestResponse>('/auth/link/otp/request', {
        channel,
        destination,
        lang: lang(),
      }),
    verifyLinkOtp: (challengeId: string, code: string) =>
      api.post<MeResponse>('/auth/link/otp/verify', { challengeId, code }),
    linkGoogle: (idToken: string) => api.post<MeResponse>('/auth/link/google', { idToken }),
    updateProfile: (body: UpdateProfileBody) => api.patch<MeResponse>('/users/me/profile', body),
  };
}

export type CandidateApi = ReturnType<typeof candidateApi>;

export function useCandidateApi(): CandidateApi {
  const { manager } = useCandidateAuth();
  const { i18n } = useTranslation();
  return useMemo(
    () => candidateApi(manager.api, () => toUiLocale(i18n.resolvedLanguage)),
    [manager, i18n],
  );
}

export function useAuthProviders() {
  const api = useCandidateApi();
  return useQuery({ queryKey: ['auth', 'providers'], queryFn: api.providers, staleTime: 300_000 });
}

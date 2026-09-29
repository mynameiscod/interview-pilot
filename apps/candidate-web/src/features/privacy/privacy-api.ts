import type {
  ActiveSession,
  DataExportBundle,
  DeleteAccountBody,
  DeleteAccountResponse,
  LegalInfo,
  OtpChannel,
  OtpRequestResponse,
} from '@cbi/shared-types';
import type { ApiClient } from '@cbi/web-core';
import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { useCandidateAuth } from '../../app/session';

function privacyApi(api: ApiClient) {
  return {
    /** Public: grievance officer and retention periods for the legal pages. */
    legal: () => api.get<LegalInfo>('/legal', { noRefresh: true }),
    exportData: () => api.get<DataExportBundle>('/users/me/export'),
    requestReauth: (channel: OtpChannel) =>
      api.post<OtpRequestResponse>('/users/me/reauth/otp', { channel }),
    deleteAccount: (body: DeleteAccountBody) =>
      api.delete<DeleteAccountResponse>('/users/me', body),
    sessions: () => api.get<ActiveSession[]>('/auth/sessions'),
    revokeSession: (id: string) => api.delete<void>(`/auth/sessions/${encodeURIComponent(id)}`),
  };
}

export type PrivacyApi = ReturnType<typeof privacyApi>;

export function usePrivacyApi(): PrivacyApi {
  const { manager } = useCandidateAuth();
  return useMemo(() => privacyApi(manager.api), [manager]);
}

export const privacyKeys = {
  legal: ['legal'] as const,
  sessions: ['auth', 'sessions'] as const,
};

export function useLegalInfo() {
  const api = usePrivacyApi();
  return useQuery({ queryKey: privacyKeys.legal, queryFn: api.legal, staleTime: 300_000 });
}

export function useActiveSessions() {
  const api = usePrivacyApi();
  return useQuery({ queryKey: privacyKeys.sessions, queryFn: api.sessions });
}

/** Saves the export as a JSON file (the browser's download, no server round-trip twice). */
export function downloadJson(filename: string, data: unknown) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoke after the click has been handled.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

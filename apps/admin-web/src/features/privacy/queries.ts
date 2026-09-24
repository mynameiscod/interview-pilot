import type {
  AdminIntegrityEvent,
  AdminMediaAsset,
  ConsentTextSummary,
  MediaDeletionStatus,
  MediaStatus,
} from '@cbi/shared-types';
import { useQuery } from '@tanstack/react-query';
import { useAdminAuth } from '../../app/session';

export const privacyKeys = {
  media: ['privacy', 'media'] as const,
  mediaAsset: (id: string) => ['privacy', 'media-asset', id] as const,
  integrity: (sessionId: string) => ['privacy', 'integrity', sessionId] as const,
  consentTexts: ['privacy', 'consent-texts'] as const,
};

export type MediaFilters = {
  status: MediaStatus | '';
  deletion: MediaDeletionStatus | '';
  q: string;
};

export function useMediaAssets(filters: MediaFilters) {
  const { manager } = useAdminAuth();
  return useQuery({
    queryKey: [...privacyKeys.media, filters],
    queryFn: () => {
      const params = new URLSearchParams({ limit: '100' });
      if (filters.status) params.set('status', filters.status);
      if (filters.deletion) params.set('deletion', filters.deletion);
      if (filters.q) params.set('q', filters.q);
      return manager.api.get<AdminMediaAsset[]>(`/admin/media?${params.toString()}`);
    },
  });
}

export function useMediaAsset(id: string) {
  const { manager } = useAdminAuth();
  return useQuery({
    queryKey: privacyKeys.mediaAsset(id),
    queryFn: () => manager.api.get<AdminMediaAsset>(`/admin/media/${encodeURIComponent(id)}`),
  });
}

export function useIntegrityEvents(sessionId: string) {
  const { manager } = useAdminAuth();
  return useQuery({
    queryKey: privacyKeys.integrity(sessionId),
    queryFn: () =>
      manager.api.get<AdminIntegrityEvent[]>(
        `/admin/interviews/${encodeURIComponent(sessionId)}/integrity`,
      ),
  });
}

export function useConsentTexts() {
  const { manager } = useAdminAuth();
  return useQuery({
    queryKey: privacyKeys.consentTexts,
    queryFn: () => manager.api.get<ConsentTextSummary[]>('/admin/consent-texts'),
  });
}

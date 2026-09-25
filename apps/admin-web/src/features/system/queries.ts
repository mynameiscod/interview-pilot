import type {
  FailedJob,
  FeatureFlag,
  IntegrationSummary,
  QueueCounts,
  SettingEntry,
  SystemHealth,
} from '@cbi/shared-types';
import { useQuery } from '@tanstack/react-query';
import { useAdminAuth } from '../../app/session';

/** How often the health view refreshes itself. */
export const HEALTH_REFRESH_MS = 15_000;

/** A worker whose last heartbeat is older than this is shown as stale. */
export const STALE_WORKER_SEC = 90;

export const FAILED_JOBS_LIMIT = 25;

export const systemKeys = {
  health: ['system', 'health'] as const,
  queues: ['system', 'queues'] as const,
  failed: (queue: string) => ['system', 'queues', queue, 'failed'] as const,
  flags: ['system', 'flags'] as const,
  settings: ['system', 'settings'] as const,
  integrations: ['system', 'integrations'] as const,
};

export function useSystemHealth() {
  const { manager } = useAdminAuth();
  return useQuery({
    queryKey: systemKeys.health,
    queryFn: () => manager.api.get<SystemHealth>('/admin/system/health'),
    refetchInterval: HEALTH_REFRESH_MS,
    staleTime: 0,
  });
}

export function useQueues() {
  const { manager } = useAdminAuth();
  return useQuery({
    queryKey: systemKeys.queues,
    queryFn: () => manager.api.get<QueueCounts[]>('/admin/system/queues'),
    staleTime: 0,
  });
}

export function useFailedJobs(queue: string | null) {
  const { manager } = useAdminAuth();
  return useQuery({
    queryKey: systemKeys.failed(queue ?? ''),
    queryFn: () =>
      manager.api.get<FailedJob[]>(
        `/admin/system/queues/${encodeURIComponent(queue ?? '')}/failed?limit=${FAILED_JOBS_LIMIT}`,
      ),
    enabled: queue !== null,
    staleTime: 0,
  });
}

export function useFlags() {
  const { manager } = useAdminAuth();
  return useQuery({
    queryKey: systemKeys.flags,
    queryFn: () => manager.api.get<FeatureFlag[]>('/admin/flags'),
  });
}

export function useSettings() {
  const { manager } = useAdminAuth();
  return useQuery({
    queryKey: systemKeys.settings,
    queryFn: () => manager.api.get<SettingEntry[]>('/admin/settings'),
  });
}

export function useIntegrations() {
  const { manager } = useAdminAuth();
  return useQuery({
    queryKey: systemKeys.integrations,
    queryFn: () => manager.api.get<IntegrationSummary[]>('/admin/integrations'),
    staleTime: 0,
  });
}

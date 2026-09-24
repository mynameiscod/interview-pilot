import type { ClientFlags, KnownFlag, PublicSystemStatus } from '@cbi/shared-types';
import { useQuery } from '@tanstack/react-query';
import { useCandidateAuth } from './session';

/** How often the maintenance banner re-checks the system status. */
export const STATUS_POLL_MS = 120_000;
/** How long evaluated feature flags are reused. */
export const FLAGS_STALE_MS = 60_000;

const NO_FLAGS: ClientFlags = {};

export const systemKeys = {
  status: ['system', 'status'] as const,
  flags: (who: string) => ['flags', who] as const,
};

/** Public status (the maintenance banner); polled lightly and on focus. */
export function useSystemStatus() {
  const { manager } = useCandidateAuth();
  return useQuery({
    queryKey: systemKeys.status,
    queryFn: () => manager.api.get<PublicSystemStatus>('/system/status'),
    refetchInterval: STATUS_POLL_MS,
    refetchOnWindowFocus: true,
    staleTime: STATUS_POLL_MS / 2,
    retry: false,
  });
}

/**
 * Client-visible feature flags, evaluated for the caller (rollouts are per
 * user, so they are re-read on sign-in). Every flag is off while loading and
 * when the request fails.
 */
export function useFlags(): ClientFlags {
  const { manager, status, user } = useCandidateAuth();
  const query = useQuery({
    queryKey: systemKeys.flags(user?.id ?? 'anonymous'),
    queryFn: () => manager.api.get<ClientFlags>('/flags'),
    enabled: status !== 'loading',
    staleTime: FLAGS_STALE_MS,
    retry: false,
  });
  return query.isSuccess && query.data ? query.data : NO_FLAGS;
}

export function useFlag(key: KnownFlag): boolean {
  return useFlags()[key] === true;
}

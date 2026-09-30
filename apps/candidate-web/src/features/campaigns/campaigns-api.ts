import {
  API_V1_PREFIX,
  ApiErrorBody,
  type IdentityCaptureStatus,
  type JoinCampaignResult,
  type PublicCampaign,
} from '@cbi/shared-types';
import { ApiClientError, type ApiClient, type SessionManager } from '@cbi/web-core';
import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { useCandidateAuth } from '../../app/session';
import { config } from '../../config';

/**
 * How the candidate reached the campaign: the company's shared link
 * (`/campaign/<token>`) or a personal invite (`/campaign/i/<token>`).
 */
export type CampaignSource = { kind: 'link' | 'invite'; token: string };

const base = (source: CampaignSource) =>
  `${source.kind === 'invite' ? '/campaign-invites' : '/campaigns'}/${encodeURIComponent(source.token)}`;

/** The page's own path (to come back to after signing in). */
export const sourcePath = (source: CampaignSource) =>
  source.kind === 'invite' ? `/campaign/i/${source.token}` : `/campaign/${source.token}`;

function campaignsApi(api: ApiClient) {
  return {
    /** Public: works signed out; signed in, it also says whether the candidate already joined. */
    getPublic: (source: CampaignSource) => api.get<PublicCampaign>(base(source)),
    /** Creates the candidate's interview (or returns the one they already have). */
    join: (source: CampaignSource, resumeId: string | null) =>
      api.post<JoinCampaignResult>(`${base(source)}/join`, { resumeId }),
  };
}

export type CampaignsApi = ReturnType<typeof campaignsApi>;

export function useCampaignsApi(): CampaignsApi {
  const { manager } = useCandidateAuth();
  return useMemo(() => campaignsApi(manager.api), [manager]);
}

export const campaignKeys = {
  /** Keyed by the viewer too: signing in changes `joinedInterviewId`. */
  public: (source: CampaignSource, userId: string | null) =>
    ['campaigns', source.kind, source.token, userId] as const,
};

/** The campaign behind an invite link, loaded once the session is known. */
export function usePublicCampaign(source: CampaignSource) {
  const api = useCampaignsApi();
  const { status, user } = useCandidateAuth();
  return useQuery({
    queryKey: campaignKeys.public(source, user?.id ?? null),
    queryFn: () => api.getPublic(source),
    enabled: status !== 'loading',
  });
}

/** Identity photo kinds as they appear in the upload path. */
export type IdentityPhoto = 'selfie' | 'id-document' | 'interview-frame';

/**
 * Uploads an identity photo as the raw request body (the JSON client
 * cannot send a Blob), refreshing an expired token once.
 */
export async function uploadIdentityPhoto(
  manager: SessionManager,
  interviewId: string,
  kind: IdentityPhoto,
  blob: Blob,
): Promise<IdentityCaptureStatus> {
  const url = `${config.VITE_API_URL}${API_V1_PREFIX}/interviews/${encodeURIComponent(interviewId)}/identity/${kind}`;
  const put = (token: string | null) =>
    fetch(url, {
      method: 'PUT',
      credentials: 'include',
      headers: {
        'Content-Type': blob.type || 'image/jpeg',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: blob,
    });
  let res = await put(manager.current?.accessToken ?? null);
  if (res.status === 401) res = await put((await manager.refresh())?.accessToken ?? null);
  const json = (await res.json().catch(() => undefined)) as
    { data?: IdentityCaptureStatus } | undefined;
  if (!res.ok) {
    const parsed = ApiErrorBody.safeParse(json);
    if (parsed.success) {
      const { code, message, requestId, details } = parsed.data.error;
      throw new ApiClientError(code, message, res.status, requestId, details);
    }
    throw new ApiClientError('INVALID_RESPONSE', 'Upload failed', res.status);
  }
  return json!.data!;
}

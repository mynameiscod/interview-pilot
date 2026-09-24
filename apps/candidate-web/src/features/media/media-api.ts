import {
  API_V1_PREFIX,
  ApiErrorBody,
  type FinalizeMediaBody,
  type MediaAssetSummary,
  type PlaybackUrl,
} from '@cbi/shared-types';
import { ApiClientError, type ApiClient, type SessionManager } from '@cbi/web-core';
import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { useCandidateAuth } from '../../app/session';
import { config } from '../../config';
import type { SendResult } from './upload-queue';

const path = (id: string) => `/interviews/${encodeURIComponent(id)}/media`;

function mediaApi(api: ApiClient) {
  return {
    /** The interview's recording, or null when it was not recorded. */
    get: (id: string) => api.get<MediaAssetSummary | null>(path(id)),
    /** A short-lived link the video element can play (a path on the API origin). */
    playback: (id: string) => api.get<PlaybackUrl>(`${path(id)}/playback-url`),
    remove: (id: string) => api.delete<unknown>(path(id)),
    finalize: (id: string, body: FinalizeMediaBody) =>
      api.post<MediaAssetSummary | null>(`${path(id)}/finalize`, body),
  };
}

export type MediaApi = ReturnType<typeof mediaApi>;

export function useMediaApi(): MediaApi {
  const { manager } = useCandidateAuth();
  return useMemo(() => mediaApi(manager.api), [manager]);
}

export const mediaKeys = {
  recording: (id: string) => ['interviews', id, 'media'] as const,
};

export function useRecording(id: string) {
  const api = useMediaApi();
  return useQuery({ queryKey: mediaKeys.recording(id), queryFn: () => api.get(id) });
}

/** A playback path from the API, as a URL the video element can load. */
export const playbackSrc = (url: string) =>
  /^https?:\/\//.test(url) ? url : `${config.VITE_API_URL}${url}`;

/** An API call's outcome for the upload queue: network errors throw, HTTP errors are results. */
export async function asSendResult(call: () => Promise<unknown>): Promise<SendResult> {
  try {
    await call();
    return { status: 200 };
  } catch (err) {
    if (err instanceof ApiClientError && err.status !== null) {
      return { status: err.status, code: err.code };
    }
    throw err;
  }
}

/**
 * Uploads one recorded segment as the raw request body (the JSON client
 * cannot send a Blob). An expired token is refreshed once. Network errors
 * throw; HTTP errors are returned for the queue to classify.
 */
export async function sendSegment(
  manager: SessionManager,
  sessionId: string,
  idx: number,
  blob: Blob,
  contentType: string,
): Promise<SendResult> {
  const url = `${config.VITE_API_URL}${API_V1_PREFIX}${path(sessionId)}/segments/${idx}`;
  const post = (token: string | null) =>
    fetch(url, {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': contentType,
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: blob,
    });
  let response = await post(manager.current?.accessToken ?? null);
  if (response.status === 401) {
    const session = await manager.refresh().catch(() => null);
    if (session) response = await post(session.accessToken);
  }
  if (response.ok) return { status: response.status };
  const parsed = ApiErrorBody.safeParse(await response.json().catch(() => undefined));
  return { status: response.status, code: parsed.success ? parsed.data.error.code : null };
}

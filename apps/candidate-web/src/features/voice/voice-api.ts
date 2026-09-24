import {
  API_V1_PREFIX,
  ApiErrorBody,
  VOICE_CONSENT_VERSION,
  type DeviceCheckBody,
  type InterviewMode,
  type ModeSwitchReason,
  type VoiceHealth,
  type VoiceReadiness,
  type VoiceTranscript,
} from '@cbi/shared-types';
import { ApiClientError, type ApiClient, type SessionManager } from '@cbi/web-core';
import { useMemo } from 'react';
import { useCandidateAuth } from '../../app/session';
import { config } from '../../config';

const path = (id: string) => `/interviews/${encodeURIComponent(id)}`;

function voiceApi(api: ApiClient) {
  return {
    health: () => api.get<VoiceHealth>('/voice/health'),
    /** Records the browser's device check (voice interviews, before starting). */
    deviceCheck: (id: string, body: DeviceCheckBody) =>
      api.post<VoiceReadiness>(`${path(id)}/device-check`, body),
    consent: (id: string) =>
      api.post<VoiceReadiness>(`${path(id)}/voice-consent`, {
        accepted: true,
        version: VOICE_CONSENT_VERSION,
      }),
    /** Sends a recorded answer to be turned into text (not yet the answer). */
    transcribe: (id: string, questionId: string, audio: Blob, durationMs: number) => {
      const form = new FormData();
      // Fields first: the server reads them before the file.
      form.append('questionId', questionId);
      form.append('durationMs', String(Math.round(durationMs)));
      form.append('audio', audio, `answer.${extensionFor(audio.type)}`);
      return api.post<VoiceTranscript>(`${path(id)}/voice/transcribe`, form);
    },
    switchMode: (id: string, mode: Exclude<InterviewMode, 'VIDEO'>, reason: ModeSwitchReason) =>
      api.post<{ mode: InterviewMode }>(`${path(id)}/mode`, { mode, reason }),
  };
}

export type VoiceApi = ReturnType<typeof voiceApi>;

export function useVoiceApi(): VoiceApi {
  const { manager } = useCandidateAuth();
  return useMemo(() => voiceApi(manager.api), [manager]);
}

function extensionFor(mimeType: string): string {
  if (mimeType.startsWith('audio/ogg')) return 'ogg';
  if (mimeType.startsWith('audio/mp4')) return 'm4a';
  return 'webm';
}

/**
 * Downloads a question's spoken audio. It needs the access token, so it is
 * fetched (not linked) and played from an object URL by the caller. An
 * expired token is refreshed once. Errors are ApiClientErrors.
 */
export async function fetchQuestionAudio(
  manager: SessionManager,
  sessionId: string,
  questionId: string,
  signal?: AbortSignal,
): Promise<Blob> {
  const url = `${config.VITE_API_URL}${API_V1_PREFIX}${path(sessionId)}/questions/${encodeURIComponent(questionId)}/audio`;
  const get = (token: string | null) =>
    fetch(url, {
      credentials: 'include',
      signal,
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });

  let response: Response;
  try {
    response = await get(manager.current?.accessToken ?? null);
    if (response.status === 401) {
      const session = await manager.refresh();
      if (session) response = await get(session.accessToken);
    }
  } catch (err) {
    if ((err as Error)?.name === 'AbortError') throw err;
    throw new ApiClientError('NETWORK_ERROR', 'Could not reach the server.', null);
  }
  if (!response.ok) {
    const parsed = ApiErrorBody.safeParse(await response.json().catch(() => undefined));
    if (parsed.success) {
      const { code, message, requestId } = parsed.data.error;
      throw new ApiClientError(code, message, response.status, requestId);
    }
    throw new ApiClientError('INVALID_RESPONSE', 'Unexpected server response', response.status);
  }
  return response.blob();
}

export const isSpeechUnavailable = (err: unknown) =>
  err instanceof ApiClientError &&
  (err.code === 'SPEECH_UNAVAILABLE' || err.code === 'SERVICE_UNAVAILABLE' || err.status === 503);

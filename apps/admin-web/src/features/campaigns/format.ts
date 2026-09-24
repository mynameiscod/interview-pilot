import { API_V1_PREFIX, ApiErrorBody, type CampaignStatus } from '@cbi/shared-types';
import { ApiClientError, type SessionManager } from '@cbi/web-core';
import type { TFunction } from 'i18next';
import { config } from '../../config';
import { consoleError } from '../ai/format';

/** The full invite link when the candidate site address is configured, else the path alone. */
export function inviteLink(invitePath: string): { url: string; full: boolean } {
  return config.candidateUrl
    ? { url: `${config.candidateUrl}${invitePath}`, full: true }
    : { url: invitePath, full: false };
}

/** The moves the API allows from each status (closed is final). */
export const STATUS_MOVES: Record<CampaignStatus, ('ACTIVE' | 'PAUSED' | 'CLOSED')[]> = {
  DRAFT: ['ACTIVE', 'CLOSED'],
  ACTIVE: ['PAUSED', 'CLOSED'],
  PAUSED: ['ACTIVE', 'CLOSED'],
  CLOSED: [],
};

/** Campaign and review conflicts carry a specific server message worth showing. */
export function campaignError(t: TFunction, err: unknown): string {
  if (
    err instanceof ApiClientError &&
    (err.code === 'INVALID_STATE' || err.code === 'CAMPAIGN_CLOSED')
  ) {
    return err.message;
  }
  return consoleError(t, err);
}

function fileNameFrom(disposition: string | null, fallback: string): string {
  const match = disposition?.match(/filename="?([^";]+)"?/i);
  return match?.[1] ?? fallback;
}

/**
 * Downloads a file export. The API client only understands JSON, so this
 * fetches the bytes directly with the session's bearer token (refreshing it
 * once on 401) and saves them through an object URL.
 */
export async function downloadExport(manager: SessionManager, path: string, fallbackName: string) {
  const url = `${config.apiUrl}${API_V1_PREFIX}${path}`;
  const send = (token: string | null) =>
    fetch(url, {
      credentials: 'include',
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });

  const token = manager.current?.accessToken ?? null;
  let response = await send(token);
  if (response.status === 401 && token) {
    const fresh = (await manager.refresh())?.accessToken ?? null;
    if (fresh) response = await send(fresh);
  }
  if (!response.ok) {
    const parsed = ApiErrorBody.safeParse(await response.json().catch(() => undefined));
    if (parsed.success) {
      const { code, message, requestId, details } = parsed.data.error;
      throw new ApiClientError(code, message, response.status, requestId, details);
    }
    throw new ApiClientError('INVALID_RESPONSE', 'Could not download the file', response.status);
  }

  const blob = await response.blob();
  const objectUrl = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = objectUrl;
  link.download = fileNameFrom(response.headers.get('Content-Disposition'), fallbackName);
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(objectUrl), 1_000);
}

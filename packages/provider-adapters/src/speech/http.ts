import { AiProviderError } from '@cbi/ai-core';
import { statusOutcome } from '../llm/shared.js';

export type FetchLike = typeof fetch;

/**
 * One speech-provider HTTP call. Failures become AiProviderError with a
 * generic message: provider error bodies can echo input, so only the status
 * is kept. Retries and fallback are the router's job.
 */
export async function speechFetch(
  provider: string,
  url: string,
  init: RequestInit,
  signal: AbortSignal,
  fetchImpl: FetchLike = fetch,
): Promise<Response> {
  let res: Response;
  try {
    res = await fetchImpl(url, { ...init, signal });
  } catch (err) {
    if (signal.aborted) {
      throw new AiProviderError(provider, 'TIMEOUT', 'aborted', 'request aborted or timed out', {
        cause: err,
      });
    }
    throw new AiProviderError(
      provider,
      'NETWORK_ERROR',
      'network',
      'request failed before a response',
      {
        cause: err,
      },
    );
  }
  if (!res.ok) {
    await res.body?.cancel().catch(() => undefined);
    throw new AiProviderError(
      provider,
      statusOutcome(res.status),
      String(res.status),
      `HTTP ${res.status}`,
    );
  }
  return res;
}

/** Response JSON that must parse; a malformed body is a provider error, not a crash. */
export async function speechJson<T>(provider: string, res: Response): Promise<T> {
  try {
    return (await res.json()) as T;
  } catch (err) {
    throw new AiProviderError(provider, 'PROVIDER_ERROR', 'bad_json', 'unreadable response', {
      cause: err,
    });
  }
}

export async function speechBytes(provider: string, res: Response): Promise<Uint8Array> {
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.length === 0) {
    throw new AiProviderError(provider, 'PROVIDER_ERROR', 'empty_audio', 'empty audio response');
  }
  return bytes;
}

/** Container type without codec parameters (`audio/webm;codecs=opus` → `audio/webm`). */
export const baseMime = (mime: string) => mime.split(';')[0]!.trim().toLowerCase();

const EXTENSIONS: Record<string, string> = {
  'audio/webm': 'webm',
  'audio/ogg': 'ogg',
  'audio/mp4': 'm4a',
  'audio/mpeg': 'mp3',
  'audio/wav': 'wav',
};
export const audioExtension = (mime: string) => EXTENSIONS[baseMime(mime)] ?? 'webm';

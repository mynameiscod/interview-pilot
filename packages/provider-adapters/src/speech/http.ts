import { AiProviderError, type SttWord } from '@cbi/ai-core';
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

/**
 * A streamed response body as chunks. A read failure becomes an
 * AiProviderError (the router ends the stream); an empty body fails too.
 */
export async function* speechChunks(provider: string, res: Response): AsyncGenerator<Uint8Array> {
  if (!res.body) {
    throw new AiProviderError(provider, 'PROVIDER_ERROR', 'empty_audio', 'empty audio response');
  }
  const reader = res.body.getReader();
  try {
    for (;;) {
      let step: Awaited<ReturnType<typeof reader.read>>;
      try {
        step = await reader.read();
      } catch (err) {
        throw new AiProviderError(provider, 'NETWORK_ERROR', 'stream', 'audio stream interrupted', {
          cause: err,
        });
      }
      if (step.done) return;
      if (step.value.byteLength > 0) yield step.value;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
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

interface ProviderWord {
  word?: string;
  punctuated_word?: string;
  start?: number;
  end?: number;
}

/** Word timestamps from a provider response, keeping only well-formed entries (null when none). */
export function timedWords(words: readonly ProviderWord[] | undefined | null): SttWord[] | null {
  const valid = (words ?? []).flatMap((w) =>
    typeof w.start === 'number' && typeof w.end === 'number' && w.end >= w.start
      ? [{ word: (w.punctuated_word ?? w.word ?? '').trim(), start: w.start, end: w.end }]
      : [],
  );
  return valid.length ? valid : null;
}

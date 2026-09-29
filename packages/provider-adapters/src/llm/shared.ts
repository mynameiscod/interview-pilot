import { AiProviderError, type ChatMessage } from '@cbi/ai-core';

/** Maps an HTTP status to a router outcome (shared by every adapter). */
export function statusOutcome(status: number): AiProviderError['outcome'] {
  if (status === 429) return 'RATE_LIMITED';
  if (status === 401 || status === 403) return 'AUTH_ERROR';
  if (status === 408 || status === 409 || status >= 500) return 'PROVIDER_ERROR';
  return 'BAD_REQUEST';
}

/** Splits system messages out; the rest keep their order. */
export function splitSystem(messages: readonly ChatMessage[]) {
  const system = messages
    .filter((m) => m.role === 'system')
    .map((m) => m.content)
    .join('\n\n');
  return {
    system: system || undefined,
    turns: messages.filter(
      (m): m is ChatMessage & { role: 'user' | 'assistant' } => m.role !== 'system',
    ),
  };
}

/**
 * Replaces the content of the last user turn with `attach(text)` (OCR puts the
 * document before the instruction text there). Adds a user turn if there is none.
 */
export function attachToLastUser<T>(
  turns: readonly (ChatMessage & { role: 'user' | 'assistant' })[],
  attach: (text: string) => T,
): ({ role: 'user' | 'assistant'; content: string } | { role: 'user'; content: T })[] {
  const last = turns.findLastIndex((m) => m.role === 'user');
  if (last === -1) return [...turns, { role: 'user', content: attach('') }];
  return turns.map((m, i) => (i === last ? { role: 'user' as const, content: attach(m.content) } : m));
}

/** Instruction used when a rendered OCR prompt has no user text. */
export const OCR_DEFAULT_INSTRUCTION = 'Transcribe all text in the attached document.';

/**
 * Converts an SDK or network failure into an AiProviderError. `status` is
 * read from the SDK error when present. Messages stay generic: provider error
 * bodies can echo prompt fragments.
 */
export function toProviderError(
  provider: string,
  err: unknown,
  status: number | undefined,
  signal: AbortSignal,
): AiProviderError {
  if (err instanceof AiProviderError) return err;
  if (signal.aborted) {
    return new AiProviderError(provider, 'TIMEOUT', 'aborted', 'request aborted or timed out', {
      cause: err,
    });
  }
  if (status !== undefined) {
    return new AiProviderError(provider, statusOutcome(status), String(status), `HTTP ${status}`, {
      cause: err,
    });
  }
  return new AiProviderError(
    provider,
    'NETWORK_ERROR',
    'network',
    'request failed before a response',
    { cause: err },
  );
}

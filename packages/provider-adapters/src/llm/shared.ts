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

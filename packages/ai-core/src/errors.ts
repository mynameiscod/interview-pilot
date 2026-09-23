import type { AiCallOutcome, AiFeature } from '@cbi/shared-types';

/** Outcomes worth retrying on the same model after a backoff. */
const RETRYABLE: ReadonlySet<AiCallOutcome> = new Set([
  'TIMEOUT',
  'RATE_LIMITED',
  'PROVIDER_ERROR',
  'NETWORK_ERROR',
]);

/** Outcomes that count against the model's circuit breaker. */
const BREAKER_FAILURES: ReadonlySet<AiCallOutcome> = new Set([
  'TIMEOUT',
  'RATE_LIMITED',
  'PROVIDER_ERROR',
  'NETWORK_ERROR',
  'AUTH_ERROR',
]);

export const isRetryableOutcome = (o: AiCallOutcome) => RETRYABLE.has(o);
export const countsAgainstBreaker = (o: AiCallOutcome) => BREAKER_FAILURES.has(o);

/**
 * A provider call failed. `code` is a short provider-specific identifier (an
 * HTTP status or error type). Messages must never contain prompts, outputs or
 * credentials: they are logged and stored.
 */
export class AiProviderError extends Error {
  constructor(
    public readonly provider: string,
    public readonly outcome: Exclude<AiCallOutcome, 'SUCCESS'>,
    public readonly code: string,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(`${provider}: ${message}`, options);
    this.name = 'AiProviderError';
  }

  get retryable(): boolean {
    return isRetryableOutcome(this.outcome);
  }
}

export interface AttemptSummary {
  modelRef: string;
  model: string;
  outcome: AiCallOutcome | 'SKIPPED';
  /** Why a model was skipped, or the provider error code. */
  detail: string | null;
}

/**
 * Every model in the route failed, was skipped or none is configured. The
 * router never substitutes a fake answer: callers must surface this.
 */
export class AiUnavailableError extends Error {
  constructor(
    public readonly feature: AiFeature,
    public readonly attempts: AttemptSummary[],
    message = `No AI model could serve ${feature}`,
  ) {
    super(message);
    this.name = 'AiUnavailableError';
  }
}

/** The caller aborted (e.g. the candidate left); no fallback is attempted. */
export class AiAbortedError extends Error {
  constructor(public readonly feature: AiFeature) {
    super(`AI call for ${feature} was aborted`);
    this.name = 'AiAbortedError';
  }
}

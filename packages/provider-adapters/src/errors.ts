/**
 * Raised when an external provider fails. Messages must never contain
 * credentials, OTP codes or message bodies; they are logged.
 */
export class ProviderError extends Error {
  constructor(
    public readonly provider: string,
    message: string,
    public readonly retryable: boolean,
    options?: { cause?: unknown },
  ) {
    super(`${provider}: ${message}`, options);
    this.name = 'ProviderError';
  }
}

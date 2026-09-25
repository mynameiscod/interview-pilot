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

/**
 * The integration (email, payments, storage, SMS, judge) has no usable
 * configuration yet: an admin sets it up in System → Integrations.
 */
export class NotConfiguredError extends ProviderError {
  constructor(public readonly kind: string) {
    super(kind, 'not configured', false);
    this.name = 'NotConfiguredError';
  }
}

import { ApiClientError } from '../api-client';
import type { TFunction } from 'i18next';

/**
 * Turns an API error into a translated, actionable message. Unknown errors
 * fall back to a generic message; server text is never shown raw because it
 * is English-only.
 */
export function errorMessage(t: TFunction, err: unknown): string {
  if (!(err instanceof ApiClientError)) return t('errors.generic');
  const details = (err.details ?? {}) as { remainingAttempts?: number; retryAfterSec?: number };
  switch (err.code) {
    case 'NETWORK_ERROR':
      return t('errors.network');
    case 'OTP_INVALID':
      return typeof details.remainingAttempts === 'number'
        ? t('errors.otpInvalidRemaining', { count: details.remainingAttempts })
        : t('errors.otpInvalid');
    case 'OTP_EXPIRED':
      return t('errors.otpExpired');
    case 'OTP_TOO_MANY_ATTEMPTS':
      return t('errors.otpTooManyAttempts');
    case 'OTP_COOLDOWN':
      return t('errors.otpCooldown', { seconds: details.retryAfterSec ?? 30 });
    case 'RATE_LIMITED':
      return t('errors.rateLimited');
    case 'PROVIDER_UNAVAILABLE':
      return t('errors.providerUnavailable');
    case 'FEATURE_DISABLED':
      return t('errors.featureDisabled');
    case 'IDENTITY_IN_USE':
      return t('errors.identityInUse');
    case 'ACCOUNT_SUSPENDED':
      return t('errors.accountSuspended');
    case 'VALIDATION_FAILED':
      return t('errors.validation');
    case 'UNAUTHENTICATED':
      return t('errors.sessionEnded');
    default:
      return t('errors.generic');
  }
}

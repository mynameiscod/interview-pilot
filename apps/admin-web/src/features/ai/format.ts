import { MICROS_PER_UNIT } from '@cbi/shared-types';
import { ApiClientError, errorMessage } from '@cbi/web-core';
import type { TFunction } from 'i18next';

/**
 * Money arrives as integer micro-units. Sub-cent amounts keep up to six
 * decimals so a single call's cost stays visible.
 */
export function formatMicros(micros: number, currency: string, locale: string): string {
  const amount = micros / MICROS_PER_UNIT;
  const small = micros !== 0 && Math.abs(micros) < 10_000;
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: small ? 6 : 2,
  }).format(amount);
}

/** Micro-units back to the decimal string the price form accepts. */
export const microsToDecimal = (micros: number) =>
  (micros / MICROS_PER_UNIT).toFixed(6).replace(/\.?0+$/, '');

/**
 * The admin console is English-only, so for validation and conflict errors
 * the server's specific message is more useful than a generic one.
 */
export function consoleError(t: TFunction, err: unknown): string {
  if (
    err instanceof ApiClientError &&
    (err.code === 'CONFLICT' ||
      err.code === 'NOT_FOUND' ||
      err.code === 'AI_UNAVAILABLE' ||
      (err.code === 'VALIDATION_FAILED' && err.message !== 'Request validation failed'))
  ) {
    return err.message;
  }
  return errorMessage(t, err);
}

/**
 * A readable provider name for a key. Unknown keys (a provider added on the
 * server before this console) fall back to the server's display name, then
 * to a capitalised key, never an i18n path.
 */
export function providerName(t: TFunction, key: string, displayName?: string): string {
  const fallback = displayName ?? key.charAt(0).toUpperCase() + key.slice(1);
  return t(`ai.providerNames.${key}`, { defaultValue: fallback });
}

/** A readable name for a routed feature (the raw key stays visible beside it). */
export function featureName(t: TFunction, feature: string): string {
  return t(`ai.features.${feature.replace('.', '_')}`, { defaultValue: '' });
}

/** Features whose calls are metered in audio or characters rather than tokens. */
export const SPEECH_FEATURES: ReadonlySet<string> = new Set(['stt.live', 'tts.live']);

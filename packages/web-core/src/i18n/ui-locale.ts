import { UiLocale } from '@cbi/shared-types';

/**
 * Maps an i18next language (e.g. `i18n.resolvedLanguage`, possibly `hi-IN`)
 * to a supported UI locale, or undefined when it is not one. Sent as `lang`
 * on OTP requests so the code email/SMS matches the UI language.
 */
export function toUiLocale(language: string | undefined | null): UiLocale | undefined {
  if (!language) return undefined;
  const parsed = UiLocale.safeParse(language.toLowerCase().split('-')[0]);
  return parsed.success ? parsed.data : undefined;
}

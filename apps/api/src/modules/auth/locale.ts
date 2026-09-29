import { DEFAULT_UI_LOCALE, UiLocale } from '@cbi/shared-types';

const SUPPORTED = new Set<string>(UiLocale.options);

/**
 * Picks the first supported UI locale from an Accept-Language header, by
 * q-value (ties keep header order). Region subtags match their language
 * (`hi-IN` → `hi`); `*` and q=0 entries are ignored. Returns null when nothing
 * supported is listed.
 */
export function pickLocale(header: string | string[] | undefined | null): UiLocale | null {
  if (!header) return null;
  const raw = Array.isArray(header) ? header.join(',') : header;
  const candidates = raw
    .slice(0, 1024)
    .split(',')
    .map((part, index) => {
      const [tag = '', ...params] = part.trim().split(';');
      let q = 1;
      for (const param of params) {
        const [key, value] = param.trim().split('=');
        if (key?.trim().toLowerCase() === 'q') {
          const parsed = Number(value);
          q = Number.isFinite(parsed) ? parsed : 0;
        }
      }
      const lang = tag.trim().toLowerCase().split('-')[0] ?? '';
      return { lang, q, index };
    })
    .filter((c) => c.q > 0 && SUPPORTED.has(c.lang))
    .sort((a, b) => b.q - a.q || a.index - b.index);
  return (candidates[0]?.lang as UiLocale | undefined) ?? null;
}

/**
 * Language for OTP messages: the explicit request field, then the stored
 * preference (none exists yet: users only store an interview language, which
 * is a separate setting), then Accept-Language, then English.
 */
export function resolveMessageLocale(input: {
  requested?: UiLocale;
  acceptLanguage?: string | string[] | null;
}): UiLocale {
  return input.requested ?? pickLocale(input.acceptLanguage) ?? DEFAULT_UI_LOCALE;
}

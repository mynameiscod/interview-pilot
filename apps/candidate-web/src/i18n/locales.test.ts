import { describe, expect, it } from 'vitest';
import { initI18n, localeLoaders, SUPPORTED_LOCALES } from './index';
import en from './locales/en/common.json';
import hi from './locales/hi/common.json';
import te from './locales/te/common.json';

const bundles = { en, hi, te } as const;

function flattenKeys(obj: object, prefix = ''): string[] {
  return Object.entries(obj).flatMap(([key, value]) =>
    value && typeof value === 'object'
      ? flattenKeys(value as object, `${prefix}${key}.`)
      : [`${prefix}${key}`],
  );
}

describe('UI translations', () => {
  const englishKeys = flattenKeys(en).sort();

  it('registers a loader and a bundle for every supported locale', () => {
    expect(Object.keys(localeLoaders).sort()).toEqual([...SUPPORTED_LOCALES].sort());
    expect(Object.keys(bundles).sort()).toEqual([...SUPPORTED_LOCALES].sort());
  });

  it.each(SUPPORTED_LOCALES.filter((l) => l !== 'en'))(
    '%s has exactly the same keys as English',
    (lng) => {
      expect(flattenKeys(bundles[lng]).sort()).toEqual(englishKeys);
    },
  );

  it.each(SUPPORTED_LOCALES)('%s has no empty strings', (lng) => {
    const values = JSON.stringify(bundles[lng]);
    expect(values).not.toMatch(/:""/);
  });

  it('loads a non-English bundle only when that language is chosen', async () => {
    const i18n = await initI18n({ detect: false, lng: 'en' });
    expect(i18n.hasResourceBundle('te', 'common')).toBe(false);
    await i18n.changeLanguage('te');
    expect(i18n.hasResourceBundle('te', 'common')).toBe(true);
    expect(i18n.t('landing.hero.getStarted')).toBe(te.landing.hero.getStarted);
    expect(document.documentElement.lang).toBe('te');
  });
});

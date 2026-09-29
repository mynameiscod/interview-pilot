import { describe, expect, it } from 'vitest';
import { initI18n, legalLoaders, localeLoaders, SUPPORTED_LOCALES } from './index';
import en from './locales/en/common.json';
import enLegal from './locales/en/legal.json';
import hi from './locales/hi/common.json';
import hiLegal from './locales/hi/legal.json';
import te from './locales/te/common.json';
import teLegal from './locales/te/legal.json';

const resources = {
  en: { common: en, legal: enLegal },
  hi: { common: hi, legal: hiLegal },
  te: { common: te, legal: teLegal },
} as const;

function flattenKeys(obj: object, prefix = ''): string[] {
  return Object.entries(obj).flatMap(([key, value]) =>
    value && typeof value === 'object'
      ? flattenKeys(value as object, `${prefix}${key}.`)
      : [`${prefix}${key}`],
  );
}

const placeholders = (text: string) =>
  [...text.matchAll(/{{\s*(\w+)\s*}}/g)].map((m) => m[1]).sort();

function flattenValues(obj: object, prefix = ''): [string, string][] {
  return Object.entries(obj).flatMap(([key, value]) =>
    value && typeof value === 'object'
      ? flattenValues(value as object, `${prefix}${key}.`)
      : [[`${prefix}${key}`, String(value)] as [string, string]],
  );
}

describe.each(['common', 'legal'] as const)('UI translations (%s)', (ns) => {
  const englishKeys = flattenKeys(resources.en[ns]).sort();

  it('registers a loader and a bundle for every supported locale', () => {
    const loaders = ns === 'common' ? localeLoaders : legalLoaders;
    expect(Object.keys(loaders).sort()).toEqual([...SUPPORTED_LOCALES].sort());
    expect(Object.keys(resources).sort()).toEqual([...SUPPORTED_LOCALES].sort());
  });

  it.each(SUPPORTED_LOCALES.filter((l) => l !== 'en'))(
    '%s has exactly the same keys as English',
    (lng) => {
      expect(flattenKeys(resources[lng][ns]).sort()).toEqual(englishKeys);
    },
  );

  it.each(SUPPORTED_LOCALES)('%s has no empty strings', (lng) => {
    const values = JSON.stringify(resources[lng][ns]);
    expect(values).not.toMatch(/:""/);
  });

  it.each(SUPPORTED_LOCALES.filter((l) => l !== 'en'))(
    '%s uses the same placeholders as English',
    (lng) => {
      const english = new Map(flattenValues(resources.en[ns]));
      for (const [key, value] of flattenValues(resources[lng][ns])) {
        expect([key, placeholders(value)]).toEqual([key, placeholders(english.get(key) ?? '')]);
      }
    },
  );
});

describe('lazy loading', () => {
  it('loads a non-English bundle only when that language is chosen', async () => {
    const i18n = await initI18n({ detect: false, lng: 'en' });
    expect(i18n.hasResourceBundle('te', 'common')).toBe(false);
    await i18n.changeLanguage('te');
    expect(i18n.hasResourceBundle('te', 'common')).toBe(true);
    expect(i18n.t('landing.hero.getStarted')).toBe(te.landing.hero.getStarted);
    expect(document.documentElement.lang).toBe('te');
  });

  it('loads the legal texts only when a legal page asks for them', async () => {
    const i18n = await initI18n({ detect: false, lng: 'hi' });
    expect(i18n.hasResourceBundle('hi', 'legal')).toBe(false);
    await i18n.loadNamespaces('legal');
    expect(i18n.hasResourceBundle('hi', 'legal')).toBe(true);
    expect(i18n.t('terms.title', { ns: 'legal' })).toBe(hiLegal.terms.title);
  });
});

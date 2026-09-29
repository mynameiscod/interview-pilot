import { DEFAULT_UI_LOCALE, UiLocale } from '@cbi/shared-types';
import i18n, { type BackendModule, type ResourceKey } from 'i18next';
import LanguageDetector from 'i18next-browser-languagedetector';
import { initReactI18next } from 'react-i18next';
import en from './locales/en/common.json';

export const SUPPORTED_LOCALES = UiLocale.options;

type Bundle = () => Promise<{ default: ResourceKey }>;

/**
 * English UI strings ship in the main bundle (they are the default and the
 * fallback); the other languages are separate chunks fetched only when chosen,
 * which keeps ~250 KB of Hindi/Telugu copy out of the first load.
 */
export const localeLoaders: Record<UiLocale, Bundle> = {
  en: async () => ({ default: en }),
  hi: () => import('./locales/hi/common.json'),
  te: () => import('./locales/te/common.json'),
};

/** The long legal texts are only needed on the legal pages, in every language. */
export const legalLoaders: Record<UiLocale, Bundle> = {
  en: () => import('./locales/en/legal.json'),
  hi: () => import('./locales/hi/legal.json'),
  te: () => import('./locales/te/legal.json'),
};

const namespaceLoaders: Record<string, Record<UiLocale, Bundle>> = {
  common: localeLoaders,
  legal: legalLoaders,
};

/** i18next backend that resolves bundles through the loaders above. */
export const lazyLocaleBackend: BackendModule = {
  type: 'backend',
  init: () => undefined,
  read(lng, ns, callback) {
    const parsed = UiLocale.safeParse(lng);
    const loaders = namespaceLoaders[ns];
    if (!parsed.success || !loaders) return callback(null, {});
    // A failed chunk load (e.g. offline) leaves the English fallback in place.
    loaders[parsed.data]().then(
      (mod) => callback(null, mod.default),
      (err: Error) => callback(err, false),
    );
  },
};

/**
 * UI strings live only in locales/<lng>/common.json; the long legal texts
 * (Terms, Privacy Notice, Grievance, How AI scoring works) in legal.json. Adding
 * a language means adding the JSON files and registering them in the loaders
 * above and in `UiLocale`; no component changes. Te/Hi copy requires
 * native-speaker review before launch.
 */
export async function initI18n(opts: { detect?: boolean; lng?: UiLocale } = {}) {
  const instance = i18n.createInstance();
  if (opts.detect !== false) instance.use(LanguageDetector);
  await instance
    .use(lazyLocaleBackend)
    .use(initReactI18next)
    .init({
      // Bundled English UI strings plus the backend for everything else.
      resources: { en: { common: en } },
      partialBundledLanguages: true,
      lng: opts.lng,
      fallbackLng: DEFAULT_UI_LOCALE,
      supportedLngs: SUPPORTED_LOCALES,
      nonExplicitSupportedLngs: true,
      defaultNS: 'common',
      ns: ['common'],
      interpolation: { escapeValue: false }, // React already escapes output.
      detection: {
        order: ['localStorage', 'navigator'],
        lookupLocalStorage: 'cbi.locale',
        caches: ['localStorage'],
      },
      returnNull: false,
    });

  const syncHtmlLang = (lng: string) => {
    if (typeof document !== 'undefined') document.documentElement.lang = lng;
  };
  syncHtmlLang(instance.resolvedLanguage ?? DEFAULT_UI_LOCALE);
  instance.on('languageChanged', syncHtmlLang);
  return instance;
}

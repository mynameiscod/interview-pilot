import { DEFAULT_UI_LOCALE, UiLocale } from '@cbi/shared-types';
import i18n, { type BackendModule, type ResourceKey } from 'i18next';
import LanguageDetector from 'i18next-browser-languagedetector';
import { initReactI18next } from 'react-i18next';
import en from './locales/en/common.json';

export const SUPPORTED_LOCALES = UiLocale.options;

/**
 * English ships in the main bundle (it is the default and the fallback); the
 * other languages are separate chunks fetched only when chosen, which keeps
 * ~250 KB of Hindi/Telugu copy out of the first load.
 */
export const localeLoaders: Record<UiLocale, () => Promise<{ default: ResourceKey }>> = {
  en: async () => ({ default: en }),
  hi: () => import('./locales/hi/common.json'),
  te: () => import('./locales/te/common.json'),
};

/** i18next backend that resolves `common` bundles through `localeLoaders`. */
export const lazyLocaleBackend: BackendModule = {
  type: 'backend',
  init: () => undefined,
  read(lng, _ns, callback) {
    const parsed = UiLocale.safeParse(lng);
    if (!parsed.success) return callback(null, {});
    // A failed chunk load (e.g. offline) leaves the English fallback in place.
    localeLoaders[parsed.data]().then(
      (mod) => callback(null, mod.default),
      (err: Error) => callback(err, false),
    );
  },
};

/**
 * UI strings live only in locales/<lng>/common.json. Adding a language means
 * adding a JSON file and registering it in `localeLoaders` and in `UiLocale`;
 * no component changes. Te/Hi copy requires native-speaker review before launch.
 */
export async function initI18n(opts: { detect?: boolean; lng?: UiLocale } = {}) {
  const instance = i18n.createInstance();
  if (opts.detect !== false) instance.use(LanguageDetector);
  await instance
    .use(lazyLocaleBackend)
    .use(initReactI18next)
    .init({
      // Bundled English plus the backend for everything else.
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

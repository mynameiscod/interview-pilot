import { DEFAULT_UI_LOCALE, UiLocale } from '@cbi/shared-types';
import i18n from 'i18next';
import LanguageDetector from 'i18next-browser-languagedetector';
import { initReactI18next } from 'react-i18next';
import en from './locales/en/common.json';
import enLegal from './locales/en/legal.json';
import hi from './locales/hi/common.json';
import hiLegal from './locales/hi/legal.json';
import te from './locales/te/common.json';
import teLegal from './locales/te/legal.json';

export const SUPPORTED_LOCALES = UiLocale.options;

export const resources = {
  en: { common: en, legal: enLegal },
  te: { common: te, legal: teLegal },
  hi: { common: hi, legal: hiLegal },
} as const;

/**
 * UI strings live only in locales/<lng>/common.json; the long legal texts
 * (Terms, Privacy Notice, Grievance, How AI scoring works) in legal.json. Adding a language means
 * adding a JSON file and registering it here and in `UiLocale`; no component
 * changes. Te/Hi copy requires native-speaker review before launch.
 */
export async function initI18n(opts: { detect?: boolean; lng?: UiLocale } = {}) {
  const instance = i18n.createInstance();
  if (opts.detect !== false) instance.use(LanguageDetector);
  await instance.use(initReactI18next).init({
    resources,
    lng: opts.lng,
    fallbackLng: DEFAULT_UI_LOCALE,
    supportedLngs: SUPPORTED_LOCALES,
    nonExplicitSupportedLngs: true,
    defaultNS: 'common',
    ns: ['common', 'legal'],
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

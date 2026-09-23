import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import en from './locales/en/common.json';

export const resources = { en: { common: en } } as const;

/** The admin console ships in English; strings still live in locale files. */
export async function initI18n() {
  const instance = i18n.createInstance();
  await instance.use(initReactI18next).init({
    resources,
    lng: 'en',
    fallbackLng: 'en',
    defaultNS: 'common',
    ns: ['common'],
    interpolation: { escapeValue: false },
    returnNull: false,
  });
  return instance;
}

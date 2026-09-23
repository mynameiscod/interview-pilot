import { useTranslation } from 'react-i18next';

export function UnsupportedBrowser() {
  const { t } = useTranslation();
  return (
    <main className="container py-5" role="alert">
      <h1 className="h3">
        <i className="bi bi-exclamation-triangle me-2" aria-hidden="true" />
        {t('unsupported.title')}
      </h1>
      <p className="cb-text-secondary">{t('unsupported.body')}</p>
    </main>
  );
}

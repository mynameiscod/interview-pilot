import { useTranslation } from 'react-i18next';

export function DashboardPage() {
  const { t } = useTranslation();
  return (
    <>
      <h1 className="h3 mb-4">{t('dashboard.title')}</h1>
      <div className="p-4 border cb-border rounded-3 bg-white">
        <h2 className="h5">
          <i className="bi bi-info-circle me-2 text-secondary" aria-hidden="true" />
          {t('dashboard.emptyTitle')}
        </h2>
        <p className="cb-text-secondary mb-0">{t('dashboard.emptyBody')}</p>
      </div>
    </>
  );
}

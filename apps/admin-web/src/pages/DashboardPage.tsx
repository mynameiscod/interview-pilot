import { useTranslation } from 'react-i18next';
import { useAdminAuth, useCan } from '../app/session';
import { AnalyticsDashboard } from '../features/analytics/AnalyticsDashboard';

export function DashboardPage() {
  const { t } = useTranslation();
  const { user } = useAdminAuth();
  const canSeeAnalytics = useCan('analytics.read');
  return (
    <>
      <h1 className="h3 mb-2">{t('dashboard.title')}</h1>
      <p className="cb-text-secondary">
        {t('dashboard.signedInAs', {
          email: user?.email,
          roles: user?.adminRoles.map((role) => t(`roles.${role}`)).join(', '),
        })}
      </p>
      {canSeeAnalytics ? (
        <AnalyticsDashboard />
      ) : (
        <div className="p-4 border cb-border rounded-3 bg-white">
          <h2 className="h5">
            <i className="bi bi-info-circle me-2 text-secondary" aria-hidden="true" />
            {t('dashboard.emptyTitle')}
          </h2>
          <p className="cb-text-secondary mb-0">{t('dashboard.emptyBody')}</p>
        </div>
      )}
    </>
  );
}

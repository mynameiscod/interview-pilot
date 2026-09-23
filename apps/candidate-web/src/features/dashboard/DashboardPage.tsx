import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { useCandidateAuth } from '../../app/session';

export function DashboardPage() {
  const { t } = useTranslation();
  const { user } = useCandidateAuth();
  if (!user) return null;

  return (
    <div className="container py-5">
      <h1 className="h3">{t('dashboard.greeting', { name: user.profile.displayName })}</h1>
      <p className="cb-text-secondary">{t('dashboard.subtitle')}</p>
      <div className="p-4 border cb-border rounded-3 bg-white mt-4">
        <h2 className="h5">
          <i className="bi bi-hourglass-split me-2 text-secondary" aria-hidden="true" />
          {t('dashboard.nextTitle')}
        </h2>
        <p className="cb-text-secondary">{t('dashboard.nextBody')}</p>
        <Link to="/app/profile" className="btn btn-outline-primary">
          {t('dashboard.profileLink')}
        </Link>
      </div>
    </div>
  );
}

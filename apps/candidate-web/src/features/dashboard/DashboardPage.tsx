import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { useCandidateAuth } from '../../app/session';
import { RecentInterviews } from '../interviews/RecentInterviews';
import { CreditsCard } from './CreditsCard';

export function DashboardPage() {
  const { t } = useTranslation();
  const { user } = useCandidateAuth();
  if (!user) return null;

  return (
    <div className="container py-5">
      <h1 className="h3">{t('dashboard.greeting', { name: user.profile.displayName })}</h1>
      <p className="cb-text-secondary">{t('dashboard.subtitle')}</p>
      <div className="row g-4 mt-1">
        <div className="col-lg-5 d-flex flex-column gap-4">
          <section
            className="p-4 border cb-border rounded-3 bg-white"
            aria-labelledby="start-title"
          >
            <h2 id="start-title" className="h5">
              <i className="bi bi-play-circle me-2 text-secondary" aria-hidden="true" />
              {t('dashboard.startTitle')}
            </h2>
            <p className="cb-text-secondary">{t('dashboard.startBody')}</p>
            <div className="d-flex flex-wrap gap-2">
              <Link to="/app/new" className="btn btn-primary">
                {t('dashboard.startCta')}
              </Link>
              <Link to="/app/profile" className="btn btn-outline-primary">
                {t('dashboard.profileLink')}
              </Link>
            </div>
          </section>
          <CreditsCard />
        </div>
        <div className="col-lg-7">
          <RecentInterviews />
        </div>
      </div>
    </div>
  );
}

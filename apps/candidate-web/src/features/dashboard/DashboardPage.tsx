import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { useCandidateAuth } from '../../app/session';
import { RecentInterviews } from '../interviews/RecentInterviews';
import { CreditsCard } from './CreditsCard';
import './dashboard.scss';

const FEATURES = [
  { key: 'dashboard.features.roleSpecific', icon: 'bi-shield-check' },
  { key: 'dashboard.features.realistic', icon: 'bi-people' },
  { key: 'dashboard.features.feedback', icon: 'bi-person-check' },
] as const;

/** Round types a candidate can practise; names come from analysis.roundTypes. */
const AREAS = [
  { type: 'TECHNICAL', icon: 'bi-code-slash' },
  { type: 'PROBLEM_SOLVING', icon: 'bi-diagram-3' },
  { type: 'CODING', icon: 'bi-terminal' },
  { type: 'BEHAVIORAL', icon: 'bi-chat-square-text' },
] as const;

function Hero({ name }: { name: string }) {
  const { t } = useTranslation();
  return (
    <div className="row g-4 align-items-stretch">
      <div className="col-lg-7 d-flex flex-column justify-content-center">
        <p className="cb-dash-eyebrow mb-2">{t('dashboard.eyebrow')}</p>
        <h1 className="cb-dash-greeting display-6 mb-2">
          {t('dashboard.greeting', { name })} <span aria-hidden="true">👋</span>
        </h1>
        <p className="fs-5 mb-1">{t('dashboard.subtitle')}</p>
        <p className="cb-text-secondary">{t('dashboard.tagline')}</p>
        <ul className="list-unstyled d-flex flex-wrap gap-3 gap-xl-4 mt-2 mb-0">
          {FEATURES.map((f) => (
            <li key={f.key} className="d-flex align-items-center gap-2">
              <span className="cb-icon-tile cb-icon-tile--sm cb-icon-tile--round">
                <i className={`bi ${f.icon}`} aria-hidden="true" />
              </span>
              <span className="small">{t(f.key)}</span>
            </li>
          ))}
        </ul>
      </div>
      <div className="col-lg-5">
        <div className="cb-dash-visual h-100 d-flex flex-column flex-sm-row align-items-sm-center gap-4">
          <div className="cb-dash-visual-card flex-grow-1">
            <p className="small fw-semibold cb-text-secondary mb-2">
              {t('dashboard.coverageTitle')}
            </p>
            <ul className="list-unstyled mb-0 d-flex flex-column gap-2">
              {AREAS.map((a) => (
                <li key={a.type} className="d-flex align-items-center gap-2">
                  <i className="bi bi-check-circle-fill text-secondary" aria-hidden="true" />
                  {t(`analysis.roundTypes.${a.type}`)}
                </li>
              ))}
            </ul>
          </div>
          <p className="cb-dash-slogan d-flex flex-sm-column gap-2 gap-sm-0 flex-wrap mb-0">
            <span>{t('dashboard.slogan.practise')}</span>
            <span>{t('dashboard.slogan.improve')}</span>
            <span>{t('dashboard.slogan.hired')}</span>
          </p>
        </div>
      </div>
    </div>
  );
}

function StartCard() {
  const { t } = useTranslation();
  return (
    <section className="cb-dash-start" aria-labelledby="start-title">
      <div className="d-flex gap-3 align-items-start">
        <span className="cb-dash-play" aria-hidden="true">
          <i className="bi bi-play-fill" />
        </span>
        <div>
          <h2 id="start-title" className="h4 mb-2">
            {t('dashboard.startTitle')}
          </h2>
          <p className="cb-dash-start-body mb-4">{t('dashboard.startBody')}</p>
          <div className="d-flex flex-wrap gap-2">
            <Link to="/app/new" className="btn btn-light fw-semibold px-4">
              {t('dashboard.startCta')}
              <i className="bi bi-arrow-right ms-2" aria-hidden="true" />
            </Link>
            <Link to="/app/profile" className="btn btn-outline-light px-4">
              <i className="bi bi-person me-2" aria-hidden="true" />
              {t('dashboard.profileLink')}
            </Link>
          </div>
        </div>
      </div>
    </section>
  );
}

function PracticeAreas() {
  const { t } = useTranslation();
  return (
    <section className="cb-dash-card" aria-labelledby="areas-title">
      <div className="d-flex flex-wrap align-items-center justify-content-between gap-2 mb-3">
        <h2 id="areas-title" className="h5 mb-0 d-flex align-items-center gap-2">
          <i className="bi bi-bullseye text-secondary" aria-hidden="true" />
          {t('dashboard.practiseTitle')}
        </h2>
        <Link to="/app/new" className="link-secondary text-decoration-none small fw-semibold">
          {t('dashboard.practiseCta')}
          <i className="bi bi-arrow-right ms-1" aria-hidden="true" />
        </Link>
      </div>
      <ul className="row row-cols-2 row-cols-xl-4 g-3 list-unstyled mb-0">
        {AREAS.map((a, i) => (
          <li key={a.type} className="col">
            <div className="cb-area-tile">
              <span
                className={`cb-icon-tile cb-icon-tile--sm mb-2 ${i % 2 ? 'cb-icon-tile--primary' : ''}`}
              >
                <i className={`bi ${a.icon}`} aria-hidden="true" />
              </span>
              <div className="fw-semibold small">{t(`analysis.roundTypes.${a.type}`)}</div>
              <div className="small cb-text-secondary">{t(`dashboard.areas.${a.type}`)}</div>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function DashboardPage() {
  const { t } = useTranslation();
  const { user } = useCandidateAuth();
  if (!user) return null;

  return (
    <div className="container-xxl px-3 px-lg-4 py-4 py-lg-5">
      <Hero name={user.profile.displayName ?? ''} />
      <div className="row g-4 mt-1">
        <div className="col-xl-6 d-flex flex-column gap-4">
          <StartCard />
          <CreditsCard />
        </div>
        <div className="col-xl-6 d-flex flex-column gap-4">
          <RecentInterviews />
          <PracticeAreas />
        </div>
      </div>
      <aside className="cb-dash-tip d-flex align-items-center gap-3 mt-4">
        <i className="bi bi-lightbulb fs-4 text-secondary" aria-hidden="true" />
        <p className="mb-0 small">
          <span className="fw-semibold">{t('dashboard.tipLabel')}: </span>
          {t('dashboard.tip')}
        </p>
      </aside>
    </div>
  );
}

import type { ProgressOverview } from '@cbi/shared-types';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { useCandidateAuth } from '../../app/session';
import { formatDate } from '../interviews/messages';
import { RecentInterviews } from '../interviews/RecentInterviews';
import { BadgesCard } from '../progress/BadgesCard';
import { DimensionCard } from '../progress/DimensionCard';
import { PlanChecklist } from '../progress/PlanChecklist';
import { useProgress } from '../progress/progress-api';
import { areaLink, drillPath, PRACTICE_AREAS, signed, weakest } from '../progress/progress-format';
import { ReadinessCard } from '../progress/ReadinessCard';
import { StreakGoalCard } from '../progress/StreakGoalCard';
import '../progress/progress.scss';
import { CreditsCard } from './CreditsCard';
import './dashboard.scss';

/** Greeting, the readiness headline and the two ways to practise. */
function Hero({ name, progress }: { name: string; progress: ProgressOverview | undefined }) {
  const { t } = useTranslation();
  const latest = progress?.readiness.latest ?? null;
  const delta = progress?.readiness.delta ?? null;
  const focus = progress ? weakest(progress.dimensions)[0] : undefined;
  const drills = progress?.drills;
  const drillHintId = 'quick-drill-hint';
  return (
    <header className="cb-hub-hero row g-3 align-items-center">
      <div className="col-lg-7">
        <p className="cb-dash-eyebrow mb-2">{t('dashboard.eyebrow')}</p>
        <h1 className="cb-dash-greeting display-6 mb-2">{t('dashboard.greeting', { name })}</h1>
        {latest ? (
          <p className="fs-5 mb-0">
            {latest.overall === null
              ? t('progress.hero.noScore', { band: t(`report.band.${latest.band}`) })
              : t('progress.hero.readiness', {
                  score: latest.overall,
                  band: t(`report.band.${latest.band}`),
                })}
            {delta !== null && (
              <span
                className={`ms-2 badge ${delta >= 0 ? 'text-bg-success' : 'text-bg-light border cb-border'}`}
              >
                {t('progress.hero.delta', { change: signed(delta) })}
              </span>
            )}
          </p>
        ) : (
          <p className="fs-5 mb-0">{t('dashboard.subtitle')}</p>
        )}
      </div>
      <div className="col-lg-5">
        <div className="d-flex flex-wrap gap-2 justify-content-lg-end">
          <Link to="/app/new" className="btn btn-primary fw-semibold px-4">
            <i className="bi bi-play-fill me-1" aria-hidden="true" />
            {t('dashboard.startCta')}
          </Link>
          {focus ? (
            <Link
              to={drillPath(focus.key)}
              className="btn btn-outline-primary px-4"
              aria-describedby={drillHintId}
            >
              <i className="bi bi-lightning-charge me-1" aria-hidden="true" />
              {t('progress.hero.quickDrill')}
            </Link>
          ) : (
            <button
              type="button"
              className="btn btn-outline-primary px-4"
              disabled
              aria-describedby={drillHintId}
            >
              <i className="bi bi-lightning-charge me-1" aria-hidden="true" />
              {t('progress.hero.quickDrill')}
            </button>
          )}
        </div>
        <p id={drillHintId} className="small cb-text-secondary text-lg-end mt-2 mb-0">
          {!focus
            ? t('progress.hero.drillNeedsInterview')
            : drills && drills.freePerDay > 0
              ? t('progress.hero.drillOn', {
                  name: focus.name,
                  left: drills.remainingToday,
                  total: drills.freePerDay,
                })
              : t('progress.hero.drillsOff')}
        </p>
      </div>
    </header>
  );
}

/** First visit: what the hub will show and how to get there. */
function EmptyState() {
  const { t } = useTranslation();
  const steps = ['inputs', 'interview', 'practise'] as const;
  return (
    <section className="cb-dash-start" aria-labelledby="empty-title">
      <h2 id="empty-title" className="h4 mb-2">
        {t('progress.empty.title')}
      </h2>
      <p className="cb-dash-start-body mb-3">{t('progress.empty.body')}</p>
      <ol className="cb-hub-steps list-unstyled d-flex flex-column flex-md-row gap-3 mb-4">
        {steps.map((step, i) => (
          <li key={step} className="d-flex gap-2 align-items-start flex-fill">
            <span className="cb-hub-step-number" aria-hidden="true">
              {i + 1}
            </span>
            <span>
              <span className="fw-semibold d-block">{t(`progress.empty.steps.${step}.title`)}</span>
              <span className="small cb-dash-start-body">
                {t(`progress.empty.steps.${step}.body`)}
              </span>
            </span>
          </li>
        ))}
      </ol>
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
    </section>
  );
}

/** "What you can practise": each tile drills the weakest skill in that area, or starts an interview. */
function PracticeAreas({ progress }: { progress: ProgressOverview | undefined }) {
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
        {PRACTICE_AREAS.map((a, i) => {
          const link = areaLink(a.categories, progress);
          return (
            <li key={a.type} className="col">
              <Link to={link.to} className="cb-area-tile cb-area-tile--link d-block">
                <span
                  className={`cb-icon-tile cb-icon-tile--sm mb-2 ${i % 2 ? 'cb-icon-tile--primary' : ''}`}
                  aria-hidden="true"
                >
                  <i className={`bi ${a.icon}`} />
                </span>
                <span className="fw-semibold small d-block">
                  {t(`analysis.roundTypes.${a.type}`)}
                </span>
                <span className="small cb-text-secondary d-block">
                  {link.dimension
                    ? t('progress.areas.drill', { name: link.dimension.name })
                    : t(`dashboard.areas.${a.type}`)}
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function RecentDrills({ progress }: { progress: ProgressOverview }) {
  const { t, i18n } = useTranslation();
  if (progress.recentDrills.length === 0) return null;
  return (
    <section className="cb-dash-card" aria-labelledby="drills-title">
      <h2 id="drills-title" className="h5 mb-2 d-flex align-items-center gap-2">
        <i className="bi bi-lightning-charge text-secondary" aria-hidden="true" />
        {t('progress.recentDrills.title')}
      </h2>
      <ul className="list-unstyled mb-0">
        {progress.recentDrills.map((d) => (
          <li
            key={d.sessionId}
            className="cb-dash-row d-flex flex-wrap align-items-center gap-2 py-2"
          >
            <div className="flex-grow-1">
              <div className="fw-semibold small">{d.dimensionName}</div>
              <div className="small cb-text-secondary">
                {formatDate(i18n.resolvedLanguage, d.at)} ·{' '}
                {d.score !== null ? `${d.score}/100` : t(`interview.states.${d.state}`)}
              </div>
            </div>
            <Link
              to={`/app/drills/${d.sessionId}`}
              className="btn btn-sm btn-outline-primary"
              aria-label={t('progress.recentDrills.openNamed', { name: d.dimensionName })}
            >
              {t('dashboard.view')}
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** The progress hub: how ready the candidate is, what to practise next, and the habit loop. */
export function DashboardPage() {
  const { t } = useTranslation();
  const { user } = useCandidateAuth();
  const progress = useProgress();
  if (!user) return null;
  const data = progress.data;
  const isNew = data ? data.readiness.trend.length === 0 : false;

  return (
    <div className="container-xxl px-3 px-lg-4 py-4 py-lg-5 d-flex flex-column gap-4">
      <Hero name={user.profile.displayName ?? ''} progress={data} />
      {progress.isError && (
        <div className="alert alert-warning mb-0" role="alert">
          {t('progress.loadError')}
        </div>
      )}
      {progress.isPending && <p className="cb-text-secondary mb-0">{t('common.loading')}</p>}

      {data && isNew && (
        <div className="row g-4">
          <div className="col-xl-7">
            <EmptyState />
          </div>
          <div className="col-xl-5 d-flex flex-column gap-4">
            <StreakGoalCard progress={data} />
            <CreditsCard />
          </div>
        </div>
      )}

      {data && !isNew && (
        <>
          <div className="row g-4">
            <div className="col-lg-7">
              <ReadinessCard progress={data} />
            </div>
            <div className="col-lg-5">
              <StreakGoalCard progress={data} />
            </div>
          </div>
          <div className="row g-4">
            <div className="col-lg-7">
              {data.plan ? (
                <PlanChecklist plan={data.plan} />
              ) : (
                <section className="cb-dash-card h-100">
                  <p className="cb-text-secondary mb-0">{t('progress.plan.none')}</p>
                </section>
              )}
            </div>
            <div className="col-lg-5 d-flex flex-column gap-4">
              <DimensionCard progress={data} />
              <RecentDrills progress={data} />
            </div>
          </div>
        </>
      )}

      <div className="row g-4">
        <div className="col-xl-6 d-flex flex-column gap-4">
          <RecentInterviews />
          {/* New candidates see credits beside the welcome card. */}
          {!(data && isNew) && <CreditsCard />}
        </div>
        <div className="col-xl-6 d-flex flex-column gap-4">
          {data && <BadgesCard badges={data.badges} />}
          <PracticeAreas progress={data} />
        </div>
      </div>
    </div>
  );
}

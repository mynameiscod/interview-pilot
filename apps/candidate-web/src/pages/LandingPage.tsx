import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { track } from '../lib/analytics';

const STEPS = [
  { key: 'step1', icon: 'bi-file-earmark-person' },
  { key: 'step2', icon: 'bi-chat-square-text' },
  { key: 'step3', icon: 'bi-clipboard-data' },
] as const;

export function LandingPage() {
  const { t } = useTranslation();
  return (
    <>
      <section className="cb-surface-muted py-5">
        <div className="container py-lg-4">
          <div className="row">
            <div className="col-lg-8">
              <h1 className="display-6 fw-semibold text-primary">{t('landing.hero.title')}</h1>
              <p className="lead cb-text-secondary mt-3">{t('landing.hero.subtitle')}</p>
              <div className="d-flex flex-wrap gap-2 mt-3">
                <Link
                  to="/login"
                  className="btn btn-primary btn-lg"
                  onClick={() => track('landing_cta_clicked', { cta: 'get_started' })}
                >
                  {t('landing.hero.getStarted')}
                </Link>
                <a href="#how-it-works" className="btn btn-outline-primary btn-lg">
                  {t('landing.hero.howItWorksCta')}
                </a>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section id="how-it-works" className="py-5" aria-labelledby="how-title">
        <div className="container">
          <h2 id="how-title" className="h3 mb-4">
            {t('landing.how.title')}
          </h2>
          <ol className="row list-unstyled g-4 mb-0">
            {STEPS.map((step, index) => (
              <li key={step.key} className="col-md-4">
                <div className="h-100 p-4 border cb-border rounded-3 bg-white">
                  <div className="d-flex align-items-center gap-2 mb-2">
                    <i className={`bi ${step.icon} fs-4 text-secondary`} aria-hidden="true" />
                    <span className="badge text-bg-primary">{index + 1}</span>
                  </div>
                  <h3 className="h5">{t(`landing.how.${step.key}Title`)}</h3>
                  <p className="cb-text-secondary mb-0">{t(`landing.how.${step.key}Body`)}</p>
                </div>
              </li>
            ))}
          </ol>
        </div>
      </section>

      <section className="py-4" aria-labelledby="fair-title">
        <div className="container">
          <div className="p-4 rounded-3 cb-surface-muted d-flex gap-3">
            <i className="bi bi-shield-check fs-3 text-primary" aria-hidden="true" />
            <div>
              <h2 id="fair-title" className="h5">
                {t('landing.fair.title')}
              </h2>
              <p className="cb-text-secondary mb-0">{t('landing.fair.body')}</p>
            </div>
          </div>
        </div>
      </section>
    </>
  );
}

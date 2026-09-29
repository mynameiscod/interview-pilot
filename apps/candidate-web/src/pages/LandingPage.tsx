import { UiLocale } from '@cbi/shared-types';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { track } from '../lib/analytics';
import { LANDING_FAQ, LANDING_FEATURES, LANDING_STEPS, LANDING_TRUST } from './landing-content';
import './landing.scss';

function GetStartedLink({ cta, label }: { cta: string; label: string }) {
  return (
    <Link
      to="/login"
      className="btn btn-primary btn-lg"
      onClick={() => track('landing_cta_clicked', { cta })}
    >
      {label}
    </Link>
  );
}

export function LandingPage() {
  const { t } = useTranslation();
  return (
    <>
      <section className="cb-landing-hero py-5" aria-labelledby="hero-title">
        <div className="container py-lg-4">
          <div className="row">
            <div className="col-lg-8">
              <p className="cb-landing-eyebrow mb-2">{t('landing.hero.eyebrow')}</p>
              <h1 id="hero-title" className="display-6 fw-semibold text-primary">
                {t('landing.hero.title')}
              </h1>
              <p className="lead cb-text-secondary mt-3">{t('landing.hero.subtitle')}</p>
              <div className="d-flex flex-wrap gap-2 mt-3">
                <GetStartedLink cta="get_started" label={t('landing.hero.getStarted')} />
                <a href="#how-it-works" className="btn btn-outline-primary btn-lg">
                  {t('landing.hero.howItWorksCta')}
                </a>
              </div>
              <p className="small cb-text-secondary mt-3 mb-0">
                <i className="bi bi-gift me-1" aria-hidden="true" />
                {t('landing.hero.freeNote')}
              </p>
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
            {LANDING_STEPS.map((step, index) => (
              <li key={step.key} className="col-md-4">
                <div className="cb-landing-card">
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

      <section className="py-5 cb-surface-muted" aria-labelledby="features-title">
        <div className="container">
          <h2 id="features-title" className="h3">
            {t('landing.features.title')}
          </h2>
          <p className="cb-text-secondary mb-4">{t('landing.features.subtitle')}</p>
          <ul className="row list-unstyled g-4 mb-0">
            {LANDING_FEATURES.map((feature) => (
              <li key={feature.key} className="col-md-6 col-lg-4">
                <div className="cb-landing-card">
                  <span className="cb-landing-icon mb-3">
                    <i className={`bi ${feature.icon}`} aria-hidden="true" />
                  </span>
                  <h3 className="h5">{t(`landing.features.${feature.key}Title`)}</h3>
                  <p className="cb-text-secondary mb-0">
                    {t(`landing.features.${feature.key}Body`)}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        </div>
      </section>

      <section className="py-5" aria-labelledby="languages-title">
        <div className="container">
          <div className="row g-4 align-items-center">
            <div className="col-lg-7">
              <h2 id="languages-title" className="h3">
                {t('landing.languages.title')}
              </h2>
              <p className="cb-text-secondary mb-0">{t('landing.languages.body')}</p>
            </div>
            <div className="col-lg-5">
              <ul
                className="list-unstyled d-flex flex-wrap gap-2 mb-0"
                aria-label={t('landing.languages.listLabel')}
              >
                {UiLocale.options.map((lng) => (
                  <li key={lng} className="cb-landing-card h-auto py-2 px-3 fw-semibold" lang={lng}>
                    <i className="bi bi-translate text-secondary me-2" aria-hidden="true" />
                    {t(`language.${lng}`)}
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </div>
      </section>

      <section className="py-4" aria-labelledby="pricing-title">
        <div className="container">
          <div className="cb-landing-band p-4 p-lg-5 d-flex flex-column flex-lg-row gap-3 align-items-lg-center justify-content-between">
            <div>
              <h2 id="pricing-title" className="h3">
                {t('landing.pricing.title')}
              </h2>
              <p className="mb-0">{t('landing.pricing.body')}</p>
            </div>
            <Link
              to="/pricing"
              className="btn btn-light btn-lg flex-shrink-0"
              onClick={() => track('landing_cta_clicked', { cta: 'pricing' })}
            >
              {t('landing.pricing.cta')}
              <i className="bi bi-arrow-right ms-2" aria-hidden="true" />
            </Link>
          </div>
        </div>
      </section>

      <section className="py-5" aria-labelledby="trust-title">
        <div className="container">
          <h2 id="trust-title" className="h3 mb-4">
            {t('landing.trust.title')}
          </h2>
          <ul className="row list-unstyled g-4 mb-0">
            <li className="col-md-6 col-lg-3">
              <div className="cb-landing-card">
                <span className="cb-landing-icon mb-3">
                  <i className="bi bi-shield-check" aria-hidden="true" />
                </span>
                <h3 className="h6">{t('landing.fair.title')}</h3>
                <p className="small cb-text-secondary mb-0">{t('landing.fair.body')}</p>
              </div>
            </li>
            {LANDING_TRUST.map((item) => (
              <li key={item.key} className="col-md-6 col-lg-3">
                <div className="cb-landing-card">
                  <span className="cb-landing-icon mb-3">
                    <i className={`bi ${item.icon}`} aria-hidden="true" />
                  </span>
                  <h3 className="h6">{t(`landing.trust.${item.key}Title`)}</h3>
                  <p className="small cb-text-secondary mb-0">
                    {t(`landing.trust.${item.key}Body`)}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        </div>
      </section>

      <section className="py-5 cb-surface-muted" aria-labelledby="faq-title">
        <div className="container">
          <div className="row">
            <div className="col-lg-8">
              <h2 id="faq-title" className="h3 mb-4">
                {t('landing.faq.title')}
              </h2>
              <div className="d-flex flex-column gap-2">
                {LANDING_FAQ.map((key) => (
                  <details key={key} className="cb-landing-faq">
                    <summary>
                      <span>{t(`landing.faq.${key}Q`)}</span>
                      <i className="bi bi-chevron-down cb-landing-faq-chevron" aria-hidden="true" />
                    </summary>
                    <p className="cb-text-secondary px-3 px-md-4 pb-3 mb-0">
                      {t(`landing.faq.${key}A`)}
                    </p>
                  </details>
                ))}
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="py-5" aria-labelledby="final-cta-title">
        <div className="container text-center">
          <h2 id="final-cta-title" className="h3">
            {t('landing.finalCta.title')}
          </h2>
          <p className="cb-text-secondary">{t('landing.finalCta.body')}</p>
          <GetStartedLink cta="final_cta" label={t('landing.finalCta.cta')} />
        </div>
      </section>
    </>
  );
}

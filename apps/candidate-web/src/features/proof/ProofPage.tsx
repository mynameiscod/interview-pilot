import type { ProofView } from '@cbi/shared-types';
import { ApiClientError } from '@cbi/web-core';
import { useTranslation } from 'react-i18next';
import { Link, useParams } from 'react-router';
import { RouteLoading } from '../../app/RouteStates';
import { formatDate, inputErrorMessage } from '../interviews/messages';
import { ReadinessGauge } from '../reports/components/OverallReadiness';
import { CONFIDENCE_ICON } from '../reports/report-format';
import { useProof } from './proof-api';

type Dimension = ProofView['dimensions'][number];

/** Highest score first; unscored skills last, heavier ones first within each group. */
function sortDimensions(dimensions: readonly Dimension[]): Dimension[] {
  return [...dimensions].sort((a, b) => {
    if (a.score === null && b.score === null) return b.weight - a.weight;
    if (a.score === null) return 1;
    if (b.score === null) return -1;
    return b.score - a.score || b.weight - a.weight;
  });
}

function ProofSummary({ proof }: { proof: ProofView }) {
  const { t, i18n } = useTranslation();
  const lng = i18n.resolvedLanguage;
  const band = t(`report.band.${proof.band}`);
  const gaugeLabel =
    proof.overall === null
      ? t('report.gaugeLabelNone', { band })
      : t('report.gaugeLabel', { score: proof.overall, band });
  const dimensions = sortDimensions(proof.dimensions);
  const facts = [
    { label: t('report.header.mode'), value: t(`setup.modes.${proof.mode}.name`, proof.mode) },
    ...(proof.completedAt
      ? [{ label: t('proof.view.completed'), value: formatDate(lng, proof.completedAt) }]
      : []),
  ];

  return (
    <div className="container py-5" style={{ maxWidth: '48rem' }}>
      <header className="mb-4">
        <p className="small cb-text-secondary mb-1">{t('proof.view.eyebrow')}</p>
        <h1 className="h3 mb-1">{proof.candidateName ?? t('proof.view.anonymous')}</h1>
        <p className="fs-5 mb-2">{proof.roleTitle}</p>
        <dl className="d-flex flex-wrap gap-3 small mb-0">
          {facts.map((fact) => (
            <div key={fact.label} className="d-flex gap-1">
              <dt className="fw-normal cb-text-secondary">{fact.label}:</dt>
              <dd className="mb-0 fw-semibold">{fact.value}</dd>
            </div>
          ))}
        </dl>
      </header>

      <div className="d-flex flex-column gap-4">
        <section
          className="p-4 border cb-border rounded-3 bg-white"
          aria-labelledby="proof-overall-title"
        >
          <h2 id="proof-overall-title" className="h5">
            {t('report.overallTitle')}
          </h2>
          <div className="row g-4 align-items-center">
            <div className="col-md-5 text-center">
              <ReadinessGauge score={proof.overall} label={gaugeLabel} />
              <p className="fs-5 fw-semibold mb-0 mt-2">{band}</p>
              {proof.overall !== null && (
                <p className="small cb-text-secondary mb-0">
                  {t('report.scoreOutOf', { score: proof.overall })}
                </p>
              )}
            </div>
            <div className="col-md-7">
              <h3 className="h6">{t('report.confidence.title')}</h3>
              <p className="mb-2">
                <span className="badge text-bg-light border cb-border fs-6 fw-normal">
                  <i
                    className={`bi ${CONFIDENCE_ICON[proof.confidence]} me-2`}
                    aria-hidden="true"
                  />
                  {t('report.confidence.chip', {
                    level: t(`report.confidence.${proof.confidence}`),
                  })}
                </span>
              </p>
              <p className="small cb-text-secondary mb-0">{t('report.confidence.explain')}</p>
            </div>
          </div>
        </section>

        <section
          className="p-4 border cb-border rounded-3 bg-white"
          aria-labelledby="proof-skills-title"
        >
          <h2 id="proof-skills-title" className="h5">
            {t('report.dimensions.title')}
          </h2>
          {dimensions.length === 0 ? (
            <p className="mb-0 cb-text-secondary">{t('report.dimensions.none')}</p>
          ) : (
            <ul className="list-unstyled mb-0 d-flex flex-column gap-3">
              {dimensions.map((d) => (
                <li key={d.name}>
                  <div className="d-flex justify-content-between gap-2">
                    <span>
                      {d.name}{' '}
                      <span className="small cb-text-secondary">
                        ({t('report.dimensions.weight', { weight: d.weight })})
                      </span>
                    </span>
                    <span className="fw-semibold">
                      {d.score === null
                        ? t('report.notAssessed')
                        : t('report.scoreOutOf', { score: d.score })}
                    </span>
                  </div>
                  <div className="progress mt-1" style={{ height: '0.5rem' }} aria-hidden="true">
                    <div
                      className="progress-bar"
                      style={{ width: `${Math.max(0, Math.min(100, d.score ?? 0))}%` }}
                    />
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>

        {proof.reviewed && (
          <p className="alert alert-success d-flex gap-2 mb-0" role="note">
            <i className="bi bi-patch-check-fill" aria-hidden="true" />
            <span>{t('proof.view.reviewed')}</span>
          </p>
        )}

        <div className="alert alert-info d-flex gap-2 mb-0" role="note">
          <i className="bi bi-robot" aria-hidden="true" />
          <div>
            <strong>{t('report.aiGenerated')}</strong> {proof.disclaimer}
          </div>
        </div>

        <p className="small cb-text-secondary mb-0">
          {t('proof.view.scope')}{' '}
          {t('proof.view.expires', { date: formatDate(lng, proof.expiresAt) })}
        </p>
      </div>
    </div>
  );
}

/** Public, read-only proof of one readiness report, opened from a share link. */
export function ProofPage() {
  const { t } = useTranslation();
  const { token = '' } = useParams();
  const proof = useProof(token);

  // Shared links are private to whoever holds them: keep them out of search engines.
  const noIndex = <meta name="robots" content="noindex" />;

  if (proof.isPending)
    return (
      <>
        {noIndex}
        <RouteLoading />
      </>
    );
  if (proof.isError || !proof.data) {
    const notFound = proof.error instanceof ApiClientError && proof.error.status === 404;
    return (
      <div className="container py-5" role="alert">
        {noIndex}
        <h1 className="h3">
          {notFound ? t('proof.view.notFoundTitle') : t('proof.view.loadError')}
        </h1>
        <p className="cb-text-secondary">
          {notFound ? t('proof.view.notFoundBody') : inputErrorMessage(t, proof.error)}
        </p>
        <Link to="/" className="btn btn-outline-primary">
          {t('notFound.home')}
        </Link>
      </div>
    );
  }
  return (
    <>
      {noIndex}
      <ProofSummary proof={proof.data} />
    </>
  );
}

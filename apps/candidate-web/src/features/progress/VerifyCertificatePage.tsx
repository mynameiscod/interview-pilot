import { ApiClientError } from '@cbi/web-core';
import { useTranslation } from 'react-i18next';
import { Link, useParams } from 'react-router';
import { RouteLoading } from '../../app/RouteStates';
import { formatDate, inputErrorMessage } from '../interviews/messages';
import { useCertificateVerification } from './progress-api';
import './progress.scss';

/** Public page behind a certificate's verification link or code: the facts it was issued with. */
export function VerifyCertificatePage() {
  const { t, i18n } = useTranslation();
  const lng = i18n.resolvedLanguage;
  const { code = '' } = useParams();
  const check = useCertificateVerification(code);

  if (check.isPending) return <RouteLoading />;
  if (check.isError || !check.data) {
    const missing = check.error instanceof ApiClientError && check.error.status === 404;
    return (
      <div className="container py-5" style={{ maxWidth: '40rem' }} role="alert">
        <h1 className="h3">{t('certificate.verify.notFoundTitle')}</h1>
        <p className="cb-text-secondary">
          {missing ? t('certificate.verify.notFound') : inputErrorMessage(t, check.error)}
        </p>
        <Link to="/" className="btn btn-outline-primary">
          {t('notFound.home')}
        </Link>
      </div>
    );
  }

  const c = check.data;
  const facts = [
    { label: t('certificate.verify.role'), value: c.roleTitle },
    { label: t('certificate.verify.band'), value: t(`report.band.${c.band}`) },
    ...(c.overall !== null
      ? [{ label: t('certificate.verify.score'), value: `${c.overall} / 100` }]
      : []),
    ...(c.completedAt
      ? [{ label: t('certificate.verify.completed'), value: formatDate(lng, c.completedAt) }]
      : []),
    { label: t('certificate.verify.issued'), value: formatDate(lng, c.issuedAt) },
    { label: t('certificate.verify.code'), value: c.code },
  ];
  return (
    <div className="container py-5" style={{ maxWidth: '44rem' }}>
      <div className="cb-certificate">
        <p className="d-flex align-items-center gap-2 fw-semibold mb-2" role="status">
          <i className="bi bi-patch-check-fill text-success fs-4" aria-hidden="true" />
          {t('certificate.verify.valid')}
        </p>
        <h1 className="h3 mb-3">{c.candidateName ?? t('proof.view.anonymous')}</h1>
        <dl className="row mb-0">
          {facts.map((f) => (
            <div key={f.label} className="col-sm-6 mb-2">
              <dt className="small fw-normal cb-text-secondary">{f.label}</dt>
              <dd className="mb-0 fw-semibold text-break">{f.value}</dd>
            </div>
          ))}
        </dl>
        {c.superseded && (
          <p className="small alert alert-info mt-3 mb-0">{t('certificate.verify.superseded')}</p>
        )}
      </div>
      <p className="small cb-text-secondary mt-3 mb-0">{t('certificate.verify.disclaimer')}</p>
    </div>
  );
}

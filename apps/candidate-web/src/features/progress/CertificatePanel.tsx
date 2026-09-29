import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useFlag } from '../../app/system-api';
import { useCandidateAuth } from '../../app/session';
import { formatDate, inputErrorMessage } from '../interviews/messages';
import { PdfNotReadyError } from '../reports/reports-api';
import { downloadCertificatePdf, useCertificate, useIssueCertificate } from './progress-api';

function CertificatePanelBody({ sessionId }: { sessionId: string }) {
  const { t, i18n } = useTranslation();
  const id = useId();
  const { manager } = useCandidateAuth();
  const status = useCertificate(sessionId, true);
  const issue = useIssueCertificate(sessionId);
  const [downloadError, setDownloadError] = useState<string | null>(null);

  if (status.isPending || status.isError || !status.data) return null;
  const { eligible, minBand, certificate } = status.data;
  const verifyUrl = certificate ? `${window.location.origin}${certificate.verifyPath}` : null;

  async function download() {
    if (!certificate) return;
    setDownloadError(null);
    try {
      await downloadCertificatePdf(manager, sessionId, certificate.code);
    } catch (err) {
      setDownloadError(
        err instanceof PdfNotReadyError ? t('certificate.preparing') : inputErrorMessage(t, err),
      );
    }
  }

  return (
    <section className="p-4 border cb-border rounded-3 bg-white" aria-labelledby={`${id}-title`}>
      <h2 id={`${id}-title`} className="h5">
        <i className="bi bi-patch-check me-2 text-secondary" aria-hidden="true" />
        {t('certificate.title')}
      </h2>
      {!certificate && !eligible && (
        <p className="mb-0">
          {t('certificate.notEligible', { band: t(`report.band.${minBand}`) })}
        </p>
      )}
      {!certificate && eligible && (
        <>
          <p>{t('certificate.eligible')}</p>
          {issue.isError && (
            <div className="alert alert-danger py-2" role="alert">
              {inputErrorMessage(t, issue.error)}
            </div>
          )}
          <button
            type="button"
            className="btn btn-primary"
            disabled={issue.isPending}
            onClick={() => issue.mutate()}
          >
            {issue.isPending ? t('certificate.issuing') : t('certificate.issue')}
          </button>
        </>
      )}
      {certificate && verifyUrl && (
        <>
          <p className="mb-1">
            {t('certificate.issued', {
              code: certificate.code,
              date: formatDate(i18n.resolvedLanguage, certificate.issuedAt),
            })}
          </p>
          <p className="small mb-3">
            {t('certificate.verifyAt')}{' '}
            <a href={verifyUrl} className="text-break">
              {verifyUrl}
            </a>
          </p>
          {downloadError && (
            <div className="alert alert-warning py-2" role="alert">
              {downloadError}
            </div>
          )}
          <button
            type="button"
            className="btn btn-outline-primary"
            disabled={!certificate.pdfReady}
            onClick={() => void download()}
          >
            <i className="bi bi-download me-2" aria-hidden="true" />
            {certificate.pdfReady ? t('certificate.download') : t('certificate.preparing')}
          </button>
        </>
      )}
    </section>
  );
}

/**
 * Readiness certificate for a report (behind the Candidate Proof flag):
 * issue it when the report reaches the threshold band, then download the PDF
 * or share its verification link. Renders nothing while the flag is off.
 */
export function CertificatePanel({ sessionId }: { sessionId: string }) {
  const enabled = useFlag('reports.publicProof');
  if (!enabled) return null;
  return <CertificatePanelBody sessionId={sessionId} />;
}

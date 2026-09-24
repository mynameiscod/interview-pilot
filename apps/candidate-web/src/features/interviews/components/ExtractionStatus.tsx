import type { Extraction } from '@cbi/shared-types';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { MAX_UPLOAD_MB } from '../messages';

interface Props {
  kind: 'resume' | 'jd';
  extraction: Extraction | undefined;
  /** Extra advice shown under a failure message. */
  children?: ReactNode;
}

/**
 * Live extraction status for an uploaded resume or job description. The
 * status line is a polite live region so screen readers hear progress.
 */
export function ExtractionStatus({ kind, extraction, children }: Props) {
  const { t } = useTranslation();
  if (!extraction) return null;

  if (extraction.status === 'PENDING' || extraction.status === 'PROCESSING') {
    return (
      <div className="d-flex align-items-center gap-2 small" role="status" aria-live="polite">
        <span className="spinner-border spinner-border-sm text-primary" aria-hidden="true" />
        <span>{t(`inputs.status.reading.${kind}`)}</span>
      </div>
    );
  }

  if (extraction.status === 'FAILED') {
    const code = extraction.errorCode ?? 'INTERNAL';
    return (
      <div className="alert alert-danger mb-0" role="alert">
        <p className="fw-semibold mb-1">
          <i className="bi bi-x-circle me-2" aria-hidden="true" />
          {t(`inputs.status.failed.${kind}`)}
        </p>
        <p className="mb-0">{t(`inputs.errors.${code}`, { mb: MAX_UPLOAD_MB })}</p>
        {children}
      </div>
    );
  }

  return (
    <div role="status" aria-live="polite">
      <p className="small mb-1 text-success-emphasis">
        <i className="bi bi-check-circle me-2" aria-hidden="true" />
        {t(`inputs.status.ready.${kind}`)}
      </p>
      {extraction.warnings.length > 0 && (
        <ul className="list-unstyled small mb-0">
          {extraction.warnings.map((w) => (
            <li key={w} className="alert alert-warning py-2 mb-1">
              <i className="bi bi-exclamation-triangle me-2" aria-hidden="true" />
              <span className="visually-hidden">{t('inputs.warningLabel')}: </span>
              {t(`inputs.warnings.${w}`)}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

import { useTranslation } from 'react-i18next';
import { useCreditBalance } from '../interviews/interviews-api';

/** Interview credits: what can start an interview now and what an interview in progress holds. */
export function CreditsCard() {
  const { t } = useTranslation();
  const balance = useCreditBalance();

  return (
    <section className="p-4 border cb-border rounded-3 bg-white" aria-labelledby="credits-title">
      <h2 id="credits-title" className="h5">
        <i className="bi bi-coin me-2 text-secondary" aria-hidden="true" />
        {t('credits.title')}
      </h2>
      {balance.isPending && <p className="cb-text-secondary mb-0">{t('common.loading')}</p>}
      {balance.isError && (
        <p className="cb-text-secondary mb-0" role="alert">
          {t('credits.error')}
        </p>
      )}
      {balance.data && (
        <>
          <p className="fs-5 fw-semibold mb-1">
            {t('credits.available', { count: balance.data.available })}
          </p>
          {balance.data.reserved > 0 && (
            <p className="small mb-1">{t('credits.reserved', { count: balance.data.reserved })}</p>
          )}
          <p className="small cb-text-secondary mb-0">{t('credits.note')}</p>
        </>
      )}
    </section>
  );
}

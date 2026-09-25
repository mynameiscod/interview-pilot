import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { useCreditBalance } from '../interviews/interviews-api';

/** Interview credits: what can start an interview now and what an interview in progress holds. */
export function CreditsCard() {
  const { t } = useTranslation();
  const balance = useCreditBalance();

  return (
    <section className="cb-dash-card" aria-labelledby="credits-title">
      <div className="d-flex gap-3 align-items-start">
        <span className="cb-icon-tile">
          <i className="bi bi-database" aria-hidden="true" />
        </span>
        <div className="flex-grow-1">
          <div className="d-flex flex-wrap align-items-center justify-content-between gap-2">
            <h2 id="credits-title" className="h5 mb-0">
              {t('credits.title')}
            </h2>
            <Link to="/pricing" className="cb-link-pill">
              <i className="bi bi-tag" aria-hidden="true" />
              {t('credits.viewPricing')}
            </Link>
          </div>
          {balance.isPending && (
            <p className="cb-text-secondary mt-2 mb-0">{t('common.loading')}</p>
          )}
          {balance.isError && (
            <p className="cb-text-secondary mt-2 mb-0" role="alert">
              {t('credits.error')}
            </p>
          )}
          {balance.data && (
            <>
              <p className="fs-4 fw-bold text-primary mt-2 mb-1">
                {t('credits.available', { count: balance.data.available })}
              </p>
              {balance.data.reserved > 0 && (
                <p className="small mb-1">
                  {t('credits.reserved', { count: balance.data.reserved })}
                </p>
              )}
              <p className="small cb-text-secondary">{t('credits.note')}</p>
            </>
          )}
          <div className="d-flex flex-wrap align-items-center gap-3 mt-3">
            <Link to="/pricing" className="btn btn-primary">
              <i className="bi bi-cart3 me-2" aria-hidden="true" />
              {t('nav.buyCredits')}
            </Link>
            <Link to="/app/purchases" className="small fw-semibold">
              {t('credits.purchasesLink')}
              <i className="bi bi-arrow-right ms-1" aria-hidden="true" />
            </Link>
          </div>
        </div>
      </div>
    </section>
  );
}

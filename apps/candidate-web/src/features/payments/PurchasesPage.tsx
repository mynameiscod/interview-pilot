import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { formatDate } from '../interviews/messages';
import { formatMoney, STATUS_BADGE } from './payment-format';
import { usePurchases } from './payments-api';

/** Every purchase, newest first, with a link to its status page. */
export function PurchasesPage() {
  const { t, i18n } = useTranslation();
  const purchases = usePurchases();
  const items = purchases.data ?? [];

  return (
    <div className="container py-5">
      <div className="d-flex flex-wrap align-items-start justify-content-between gap-2">
        <div>
          <h1 className="h3">{t('purchases.title')}</h1>
          <p className="cb-text-secondary">{t('purchases.subtitle')}</p>
        </div>
        <Link to="/pricing" className="btn btn-outline-primary">
          {t('nav.buyCredits')}
        </Link>
      </div>

      {purchases.isPending && <p className="cb-text-secondary">{t('common.loading')}</p>}
      {purchases.isError && (
        <div className="alert alert-danger" role="alert">
          {t('purchases.error')}
        </div>
      )}
      {purchases.data && items.length === 0 && (
        <section className="p-4 border cb-border rounded-3 bg-white" aria-labelledby="empty-title">
          <h2 id="empty-title" className="h5">
            {t('purchases.emptyTitle')}
          </h2>
          <p className="cb-text-secondary">{t('purchases.emptyBody')}</p>
          <Link to="/pricing" className="btn btn-primary">
            {t('purchases.seePlans')}
          </Link>
        </section>
      )}
      {items.length > 0 && (
        <section className="p-4 border cb-border rounded-3 bg-white">
          <div
            className="table-responsive"
            tabIndex={0}
            role="region"
            aria-label={t('purchases.caption')}
          >
            <table className="table align-middle mb-0">
              <caption className="visually-hidden">{t('purchases.caption')}</caption>
              <thead>
                <tr>
                  <th scope="col">{t('purchases.date')}</th>
                  <th scope="col">{t('purchases.plan')}</th>
                  <th scope="col">{t('purchases.total')}</th>
                  <th scope="col">{t('purchases.status')}</th>
                  <th scope="col">
                    <span className="visually-hidden">{t('purchases.details')}</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {items.map((item) => {
                  const date = formatDate(i18n.resolvedLanguage, item.createdAt);
                  return (
                    <tr key={item.id}>
                      <td className="text-nowrap">{date}</td>
                      <th scope="row" className="fw-normal">
                        {item.plan.name}
                        <span className="d-block small cb-text-secondary">
                          {t('pricing.credits', { count: item.plan.credits })}
                        </span>
                      </th>
                      <td className="text-nowrap">
                        {formatMoney(i18n.resolvedLanguage, item.totalMinor, item.currency)}
                      </td>
                      <td>
                        <span className={`badge ${STATUS_BADGE[item.status]}`}>
                          {t(`purchases.statuses.${item.status}`)}
                        </span>
                      </td>
                      <td className="text-end">
                        <Link
                          to={`/app/payments/${encodeURIComponent(item.id)}`}
                          aria-label={t('purchases.viewNamed', { name: item.plan.name, date })}
                        >
                          {t('purchases.view')}
                        </Link>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}

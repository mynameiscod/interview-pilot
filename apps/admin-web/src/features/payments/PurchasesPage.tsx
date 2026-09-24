import { PurchaseStatus } from '@cbi/shared-types';
import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useSearchParams } from 'react-router';
import { ErrorAlert, LoadingRow } from '../ai/shared';
import { formatDateTime } from '../library/format';
import { formatMoney, paymentsError } from './format';
import { usePurchases } from './queries';
import { PurchaseStatusBadge } from './shared';

const isStatus = (value: string | null): value is PurchaseStatus =>
  PurchaseStatus.safeParse(value).success;

export function PurchasesPage() {
  const { t, i18n } = useTranslation();
  const id = useId();
  // Filters live in the URL so returning from a purchase keeps them.
  const [params, setParams] = useSearchParams();
  const rawStatus = params.get('status');
  const status = isStatus(rawStatus) ? rawStatus : '';
  const q = params.get('q')?.trim() ?? '';
  const [statusInput, setStatusInput] = useState<string>(status);
  const [qInput, setQInput] = useState(q);
  const purchases = usePurchases({ status, q });

  return (
    <>
      <h1 className="h3 mb-2">{t('payments.purchases.title')}</h1>
      <p className="cb-text-secondary">{t('payments.purchases.subtitle')}</p>
      <form
        role="search"
        aria-label={t('payments.purchases.filtersLabel')}
        className="row g-2 align-items-end mb-3"
        onSubmit={(e) => {
          e.preventDefault();
          const next = new URLSearchParams();
          if (statusInput) next.set('status', statusInput);
          if (qInput.trim()) next.set('q', qInput.trim());
          setParams(next);
        }}
      >
        <div className="col-sm-4 col-lg-3">
          <label htmlFor={`${id}-status`} className="form-label small">
            {t('payments.purchases.statusFilter')}
          </label>
          <select
            id={`${id}-status`}
            className="form-select form-select-sm"
            value={statusInput}
            onChange={(e) => setStatusInput(e.target.value)}
          >
            <option value="">{t('payments.purchases.allStatuses')}</option>
            {PurchaseStatus.options.map((s) => (
              <option key={s} value={s}>
                {t(`payments.purchaseStatus.${s}`)}
              </option>
            ))}
          </select>
        </div>
        <div className="col-sm-8 col-lg-6">
          <label htmlFor={`${id}-q`} className="form-label small">
            {t('payments.purchases.search')}
          </label>
          <input
            id={`${id}-q`}
            type="search"
            className="form-control form-control-sm"
            maxLength={120}
            value={qInput}
            aria-describedby={`${id}-q-hint`}
            onChange={(e) => setQInput(e.target.value)}
          />
          <div id={`${id}-q-hint`} className="form-text">
            {t('payments.purchases.searchHint')}
          </div>
        </div>
        <div className="col-lg-3 pb-lg-4">
          <button type="submit" className="btn btn-sm btn-primary">
            {t('payments.purchases.apply')}
          </button>
        </div>
      </form>
      <section
        className="border cb-border rounded-3 bg-white"
        aria-label={t('payments.purchases.listLabel')}
      >
        {purchases.isPending && <LoadingRow />}
        {purchases.isError && (
          <div className="m-3">
            <ErrorAlert error={paymentsError(t, purchases.error)} />
          </div>
        )}
        {purchases.data && (
          <div className="table-responsive">
            <table className="table align-middle mb-0">
              <thead>
                <tr>
                  <th scope="col">{t('library.created')}</th>
                  <th scope="col">{t('payments.purchases.purchase')}</th>
                  <th scope="col">{t('payments.purchases.user')}</th>
                  <th scope="col">{t('payments.purchases.plan')}</th>
                  <th scope="col">{t('payments.purchases.coupon')}</th>
                  <th scope="col" className="text-end">
                    {t('payments.purchases.total')}
                  </th>
                  <th scope="col">{t('ai.status')}</th>
                </tr>
              </thead>
              <tbody>
                {purchases.data.length === 0 && (
                  <tr>
                    <td colSpan={7} className="cb-text-secondary">
                      {t('payments.purchases.empty')}
                    </td>
                  </tr>
                )}
                {purchases.data.map((p) => (
                  <tr key={p.id}>
                    <td className="small text-nowrap">
                      {formatDateTime(p.createdAt, i18n.language)}
                    </td>
                    <th scope="row" className="fw-normal">
                      <Link
                        to={`/purchases/${p.id}`}
                        className="font-monospace small"
                        aria-label={t('payments.purchases.openLabel', { id: p.id })}
                      >
                        {p.id}
                      </Link>
                    </th>
                    <td className="small">
                      {p.userEmail ?? <span className="cb-text-secondary">{p.userId}</span>}
                    </td>
                    <td>
                      {p.plan.name}
                      <div className="small cb-text-secondary font-monospace">{p.plan.code}</div>
                    </td>
                    <td>{p.couponCode ? <code>{p.couponCode}</code> : '—'}</td>
                    <td className="text-end">{formatMoney(p.totalMinor, p.currency)}</td>
                    <td>
                      <PurchaseStatusBadge status={p.status} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}

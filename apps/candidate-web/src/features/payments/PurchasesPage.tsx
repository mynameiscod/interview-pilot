import type { PurchaseSummary } from '@cbi/shared-types';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { useCandidateAuth } from '../../app/session';
import { formatDate } from '../interviews/messages';
import { downloadPdf } from '../reports/reports-api';
import { formatMoney, STATUS_BADGE } from './payment-format';
import { usePurchases } from './payments-api';

/** Downloads one PDF of a purchase: its receipt, or the credit note of a refund. */
function DownloadButton({
  path,
  fileName,
  label,
  ariaLabel,
  onError,
}: {
  path: string;
  fileName: string;
  label: string;
  ariaLabel: string;
  onError: () => void;
}) {
  const { manager } = useCandidateAuth();
  const [busy, setBusy] = useState(false);

  async function download() {
    setBusy(true);
    try {
      await downloadPdf(manager, path, fileName);
    } catch {
      onError();
    } finally {
      setBusy(false);
    }
  }

  return (
    <button
      type="button"
      className="btn btn-link btn-sm p-0 me-3"
      disabled={busy}
      aria-label={ariaLabel}
      onClick={() => void download()}
    >
      <i className="bi bi-file-earmark-arrow-down me-1" aria-hidden="true" />
      {label}
    </button>
  );
}

/**
 * The receipt of a paid purchase (a GST invoice when the seller is
 * registered) and a credit note per processed refund.
 */
function PurchaseDocuments({
  purchase,
  date,
  onError,
}: {
  purchase: PurchaseSummary;
  date: string;
  onError: (kind: 'receipt' | 'creditNote') => void;
}) {
  const { t, i18n } = useTranslation();
  const base = `/payments/purchases/${encodeURIComponent(purchase.id)}`;
  return (
    <>
      <DownloadButton
        path={`${base}/receipt`}
        fileName={`receipt-${purchase.id}.pdf`}
        label={t('purchases.receipt')}
        ariaLabel={t('purchases.receiptNamed', { name: purchase.plan.name, date })}
        onError={() => onError('receipt')}
      />
      {purchase.creditNotes.map((note) => (
        <DownloadButton
          key={note.key}
          path={`${base}/credit-notes/${encodeURIComponent(note.key)}`}
          fileName={`credit-note-${(note.number ?? note.key).replaceAll('/', '-')}.pdf`}
          label={t('purchases.creditNote')}
          ariaLabel={t('purchases.creditNoteNamed', {
            name: purchase.plan.name,
            date,
            amount: formatMoney(i18n.resolvedLanguage, note.amountMinor, purchase.currency),
          })}
          onError={() => onError('creditNote')}
        />
      ))}
    </>
  );
}

/** Every purchase, newest first, with a link to its status page. */
export function PurchasesPage() {
  const { t, i18n } = useTranslation();
  const purchases = usePurchases();
  const items = purchases.data ?? [];
  const [downloadFailed, setDownloadFailed] = useState<'receipt' | 'creditNote' | null>(null);

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
      {downloadFailed && (
        <div className="alert alert-danger" role="alert">
          {t(downloadFailed === 'receipt' ? 'purchases.receiptError' : 'purchases.creditNoteError')}
        </div>
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
                        {item.status === 'PAID' && item.refundedMinor > 0 && (
                          <span className="d-block small cb-text-secondary">
                            {t('purchases.partlyRefunded', {
                              amount: formatMoney(
                                i18n.resolvedLanguage,
                                item.refundedMinor,
                                item.currency,
                              ),
                            })}
                          </span>
                        )}
                      </td>
                      <td>
                        <span className={`badge ${STATUS_BADGE[item.status]}`}>
                          {t(`purchases.statuses.${item.status}`)}
                        </span>
                      </td>
                      <td className="text-end text-nowrap">
                        {item.receiptAvailable && (
                          <PurchaseDocuments
                            purchase={item}
                            date={date}
                            onError={setDownloadFailed}
                          />
                        )}
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

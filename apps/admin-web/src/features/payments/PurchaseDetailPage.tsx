import type { AdminPurchase, AdminReconcileResult, AdminRefundResult } from '@cbi/shared-types';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useParams } from 'react-router';
import { useAdminAuth, useCan } from '../../app/session';
import { ErrorAlert, LoadingRow } from '../ai/shared';
import { downloadExport } from '../campaigns/format';
import { formatDateTime } from '../library/format';
import { formatMoney, paymentsError } from './format';
import { paymentsKeys, usePurchase } from './queries';
import { RefundForm } from './RefundForm';
import { PaymentStatusBadge, PurchaseStatusBadge } from './shared';

type Notice = { tone: 'success' | 'warning' | 'danger'; text: string };

const RECONCILE_TONE: Record<AdminReconcileResult['outcome'], Notice['tone']> = {
  PAID: 'success',
  REFUNDED: 'success',
  EXPIRED: 'warning',
  PENDING: 'warning',
  AMOUNT_MISMATCH: 'danger',
  UNCHANGED: 'success',
};

const REFUND_TONE: Record<AdminRefundResult['refundStatus'], Notice['tone']> = {
  processed: 'success',
  pending: 'warning',
  failed: 'danger',
};

function Summary({ purchase }: { purchase: AdminPurchase }) {
  const { t, i18n } = useTranslation();
  const money = (minor: number) => formatMoney(minor, purchase.currency);
  const date = (value: string | null) => (value ? formatDateTime(value, i18n.language) : '—');
  return (
    <div className="row g-3 mb-3">
      <section className="col-lg-6" aria-labelledby="purchase-order-heading">
        <div className="p-3 border cb-border rounded-3 bg-white h-100">
          <h2 id="purchase-order-heading" className="h6">
            {t('payments.detail.order')}
          </h2>
          <dl className="row small mb-0">
            <dt className="col-sm-5">{t('payments.detail.user')}</dt>
            <dd className="col-sm-7">
              {purchase.userEmail ?? '—'}
              <div className="font-monospace cb-text-secondary">{purchase.userId}</div>
              <Link to={`/credits?user=${encodeURIComponent(purchase.userId)}`}>
                {t('payments.detail.adjustCredits')}
              </Link>
            </dd>
            <dt className="col-sm-5">{t('payments.purchases.plan')}</dt>
            <dd className="col-sm-7">
              {purchase.plan.name} (<code>{purchase.plan.code}</code>)
              <div className="cb-text-secondary">
                {t('payments.detail.planCredits', {
                  count: purchase.plan.credits,
                  validity:
                    purchase.plan.validityDays === null
                      ? t('payments.plans.noExpiry')
                      : t('payments.plans.days', { count: purchase.plan.validityDays }),
                })}
              </div>
            </dd>
            <dt className="col-sm-5">{t('payments.detail.listPrice')}</dt>
            <dd className="col-sm-7">{money(purchase.listPriceMinor)}</dd>
            <dt className="col-sm-5">{t('payments.purchases.coupon')}</dt>
            <dd className="col-sm-7">
              {purchase.couponCode ? <code>{purchase.couponCode}</code> : t('library.none')}
            </dd>
            <dt className="col-sm-5">{t('payments.detail.discount')}</dt>
            <dd className="col-sm-7">{money(purchase.discountMinor)}</dd>
            <dt className="col-sm-5">{t('payments.purchases.total')}</dt>
            <dd className="col-sm-7 fw-semibold">{money(purchase.totalMinor)}</dd>
            {purchase.refundedMinor > 0 && (
              <>
                <dt className="col-sm-5">{t('payments.detail.refunded')}</dt>
                <dd className="col-sm-7">{money(purchase.refundedMinor)}</dd>
              </>
            )}
            {purchase.invoiceNumber && (
              <>
                <dt className="col-sm-5">{t('payments.detail.invoiceNumber')}</dt>
                <dd className="col-sm-7 font-monospace">{purchase.invoiceNumber}</dd>
              </>
            )}
            <dt className="col-sm-5">{t('library.created')}</dt>
            <dd className="col-sm-7">{date(purchase.createdAt)}</dd>
            <dt className="col-sm-5">{t('library.updated')}</dt>
            <dd className="col-sm-7">{date(purchase.updatedAt)}</dd>
            <dt className="col-sm-5">{t('payments.detail.creditsIssued')}</dt>
            <dd className="col-sm-7 mb-0">{date(purchase.creditsIssuedAt)}</dd>
          </dl>
        </div>
      </section>
      <section className="col-lg-6" aria-labelledby="purchase-payment-heading">
        <div className="p-3 border cb-border rounded-3 bg-white h-100">
          <h2 id="purchase-payment-heading" className="h6">
            {t('payments.detail.payment')}
          </h2>
          {purchase.payment === null ? (
            <p className="small cb-text-secondary mb-0">{t('payments.detail.noPayment')}</p>
          ) : (
            <>
              <dl className="row small">
                <dt className="col-sm-5">{t('payments.detail.provider')}</dt>
                <dd className="col-sm-7">{purchase.payment.provider}</dd>
                <dt className="col-sm-5">{t('payments.detail.orderId')}</dt>
                <dd className="col-sm-7 font-monospace">{purchase.payment.orderId}</dd>
                <dt className="col-sm-5">{t('payments.detail.paymentId')}</dt>
                <dd className="col-sm-7 font-monospace">{purchase.payment.paymentId ?? '—'}</dd>
                <dt className="col-sm-5">{t('ai.status')}</dt>
                <dd className="col-sm-7">
                  <PaymentStatusBadge status={purchase.payment.status} />
                </dd>
                <dt className="col-sm-5">{t('payments.detail.signature')}</dt>
                <dd className="col-sm-7">
                  {purchase.payment.signatureVerified
                    ? t('payments.detail.signatureVerified')
                    : t('payments.detail.signatureNotVerified')}
                </dd>
              </dl>
              <h3 className="h6">{t('payments.detail.history')}</h3>
              {purchase.payment.history.length === 0 ? (
                <p className="small cb-text-secondary mb-0">{t('payments.detail.noHistory')}</p>
              ) : (
                <ol className="list-unstyled small mb-0" aria-label={t('payments.detail.history')}>
                  {purchase.payment.history.map((h, i) => (
                    <li key={i} className="d-flex gap-2 align-items-baseline mb-2">
                      <i className="bi bi-circle-fill text-primary small" aria-hidden="true" />
                      <div>
                        <PaymentStatusBadge status={h.status} />{' '}
                        <span className="cb-text-secondary">
                          {t('payments.detail.historyLine', {
                            at: formatDateTime(h.at, i18n.language),
                            source: h.source,
                          })}
                        </span>
                      </div>
                    </li>
                  ))}
                </ol>
              )}
              {purchase.payment.refunds.length > 0 && (
                <>
                  <h3 className="h6 mt-3">{t('payments.detail.refunds')}</h3>
                  <ul
                    className="list-unstyled small mb-0"
                    aria-label={t('payments.detail.refunds')}
                  >
                    {purchase.payment.refunds.map((r, i) => (
                      <li key={r.id ?? i} className="mb-2">
                        <span className="fw-semibold">
                          {t('payments.detail.refundLine', {
                            amount: money(r.amountMinor),
                            at: formatDateTime(r.processedAt ?? r.requestedAt, i18n.language),
                          })}
                        </span>{' '}
                        <span
                          className={`badge ${r.status === 'failed' ? 'text-bg-danger' : r.status === 'processed' ? 'text-bg-success' : 'text-bg-warning'}`}
                        >
                          {t(`payments.detail.refundStatus.${r.status}`)}
                        </span>
                        {r.status === 'processed' && (
                          <span className="cb-text-secondary">
                            {' '}
                            · {t('payments.detail.refundCredits', { count: r.creditsWithdrawn })}
                          </span>
                        )}
                        {r.reason && <div className="cb-text-secondary">{r.reason}</div>}
                        {r.id && <div className="font-monospace cb-text-secondary">{r.id}</div>}
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </>
          )}
        </div>
      </section>
    </div>
  );
}

/** The receipt (or tax invoice) and a credit note per processed refund. */
function ReceiptButton({ purchase }: { purchase: AdminPurchase }) {
  const { t } = useTranslation();
  const { manager } = useAdminAuth();
  const [error, setError] = useState<string | null>(null);
  const base = `/admin/purchases/${encodeURIComponent(purchase.id)}`;
  const download = useMutation({
    mutationFn: (file: { path: string; name: string; error: string }) =>
      downloadExport(manager, `${base}/${file.path}`, file.name).catch(() => {
        throw new Error(file.error);
      }),
    onSuccess: () => setError(null),
    onError: (err) => setError(err.message),
  });
  if (!purchase.receiptAvailable) return null;
  return (
    <div className="mb-3">
      <div className="d-flex flex-wrap gap-2">
        <button
          type="button"
          className="btn btn-sm btn-outline-secondary"
          disabled={download.isPending}
          onClick={() =>
            download.mutate({
              path: 'receipt',
              name: `receipt-${purchase.id}.pdf`,
              error: t('payments.detail.receiptError'),
            })
          }
        >
          <i className="bi bi-file-earmark-pdf me-1" aria-hidden="true" />
          {t('payments.detail.receipt')}
        </button>
        {purchase.creditNotes.map((note) => (
          <button
            key={note.key}
            type="button"
            className="btn btn-sm btn-outline-secondary"
            disabled={download.isPending}
            onClick={() =>
              download.mutate({
                path: `credit-notes/${encodeURIComponent(note.key)}`,
                name: `credit-note-${(note.number ?? note.key).replaceAll('/', '-')}.pdf`,
                error: t('payments.detail.creditNoteError'),
              })
            }
          >
            <i className="bi bi-file-earmark-pdf me-1" aria-hidden="true" />
            {t('payments.detail.creditNote', {
              number: note.number ?? t('payments.detail.creditNoteUnnumbered'),
              amount: formatMoney(note.amountMinor, purchase.currency),
            })}
          </button>
        ))}
      </div>
      <ErrorAlert error={error} />
    </div>
  );
}

function Actions({
  purchase,
  onNotice,
}: {
  purchase: AdminPurchase;
  onNotice: (notice: Notice) => void;
}) {
  const { t } = useTranslation();
  const id = useId();
  const { manager } = useAdminAuth();
  const queryClient = useQueryClient();
  const [refunding, setRefunding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const refundable =
    purchase.status === 'PAID' &&
    purchase.payment?.status === 'CAPTURED' &&
    purchase.refundedMinor < purchase.totalMinor;
  const refundInProgress =
    purchase.payment?.status === 'REFUND_REQUESTED' ||
    purchase.payment?.status === 'REFUND_PENDING';

  const updated = async (next: AdminPurchase) => {
    queryClient.setQueryData(paymentsKeys.purchase(purchase.id), next);
    await queryClient.invalidateQueries({ queryKey: paymentsKeys.purchases });
    await queryClient.invalidateQueries({ queryKey: paymentsKeys.refundPreview(purchase.id) });
  };

  const refunded = async (result: AdminRefundResult) => {
    setRefunding(false);
    setError(null);
    await updated(result.purchase);
    onNotice({
      tone: REFUND_TONE[result.refundStatus],
      text: t(`payments.refund.result.${result.refundStatus}`, {
        count: result.creditsWithdrawn,
      }),
    });
  };

  const reconcile = useMutation({
    mutationFn: () =>
      manager.api.post<AdminReconcileResult>(`/admin/purchases/${purchase.id}/reconcile`),
    onSuccess: async (result) => {
      setError(null);
      await updated(result.purchase);
      onNotice({
        tone: RECONCILE_TONE[result.outcome],
        text: t(`payments.reconcile.outcome.${result.outcome}`),
      });
    },
    onError: (err) => setError(paymentsError(t, err)),
  });

  return (
    <section
      className="p-3 border cb-border rounded-3 bg-white mb-3"
      aria-labelledby={`${id}-heading`}
    >
      <h2 id={`${id}-heading`} className="h6">
        {t('payments.detail.actions')}
      </h2>
      {!refunding && (
        <>
          <div className="d-flex flex-wrap gap-2">
            <button
              type="button"
              className="btn btn-sm btn-outline-primary"
              disabled={reconcile.isPending}
              aria-describedby={`${id}-reconcile-hint`}
              onClick={() => reconcile.mutate()}
            >
              {t('payments.reconcile.button')}
            </button>
            {refundable && (
              <button
                type="button"
                className="btn btn-sm btn-outline-danger"
                onClick={() => {
                  setError(null);
                  setRefunding(true);
                }}
              >
                {t('payments.refund.button')}
              </button>
            )}
          </div>
          <p id={`${id}-reconcile-hint`} className="small cb-text-secondary mt-2 mb-0">
            {t('payments.reconcile.hint')}
          </p>
          {refundInProgress ? (
            <p className="small cb-text-secondary mb-0">{t('payments.refund.inProgress')}</p>
          ) : (
            !refundable && (
              <p className="small cb-text-secondary mb-0">{t('payments.refund.notRefundable')}</p>
            )
          )}
          <div className="mt-2">
            <ErrorAlert error={error} />
          </div>
        </>
      )}
      {refunding && (
        <RefundForm
          purchase={purchase}
          onDone={(result) => void refunded(result)}
          onCancel={() => {
            setRefunding(false);
            setError(null);
          }}
        />
      )}
    </section>
  );
}

export function PurchaseDetailPage() {
  const { t } = useTranslation();
  const { purchaseId = '' } = useParams();
  const canManage = useCan('payments.manage');
  const purchase = usePurchase(purchaseId);
  const [notice, setNotice] = useState<Notice | null>(null);

  return (
    <>
      <p className="mb-2">
        <Link to="/purchases" className="small">
          <i className="bi bi-arrow-left me-1" aria-hidden="true" />
          {t('payments.detail.back')}
        </Link>
      </p>
      <h1 className="h3 mb-1">{t('payments.detail.title')}</h1>
      <p className="cb-text-secondary font-monospace small">
        {purchaseId}
        {purchase.data && (
          <span className="ms-2">
            <PurchaseStatusBadge status={purchase.data.status} />
          </span>
        )}
      </p>
      <div role="status" aria-live="polite">
        {notice && <div className={`alert alert-${notice.tone} py-2`}>{notice.text}</div>}
      </div>
      {purchase.isPending && <LoadingRow />}
      {purchase.isError && <ErrorAlert error={paymentsError(t, purchase.error)} />}
      {purchase.data && (
        <>
          {purchase.data.refundFailed && (
            <div className="alert alert-danger py-2" role="alert">
              <i className="bi bi-exclamation-octagon me-1" aria-hidden="true" />
              {t('payments.detail.refundFailedAlert')}
            </div>
          )}
          <ReceiptButton purchase={purchase.data} />
          <Summary purchase={purchase.data} />
          {canManage && <Actions purchase={purchase.data} onNotice={setNotice} />}
        </>
      )}
    </>
  );
}

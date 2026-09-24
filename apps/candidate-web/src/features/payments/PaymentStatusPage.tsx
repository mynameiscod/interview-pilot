import type { PurchaseSummary } from '@cbi/shared-types';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useLocation, useParams } from 'react-router';
import { RouteLoading } from '../../app/RouteStates';
import { queryKeys } from '../interviews/interviews-api';
import type { PaymentStatusState } from './CheckoutPage';
import { formatMoney, paymentErrorMessage, STATUS_BADGE, validityText } from './payment-format';
import { PURCHASE_POLL_LIMIT_MS, paymentKeys, usePurchase } from './payments-api';

function PurchaseDetails({ purchase }: { purchase: PurchaseSummary }) {
  const { t, i18n } = useTranslation();
  return (
    <dl className="row small mb-0">
      <dt className="col-5 fw-normal cb-text-secondary">{t('purchases.plan')}</dt>
      <dd className="col-7">{purchase.plan.name}</dd>
      <dt className="col-5 fw-normal cb-text-secondary">{t('purchases.total')}</dt>
      <dd className="col-7">
        {formatMoney(i18n.resolvedLanguage, purchase.totalMinor, purchase.currency)}
      </dd>
      <dt className="col-5 fw-normal cb-text-secondary">{t('purchases.status')}</dt>
      <dd className="col-7 mb-0">
        <span className={`badge ${STATUS_BADGE[purchase.status]}`}>
          {t(`purchases.statuses.${purchase.status}`)}
        </span>
      </dd>
    </dl>
  );
}

function StatusBody({ purchase, timedOut }: { purchase: PurchaseSummary; timedOut: boolean }) {
  const { t } = useTranslation();
  const checkoutPath = `/app/checkout/${encodeURIComponent(purchase.plan.code)}`;

  switch (purchase.status) {
    case 'PAID':
      return (
        <>
          <h1 className="h3">
            <i className="bi bi-check-circle-fill text-success me-2" aria-hidden="true" />
            {t('paymentStatus.paidTitle')}
          </h1>
          <p>
            {t('paymentStatus.paidBody', { count: purchase.plan.credits })}{' '}
            {validityText(t, purchase.plan.validityDays)}
          </p>
          <div className="d-flex flex-wrap gap-2">
            <Link to="/app/new" className="btn btn-primary">
              {t('dashboard.startCta')}
            </Link>
            <Link to="/app/purchases" className="btn btn-outline-primary">
              {t('paymentStatus.viewPurchases')}
            </Link>
          </div>
        </>
      );
    case 'FAILED':
      return (
        <>
          <h1 className="h3">
            <i className="bi bi-x-circle-fill text-danger me-2" aria-hidden="true" />
            {t('paymentStatus.failedTitle')}
          </h1>
          <p>{t('paymentStatus.failedBody')}</p>
          <div className="d-flex flex-wrap gap-2">
            <Link to={checkoutPath} className="btn btn-primary">
              {t('paymentStatus.retry')}
            </Link>
            <Link to="/pricing" className="btn btn-outline-primary">
              {t('checkout.backToPricing')}
            </Link>
          </div>
        </>
      );
    case 'EXPIRED':
      return (
        <>
          <h1 className="h3">{t('paymentStatus.expiredTitle')}</h1>
          <p>{t('paymentStatus.expiredBody')}</p>
          <Link to={checkoutPath} className="btn btn-primary">
            {t('paymentStatus.buyAgain')}
          </Link>
        </>
      );
    case 'REFUNDED':
      return (
        <>
          <h1 className="h3">{t('paymentStatus.refundedTitle')}</h1>
          <p>{t('paymentStatus.refundedBody')}</p>
          <Link to="/app/purchases" className="btn btn-outline-primary">
            {t('paymentStatus.viewPurchases')}
          </Link>
        </>
      );
    case 'CREATED':
      return (
        <>
          <h1 className="h3">{t('paymentStatus.pendingTitle')}</h1>
          {timedOut ? (
            <p>{t('paymentStatus.stillConfirming')}</p>
          ) : (
            <p className="d-flex align-items-center gap-2" role="status">
              <span className="spinner-border spinner-border-sm text-primary" aria-hidden="true" />
              {t('paymentStatus.pendingBody')}
            </p>
          )}
          <Link to="/app/purchases" className="btn btn-outline-primary">
            {t('paymentStatus.viewPurchases')}
          </Link>
        </>
      );
  }
}

/** Where a purchase stands; polls while the payment is being confirmed. */
export function PaymentStatusPage() {
  const { t } = useTranslation();
  const { purchaseId = '' } = useParams();
  const location = useLocation();
  const verifyFailed = Boolean((location.state as PaymentStatusState | null)?.verifyFailed);
  const purchase = usePurchase(purchaseId);
  const queryClient = useQueryClient();
  const [timedOut, setTimedOut] = useState(false);
  const status = purchase.data?.status;

  useEffect(() => {
    if (status !== 'CREATED') return;
    const timer = setTimeout(() => setTimedOut(true), PURCHASE_POLL_LIMIT_MS);
    return () => clearTimeout(timer);
  }, [status]);

  useEffect(() => {
    if (status === 'PAID' || status === 'REFUNDED') {
      void queryClient.invalidateQueries({ queryKey: queryKeys.credits });
    }
    if (status)
      void queryClient.invalidateQueries({ queryKey: paymentKeys.purchases, exact: true });
  }, [status, queryClient]);

  if (purchase.isPending) return <RouteLoading />;
  if (purchase.isError || !purchase.data) {
    return (
      <div className="container py-5" role="alert">
        <h1 className="h3">{t('paymentStatus.loadErrorTitle')}</h1>
        <p className="cb-text-secondary">{paymentErrorMessage(t, purchase.error)}</p>
        <Link to="/app/purchases" className="btn btn-outline-primary">
          {t('paymentStatus.viewPurchases')}
        </Link>
      </div>
    );
  }

  return (
    <div className="container py-5">
      <div className="row">
        <div className="col-lg-8 d-flex flex-column gap-4">
          {verifyFailed && purchase.data.status === 'CREATED' && (
            <div className="alert alert-warning mb-0" role="alert">
              {t('paymentStatus.verifyFailed')}
            </div>
          )}
          <section aria-live="polite">
            <StatusBody purchase={purchase.data} timedOut={timedOut} />
          </section>
          <section className="p-4 border cb-border rounded-3 bg-white" aria-labelledby="details">
            <h2 id="details" className="h6">
              {t('paymentStatus.detailsTitle')}
            </h2>
            <PurchaseDetails purchase={purchase.data} />
          </section>
        </div>
      </div>
    </div>
  );
}

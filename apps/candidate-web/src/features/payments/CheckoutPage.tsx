import { BRAND_NAMES } from '@cbi/design-system';
import type {
  CheckoutOrder,
  CouponRejection,
  PurchaseSummary,
  Quote,
  VerifyPaymentBody,
} from '@cbi/shared-types';
import { useQueryClient } from '@tanstack/react-query';
import { useId, useRef, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate, useParams } from 'react-router';
import { RouteLoading } from '../../app/RouteStates';
import { useCandidateAuth } from '../../app/session';
import {
  couponRejectionMessage,
  formatMoney,
  orderCouponRejection,
  paymentErrorMessage,
  validityText,
} from './payment-format';
import { paymentKeys, usePaymentsApi, useQuote } from './payments-api';
import { loadRazorpay } from './razorpay';

/** Checkout renders in Razorpay's own frame, so it needs the resolved brand colour. */
function checkoutTheme(): { color?: string } {
  const color = getComputedStyle(document.documentElement).getPropertyValue('--cb-primary').trim();
  return color ? { color } : {};
}
const COUPON_FORMAT = /^[A-Z0-9-]{3,32}$/;

/** Router state the status page reads after a failed verification. */
export interface PaymentStatusState {
  verifyFailed?: boolean;
}

function OrderSummary({ quote }: { quote: Quote }) {
  const { t, i18n } = useTranslation();
  const money = (minor: number) => formatMoney(i18n.resolvedLanguage, minor, quote.currency);
  return (
    <section className="p-4 border cb-border rounded-3 bg-white" aria-labelledby="summary-title">
      <h2 id="summary-title" className="h5">
        <i className="bi bi-receipt me-2 text-secondary" aria-hidden="true" />
        {t('checkout.summaryTitle')}
      </h2>
      <p className="fw-semibold mb-1">{quote.planName}</p>
      <p className="small cb-text-secondary">
        {t('pricing.credits', { count: quote.credits })} · {validityText(t, quote.validityDays)}
      </p>
      <dl className="row mb-0">
        <dt className="col-7 fw-normal">{t('checkout.listPrice')}</dt>
        <dd className="col-5 text-end">{money(quote.listPriceMinor)}</dd>
        {quote.discountMinor > 0 && (
          <>
            <dt className="col-7 fw-normal">
              {t('checkout.discount', { code: quote.coupon?.code ?? '' })}
            </dt>
            <dd className="col-5 text-end text-success">−{money(quote.discountMinor)}</dd>
          </>
        )}
        <dt className="col-7 border-top pt-2">{t('checkout.total')}</dt>
        <dd className="col-5 text-end border-top pt-2 fw-semibold mb-0" data-testid="total">
          {money(quote.totalMinor)}
        </dd>
      </dl>
    </section>
  );
}

function CouponForm({
  applied,
  busy,
  rejection,
  onApply,
  onRemove,
}: {
  applied: string | null;
  busy: boolean;
  rejection: CouponRejection | null;
  onApply: (code: string) => void;
  onRemove: () => void;
}) {
  const { t } = useTranslation();
  const [value, setValue] = useState('');
  const inputId = useId();
  const feedbackId = useId();

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (value.trim()) onApply(value);
  };

  return (
    <form
      className="p-4 border cb-border rounded-3 bg-white"
      onSubmit={submit}
      aria-labelledby="coupon-title"
    >
      <h2 id="coupon-title" className="h5">
        <i className="bi bi-ticket-perforated me-2 text-secondary" aria-hidden="true" />
        {t('checkout.couponTitle')}
      </h2>
      {applied && !rejection ? (
        <div className="d-flex flex-wrap align-items-center gap-2">
          <p className="mb-0" role="status">
            <i className="bi bi-check-circle-fill text-success me-1" aria-hidden="true" />
            {t('checkout.couponApplied', { code: applied })}
          </p>
          <button
            type="button"
            className="btn btn-link btn-sm"
            disabled={busy}
            onClick={() => {
              setValue('');
              onRemove();
            }}
          >
            {t('checkout.couponRemove')}
          </button>
        </div>
      ) : (
        <>
          <label htmlFor={inputId} className="form-label">
            {t('checkout.couponLabel')}
          </label>
          <div className="d-flex gap-2">
            <input
              id={inputId}
              className={`form-control text-uppercase ${rejection ? 'is-invalid' : ''}`}
              value={value}
              maxLength={32}
              autoComplete="off"
              aria-invalid={rejection ? true : undefined}
              aria-describedby={rejection ? feedbackId : undefined}
              onChange={(e) => setValue(e.target.value)}
            />
            <button
              type="submit"
              className="btn btn-outline-primary"
              disabled={busy || !value.trim()}
            >
              {t('checkout.couponApply')}
            </button>
          </div>
          {rejection && (
            <p id={feedbackId} className="small text-danger mt-2 mb-0" role="alert">
              {couponRejectionMessage(t, rejection)}
            </p>
          )}
        </>
      )}
    </form>
  );
}

function MockPanel({
  busy,
  onOutcome,
}: {
  busy: boolean;
  onOutcome: (outcome: 'success' | 'failure') => void;
}) {
  const { t } = useTranslation();
  return (
    <section
      className="p-4 border border-warning border-2 rounded-3 bg-white"
      aria-labelledby="mock-title"
    >
      <h2 id="mock-title" className="h5">
        <span className="badge text-bg-warning me-2">{t('checkout.mock.badge')}</span>
        {t('checkout.mock.title')}
      </h2>
      <p className="small cb-text-secondary">{t('checkout.mock.body')}</p>
      <div className="d-flex flex-wrap gap-2">
        <button
          type="button"
          className="btn btn-success"
          disabled={busy}
          onClick={() => onOutcome('success')}
        >
          {t('checkout.mock.success')}
        </button>
        <button
          type="button"
          className="btn btn-outline-danger"
          disabled={busy}
          onClick={() => onOutcome('failure')}
        >
          {t('checkout.mock.failure')}
        </button>
      </div>
    </section>
  );
}

/** Order summary, coupon and payment for one plan (Razorpay Checkout, or mock mode in development). */
export function CheckoutPage() {
  const { t, i18n } = useTranslation();
  const { planCode = '' } = useParams();
  const { user } = useCandidateAuth();
  const api = usePaymentsApi();
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  const [couponCode, setCouponCode] = useState<string | null>(null);
  const [localRejection, setLocalRejection] = useState<CouponRejection | null>(null);
  const [orderRejection, setOrderRejection] = useState<CouponRejection | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mockOrder, setMockOrder] = useState<CheckoutOrder | null>(null);
  const [busy, setBusy] = useState(false);
  // Guards against a double click before React re-renders the disabled button.
  const busyRef = useRef(false);

  const quote = useQuote(planCode, couponCode);

  const claim = () => {
    if (busyRef.current) return false;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    return true;
  };
  const release = () => {
    busyRef.current = false;
    setBusy(false);
  };

  const resetOrder = () => {
    setMockOrder(null);
    setOrderRejection(null);
    setError(null);
  };

  const applyCoupon = (raw: string) => {
    resetOrder();
    const code = raw.trim().toUpperCase();
    if (!COUPON_FORMAT.test(code)) {
      setLocalRejection('NOT_FOUND');
      setCouponCode(null);
      return;
    }
    setLocalRejection(null);
    setCouponCode(code);
  };
  const removeCoupon = () => {
    resetOrder();
    setLocalRejection(null);
    setCouponCode(null);
  };

  const goToStatus = async (purchaseId: string, state?: PaymentStatusState) => {
    void queryClient.invalidateQueries({ queryKey: paymentKeys.purchases, exact: true });
    await navigate(`/app/payments/${encodeURIComponent(purchaseId)}`, { state });
  };

  const verifyAndGo = async (purchaseId: string, checkout: VerifyPaymentBody) => {
    let verified: PurchaseSummary | null = null;
    try {
      verified = await api.verify(checkout);
      queryClient.setQueryData(paymentKeys.purchase(verified.id), verified);
    } catch {
      // The status page shows where the purchase stands and keeps checking.
    }
    await goToStatus(purchaseId, verified ? undefined : { verifyFailed: true });
  };

  const openRazorpay = async (order: CheckoutOrder, planName: string) => {
    const provider = order.provider!;
    let Razorpay: NonNullable<Window['Razorpay']>;
    try {
      Razorpay = await loadRazorpay();
    } catch {
      setError(t('checkout.errors.checkoutUnavailable'));
      release();
      return;
    }
    const checkout = new Razorpay({
      key: provider.keyId,
      order_id: provider.orderId,
      amount: order.totalMinor,
      currency: order.currency,
      name: BRAND_NAMES.product,
      description: planName,
      prefill: {
        ...(user?.email ? { email: user.email } : {}),
        ...(user?.mobile ? { contact: user.mobile } : {}),
      },
      theme: checkoutTheme(),
      handler: (response) => {
        void verifyAndGo(order.purchaseId, {
          razorpay_order_id: response.razorpay_order_id,
          razorpay_payment_id: response.razorpay_payment_id,
          razorpay_signature: response.razorpay_signature,
        });
      },
      modal: { ondismiss: release },
    });
    // Checkout stays open after a failed attempt so the candidate can retry there.
    checkout.on('payment.failed', () => setError(t('checkout.errors.paymentFailed')));
    checkout.open();
  };

  const pay = async (current: Quote) => {
    if (!claim()) return;
    setOrderRejection(null);
    setMockOrder(null);
    try {
      const order = await api.createOrder({
        planCode,
        couponCode: current.coupon?.applied ? current.coupon.code : null,
      });
      if (!order.provider) {
        // A 100% coupon: the purchase is already paid.
        await goToStatus(order.purchaseId);
        return;
      }
      if (order.provider.name === 'mock') {
        setMockOrder(order);
        release();
        return;
      }
      await openRazorpay(order, current.planName);
    } catch (err) {
      const rejection = orderCouponRejection(err);
      if (rejection) {
        setOrderRejection(rejection);
        void quote.refetch();
      } else {
        setError(paymentErrorMessage(t, err));
      }
      release();
    }
  };

  const mockOutcome = async (outcome: 'success' | 'failure') => {
    if (!mockOrder || !claim()) return;
    try {
      const result = await api.mockCheckout({ purchaseId: mockOrder.purchaseId, outcome });
      queryClient.setQueryData(paymentKeys.purchase(result.purchase.id), result.purchase);
      if (result.checkout) await verifyAndGo(mockOrder.purchaseId, result.checkout);
      else await goToStatus(mockOrder.purchaseId);
    } catch (err) {
      setError(paymentErrorMessage(t, err));
      release();
    }
  };

  if (quote.isPending) return <RouteLoading />;
  if (quote.isError && !quote.data) {
    return (
      <div className="container py-5" role="alert">
        <h1 className="h3">{t('checkout.loadErrorTitle')}</h1>
        <p className="cb-text-secondary">{paymentErrorMessage(t, quote.error)}</p>
        <Link to="/pricing" className="btn btn-outline-primary">
          {t('checkout.backToPricing')}
        </Link>
      </div>
    );
  }
  const current = quote.data!;
  const quoteRejection =
    current.coupon && !current.coupon.applied ? (current.coupon.rejection ?? 'NOT_FOUND') : null;
  const rejection = localRejection ?? orderRejection ?? quoteRejection;
  const requoting = quote.isFetching || quote.isPlaceholderData;

  return (
    <div className="container py-5">
      <h1 className="h3">{t('checkout.title')}</h1>
      <p className="cb-text-secondary">{t('checkout.subtitle')}</p>
      <div className="row g-4 mt-1">
        <div className="col-lg-7 d-flex flex-column gap-4">
          <OrderSummary quote={current} />
          <CouponForm
            applied={couponCode}
            busy={busy || requoting}
            rejection={rejection}
            onApply={applyCoupon}
            onRemove={removeCoupon}
          />
        </div>
        <div className="col-lg-5 d-flex flex-column gap-4">
          {quote.isError && (
            <div className="alert alert-danger mb-0" role="alert">
              {paymentErrorMessage(t, quote.error)}
            </div>
          )}
          {error && (
            <div className="alert alert-danger mb-0" role="alert">
              {error}
            </div>
          )}
          {mockOrder ? (
            <MockPanel busy={busy} onOutcome={(o) => void mockOutcome(o)} />
          ) : (
            <section
              className="p-4 border cb-border rounded-3 bg-white"
              aria-labelledby="pay-title"
            >
              <h2 id="pay-title" className="h5">
                <i className="bi bi-shield-lock me-2 text-secondary" aria-hidden="true" />
                {t('checkout.payTitle')}
              </h2>
              <p className="small cb-text-secondary">{t('checkout.payNote')}</p>
              <button
                type="button"
                className="btn btn-primary btn-lg w-100"
                disabled={busy || requoting}
                onClick={() => void pay(current)}
              >
                {busy
                  ? t('checkout.paying')
                  : t('checkout.pay', {
                      amount: formatMoney(
                        i18n.resolvedLanguage,
                        current.totalMinor,
                        current.currency,
                      ),
                    })}
              </button>
            </section>
          )}
          <Link to="/pricing" className="btn btn-link align-self-start">
            {t('checkout.backToPricing')}
          </Link>
        </div>
      </div>
    </div>
  );
}

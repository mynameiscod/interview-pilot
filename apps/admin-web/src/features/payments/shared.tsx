import type { PaymentStatus, PurchaseStatus } from '@cbi/shared-types';
import { useTranslation } from 'react-i18next';

const PURCHASE_BADGE: Record<PurchaseStatus, string> = {
  CREATED: 'text-bg-info',
  PAID: 'text-bg-success',
  FAILED: 'text-bg-danger',
  EXPIRED: 'text-bg-secondary',
  REFUNDED: 'text-bg-warning',
};

const PAYMENT_BADGE: Record<PaymentStatus, string> = {
  CREATED: 'text-bg-info',
  AUTHORIZED: 'text-bg-info',
  CAPTURED: 'text-bg-success',
  FAILED: 'text-bg-danger',
  REFUND_PENDING: 'text-bg-warning',
  REFUNDED: 'text-bg-warning',
};

export function PurchaseStatusBadge({ status }: { status: PurchaseStatus }) {
  const { t } = useTranslation();
  return (
    <span className={`badge ${PURCHASE_BADGE[status]}`}>
      {t(`payments.purchaseStatus.${status}`)}
    </span>
  );
}

export function PaymentStatusBadge({ status }: { status: PaymentStatus }) {
  const { t } = useTranslation();
  return (
    <span className={`badge ${PAYMENT_BADGE[status]}`}>
      {t(`payments.paymentStatus.${status}`)}
    </span>
  );
}

/** Field-level message for our own forms, tied to the input by id. */
export function FieldError({ id, message }: { id: string; message: string | undefined }) {
  if (!message) return null;
  return (
    <div id={id} className="invalid-feedback d-block">
      {message}
    </div>
  );
}

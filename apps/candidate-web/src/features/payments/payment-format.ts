import type { CouponRejection, PurchaseStatus } from '@cbi/shared-types';
import { ApiClientError, errorMessage } from '@cbi/web-core';
import type { TFunction } from 'i18next';

/** Formats integer minor units (paise) as currency in the UI language. */
export function formatMoney(lng: string | undefined, minor: number, currency: string): string {
  try {
    return new Intl.NumberFormat(lng, { style: 'currency', currency }).format(minor / 100);
  } catch {
    return `${currency} ${(minor / 100).toFixed(2)}`;
  }
}

/** "Valid for N days" or "No expiry". */
export function validityText(t: TFunction, validityDays: number | null): string {
  return validityDays === null
    ? t('payments.noExpiry')
    : t('payments.validFor', { count: validityDays });
}

export const STATUS_BADGE: Record<PurchaseStatus, string> = {
  CREATED: 'text-bg-warning',
  PAID: 'text-bg-success',
  FAILED: 'text-bg-danger',
  EXPIRED: 'text-bg-secondary',
  REFUNDED: 'text-bg-info',
};

export function couponRejectionMessage(t: TFunction, rejection: CouponRejection | null): string {
  return t(`payments.coupon.rejection.${rejection ?? 'NOT_FOUND'}`);
}

/** The coupon rejection carried by a 400 from POST /payments/orders, if any. */
export function orderCouponRejection(err: unknown): CouponRejection | null {
  if (!(err instanceof ApiClientError) || err.code !== 'VALIDATION_FAILED') return null;
  const rejection = (err.details as { rejection?: CouponRejection } | undefined)?.rejection;
  return rejection ?? null;
}

/** Errors from quoting, ordering and verifying, in the candidate's language. */
export function paymentErrorMessage(t: TFunction, err: unknown): string {
  if (err instanceof ApiClientError) {
    switch (err.code) {
      case 'PROVIDER_UNAVAILABLE':
        return t('payments.errors.providerUnavailable');
      case 'NOT_CONFIGURED':
        return t('payments.errors.notConfigured');
      case 'RATE_LIMITED':
        return t('payments.errors.rateLimited');
      case 'PAYMENT_VERIFICATION_FAILED':
        return t('payments.errors.verificationFailed');
      case 'NOT_FOUND':
        return t('payments.errors.planNotFound');
      case 'INVALID_STATE':
        return t('payments.errors.notPurchasable');
    }
  }
  return errorMessage(t, err);
}

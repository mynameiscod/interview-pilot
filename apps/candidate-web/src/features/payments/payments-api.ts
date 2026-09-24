import type {
  CheckoutOrder,
  CreateOrderBody,
  MockCheckoutBody,
  MockCheckoutResult,
  PublicPlan,
  PurchaseStatus,
  PurchaseSummary,
  Quote,
  QuoteBody,
  VerifyPaymentBody,
} from '@cbi/shared-types';
import type { ApiClient } from '@cbi/web-core';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { useCandidateAuth } from '../../app/session';

/** How often the status page re-checks a purchase that is awaiting confirmation. */
export const PURCHASE_POLL_MS = 3_000;
/** After this long the status page stops polling and says the credits will follow. */
export const PURCHASE_POLL_LIMIT_MS = 2 * 60_000;

function paymentsApi(api: ApiClient) {
  const enc = encodeURIComponent;
  return {
    /** Public: works signed out as well. */
    plans: () => api.get<PublicPlan[]>('/plans'),
    quote: (body: QuoteBody) => api.post<Quote>('/payments/quote', body),
    createOrder: (body: CreateOrderBody) => api.post<CheckoutOrder>('/payments/orders', body),
    verify: (body: VerifyPaymentBody) => api.post<PurchaseSummary>('/payments/verify', body),
    /** DEVELOPMENT ONLY: stands in for the customer finishing mock Checkout. */
    mockCheckout: (body: MockCheckoutBody) =>
      api.post<MockCheckoutResult>('/payments/mock/checkout', body),
    purchases: () => api.get<PurchaseSummary[]>('/payments/purchases'),
    purchase: (id: string) => api.get<PurchaseSummary>(`/payments/purchases/${enc(id)}`),
  };
}

export type PaymentsApi = ReturnType<typeof paymentsApi>;

export function usePaymentsApi(): PaymentsApi {
  const { manager } = useCandidateAuth();
  return useMemo(() => paymentsApi(manager.api), [manager]);
}

export const paymentKeys = {
  plans: ['plans'] as const,
  quote: (planCode: string, couponCode: string | null) =>
    ['payments', 'quote', planCode, couponCode] as const,
  purchases: ['payments', 'purchases'] as const,
  purchase: (id: string) => ['payments', 'purchases', id] as const,
};

export function usePlans() {
  const api = usePaymentsApi();
  return useQuery({ queryKey: paymentKeys.plans, queryFn: api.plans, staleTime: 60_000 });
}

/** Prices a plan (and coupon) on the server; the previous quote stays visible while re-quoting. */
export function useQuote(planCode: string, couponCode: string | null) {
  const api = usePaymentsApi();
  return useQuery({
    queryKey: paymentKeys.quote(planCode, couponCode),
    queryFn: () => api.quote({ planCode, couponCode }),
    placeholderData: keepPreviousData,
    // An unknown or free plan will not fix itself.
    retry: false,
  });
}

export function usePurchases() {
  const api = usePaymentsApi();
  return useQuery({ queryKey: paymentKeys.purchases, queryFn: api.purchases });
}

const awaiting = (status: PurchaseStatus | undefined) => status === 'CREATED';

/**
 * Loads a purchase and polls it while it awaits confirmation, for at most
 * PURCHASE_POLL_LIMIT_MS after the page opened.
 */
export function usePurchase(id: string) {
  const api = usePaymentsApi();
  const [openedAt] = useState(() => Date.now());
  return useQuery({
    queryKey: paymentKeys.purchase(id),
    queryFn: () => api.purchase(id),
    refetchInterval: (q) =>
      awaiting(q.state.data?.status) &&
      !q.state.error &&
      Date.now() - openedAt < PURCHASE_POLL_LIMIT_MS
        ? PURCHASE_POLL_MS
        : false,
  });
}

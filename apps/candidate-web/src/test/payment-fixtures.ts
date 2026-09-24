import type { CheckoutOrder, PublicPlan, PurchaseSummary, Quote } from '@cbi/shared-types';

const NOW = '2026-09-20T10:00:00.000Z';

export function makePlan(overrides: Partial<PublicPlan> = {}): PublicPlan {
  return {
    code: 'STARTER',
    name: 'Starter',
    description: 'A few practice interviews.',
    priceMinor: 49_900,
    currency: 'INR',
    credits: 3,
    validityDays: 90,
    features: ['Full readiness report', 'Practice plan'],
    featured: false,
    ...overrides,
  };
}

export function makeQuote(overrides: Partial<Quote> = {}): Quote {
  return {
    planCode: 'STARTER',
    planName: 'Starter',
    credits: 3,
    validityDays: 90,
    currency: 'INR',
    listPriceMinor: 49_900,
    discountMinor: 0,
    totalMinor: 49_900,
    coupon: null,
    ...overrides,
  };
}

export function makeOrder(overrides: Partial<CheckoutOrder> = {}): CheckoutOrder {
  return {
    purchaseId: 'p1',
    status: 'CREATED',
    totalMinor: 49_900,
    currency: 'INR',
    provider: { name: 'mock', keyId: 'rzp_test_mock', orderId: 'order_1' },
    ...overrides,
  };
}

export function makePurchase(overrides: Partial<PurchaseSummary> = {}): PurchaseSummary {
  return {
    id: 'p1',
    status: 'CREATED',
    plan: { code: 'STARTER', name: 'Starter', credits: 3, validityDays: 90 },
    couponCode: null,
    listPriceMinor: 49_900,
    discountMinor: 0,
    totalMinor: 49_900,
    currency: 'INR',
    creditsIssuedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

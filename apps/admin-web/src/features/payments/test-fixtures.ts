/** TEST SUPPORT ONLY: payments fixtures shared by the admin payments tests. */
import type { AdminPurchase, CouponSummary, PlanSummary } from '@cbi/shared-types';

const now = new Date().toISOString();

export const plan = (overrides: Partial<PlanSummary> = {}): PlanSummary => ({
  id: 'plan-pro-2',
  code: 'PRO',
  version: 2,
  active: true,
  name: 'Pro pack',
  description: 'Ten interviews with full reports.',
  priceMinor: 99_900,
  currency: 'INR',
  credits: 10,
  validityDays: 90,
  features: ['Full reports', 'All roles'],
  displayOrder: 20,
  featured: true,
  createdAt: now,
  ...overrides,
});

export const coupon = (overrides: Partial<CouponSummary> = {}): CouponSummary => ({
  id: 'cp1',
  code: 'LAUNCH20',
  type: 'PERCENT',
  value: 20,
  validFrom: null,
  validTo: null,
  maxUses: 100,
  perUserLimit: 1,
  usedCount: 12,
  planCodes: [],
  active: true,
  updatedAt: now,
  ...overrides,
});

export const purchase = (overrides: Partial<AdminPurchase> = {}): AdminPurchase => ({
  id: 'pur1',
  status: 'PAID',
  plan: { code: 'PRO', name: 'Pro pack', credits: 10, validityDays: 90 },
  couponCode: 'LAUNCH20',
  listPriceMinor: 99_900,
  discountMinor: 19_980,
  totalMinor: 79_920,
  currency: 'INR',
  creditsIssuedAt: now,
  createdAt: now,
  updatedAt: now,
  userId: 'user-7',
  userEmail: 'asha@example.com',
  payment: {
    provider: 'razorpay',
    orderId: 'order_ABC',
    paymentId: 'pay_XYZ',
    status: 'CAPTURED',
    signatureVerified: true,
    history: [
      { status: 'CREATED', at: now, source: 'checkout' },
      { status: 'CAPTURED', at: now, source: 'webhook' },
    ],
  },
  ...overrides,
});

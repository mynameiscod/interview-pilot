/** TEST SUPPORT ONLY: payments fixtures shared by the admin payments tests. */
import type {
  AdminCreditAccount,
  AdminPurchase,
  CouponSummary,
  PlanSummary,
  RefundPreview,
} from '@cbi/shared-types';

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
  refundedMinor: 0,
  invoiceNumber: 'CPI/26-27/000042',
  receiptAvailable: true,
  creditNotes: [],
  createdAt: now,
  updatedAt: now,
  userId: 'user-7',
  userEmail: 'asha@example.com',
  refundFailed: false,
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
    refunds: [],
  },
  ...overrides,
});

export const refundPreview = (overrides: Partial<RefundPreview> = {}): RefundPreview => ({
  currency: 'INR',
  capturedMinor: 79_920,
  refundedMinor: 0,
  refundableMinor: 79_920,
  refundable: true,
  creditsGranted: 10,
  creditsUnused: 10,
  creditsUsed: 0,
  creditsExpired: 0,
  creditsWithdrawn: 0,
  suggestedMinor: 79_920,
  ...overrides,
});

export const creditAccount = (overrides: Partial<AdminCreditAccount> = {}): AdminCreditAccount => ({
  userId: '0123456789abcdef01234567',
  userEmail: 'asha@example.com',
  balance: {
    available: 3,
    reserved: 1,
    lots: [{ source: 'PURCHASE', remaining: 3, expiresAt: now }],
  },
  ledger: [
    {
      id: 'l1',
      type: 'PURCHASE',
      amount: 4,
      refType: 'purchase',
      refId: 'pur1',
      reason: 'Sprint plan',
      createdAt: now,
    },
  ],
  ...overrides,
});

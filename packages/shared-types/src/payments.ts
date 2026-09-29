import { z } from 'zod';

/**
 * Plans, coupons, purchases and payments (Phase 6). Money is integer minor
 * units (paise) with a currency; prices are computed on the server only.
 * The credit ledger stays authoritative: a paid purchase grants one lot.
 */

/** Currencies accepted for purchases (INR at launch). */
export const PaymentCurrency = z.enum(['INR']);
export type PaymentCurrency = z.infer<typeof PaymentCurrency>;

const code = z
  .string()
  .trim()
  .min(2)
  .max(40)
  .regex(/^[A-Z0-9_]+$/, 'upper-case letters, digits and _ only');

const couponCode = z
  .string()
  .trim()
  .min(3)
  .max(32)
  .transform((s) => s.toUpperCase())
  .pipe(z.string().regex(/^[A-Z0-9-]+$/, 'letters, digits and - only'));

// ---- Plans ------------------------------------------------------------------------------

export const PlanContent = z.object({
  name: z.string().trim().min(2).max(80),
  description: z.string().trim().max(300),
  /** 0 marks a free plan (not purchasable; FREE is granted automatically). */
  priceMinor: z.number().int().min(0).max(10_000_000),
  currency: PaymentCurrency,
  credits: z.number().int().min(1).max(500),
  /** Days the credits stay usable after purchase; null = no expiry. */
  validityDays: z.number().int().min(1).max(3650).nullable(),
  features: z.array(z.string().trim().min(2).max(120)).max(10),
  displayOrder: z.number().int().min(0).max(1000),
  /** Highlighted on the pricing page. */
  featured: z.boolean(),
});
export type PlanContent = z.infer<typeof PlanContent>;

export const PlanSummary = PlanContent.extend({
  id: z.string(),
  code: z.string(),
  version: z.number().int(),
  active: z.boolean(),
  createdAt: z.iso.datetime(),
});
export type PlanSummary = z.infer<typeof PlanSummary>;

/** Public plan card: only the active version of each purchasable plan. */
export const PublicPlan = PlanContent.omit({ displayOrder: true }).extend({ code: z.string() });
export type PublicPlan = z.infer<typeof PublicPlan>;

export const CreatePlanVersionBody = z.object({
  code,
  content: PlanContent,
  reason: z.string().trim().min(3).max(300),
});
export type CreatePlanVersionBody = z.infer<typeof CreatePlanVersionBody>;

// ---- Coupons ----------------------------------------------------------------------------

export const CouponType = z.enum(['PERCENT', 'FIXED']);
export type CouponType = z.infer<typeof CouponType>;

export const UpsertCouponBody = z
  .object({
    code: couponCode,
    type: CouponType,
    /** PERCENT: 1–100; FIXED: paise off. */
    value: z.number().int().min(1).max(10_000_000),
    validFrom: z.iso.datetime().nullable().default(null),
    validTo: z.iso.datetime().nullable().default(null),
    maxUses: z.number().int().min(1).max(1_000_000).nullable().default(null),
    perUserLimit: z.number().int().min(1).max(100).default(1),
    /** Empty = all purchasable plans. */
    planCodes: z.array(code).max(20).default([]),
    active: z.boolean().default(true),
  })
  .refine((c) => c.type !== 'PERCENT' || c.value <= 100, {
    message: 'Percent coupons are 1–100',
    path: ['value'],
  })
  .refine((c) => !c.validFrom || !c.validTo || c.validFrom < c.validTo, {
    message: 'validTo must be after validFrom',
    path: ['validTo'],
  });
export type UpsertCouponBody = z.infer<typeof UpsertCouponBody>;

export const CouponSummary = z.object({
  id: z.string(),
  code: z.string(),
  type: CouponType,
  value: z.number().int(),
  validFrom: z.iso.datetime().nullable(),
  validTo: z.iso.datetime().nullable(),
  maxUses: z.number().int().nullable(),
  perUserLimit: z.number().int(),
  usedCount: z.number().int(),
  planCodes: z.array(z.string()),
  active: z.boolean(),
  updatedAt: z.iso.datetime(),
});
export type CouponSummary = z.infer<typeof CouponSummary>;

/** Why a coupon cannot be applied (shown next to the field). */
export const CouponRejection = z.enum([
  'NOT_FOUND',
  'INACTIVE',
  'NOT_STARTED',
  'EXPIRED',
  'USED_UP',
  'ALREADY_USED',
  'NOT_FOR_PLAN',
]);
export type CouponRejection = z.infer<typeof CouponRejection>;

// ---- Quotes, orders and purchases --------------------------------------------------------

export const QuoteBody = z.object({
  planCode: code,
  couponCode: couponCode.nullable().default(null),
});
export type QuoteBody = z.infer<typeof QuoteBody>;

export const Quote = z.object({
  planCode: z.string(),
  planName: z.string(),
  credits: z.number().int(),
  validityDays: z.number().int().nullable(),
  currency: PaymentCurrency,
  listPriceMinor: z.number().int(),
  discountMinor: z.number().int(),
  totalMinor: z.number().int(),
  coupon: z
    .object({ code: z.string(), applied: z.boolean(), rejection: CouponRejection.nullable() })
    .nullable(),
});
export type Quote = z.infer<typeof Quote>;

export const PurchaseStatus = z.enum(['CREATED', 'PAID', 'FAILED', 'EXPIRED', 'REFUNDED']);
export type PurchaseStatus = z.infer<typeof PurchaseStatus>;

/** What the browser needs to open Razorpay Checkout (or nothing, for a free order). */
export const CheckoutOrder = z.object({
  purchaseId: z.string(),
  status: PurchaseStatus,
  totalMinor: z.number().int(),
  currency: PaymentCurrency,
  /** Null when the total is zero and the purchase completed immediately. */
  provider: z
    .object({
      name: z.enum(['razorpay', 'mock']),
      keyId: z.string(),
      orderId: z.string(),
    })
    .nullable(),
});
export type CheckoutOrder = z.infer<typeof CheckoutOrder>;

export const CreateOrderBody = QuoteBody;
export type CreateOrderBody = z.infer<typeof CreateOrderBody>;

/** Razorpay Checkout's success handler fields, forwarded as-is. */
export const VerifyPaymentBody = z.object({
  razorpay_order_id: z.string().trim().min(1).max(64),
  razorpay_payment_id: z.string().trim().min(1).max(64),
  razorpay_signature: z
    .string()
    .trim()
    .regex(/^[a-f0-9]{64}$/i, 'invalid signature'),
});
export type VerifyPaymentBody = z.infer<typeof VerifyPaymentBody>;

export const PurchaseSummary = z.object({
  id: z.string(),
  status: PurchaseStatus,
  plan: z.object({
    code: z.string(),
    name: z.string(),
    credits: z.number().int(),
    validityDays: z.number().int().nullable(),
  }),
  couponCode: z.string().nullable(),
  listPriceMinor: z.number().int(),
  discountMinor: z.number().int(),
  totalMinor: z.number().int(),
  currency: PaymentCurrency,
  creditsIssuedAt: z.iso.datetime().nullable(),
  /** Paise refunded so far (a partial refund leaves the purchase PAID). */
  refundedMinor: z.number().int(),
  /** Assigned when the payment is captured (sequential per financial year). */
  invoiceNumber: z.string().nullable(),
  /** A receipt PDF can be downloaded (the purchase was paid, even if later refunded). */
  receiptAvailable: z.boolean(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type PurchaseSummary = z.infer<typeof PurchaseSummary>;

// ---- Admin ------------------------------------------------------------------------------------

/**
 * `REFUND_REQUESTED` is the claim an admin refund takes before the gateway
 * is called, so two refund requests can never both reach the gateway. It
 * returns to `CAPTURED` if the request fails, or after a partial refund.
 */
export const PaymentStatus = z.enum([
  'CREATED',
  'AUTHORIZED',
  'CAPTURED',
  'FAILED',
  'REFUND_REQUESTED',
  'REFUND_PENDING',
  'REFUNDED',
]);
export type PaymentStatus = z.infer<typeof PaymentStatus>;

/** One refund against a payment: requested (claimed) → pending → processed, or failed. */
export const RefundEntryStatus = z.enum(['requested', 'pending', 'processed', 'failed']);
export type RefundEntryStatus = z.infer<typeof RefundEntryStatus>;

export const AdminRefund = z.object({
  /** The gateway's refund id (null until the gateway accepted the request). */
  id: z.string().nullable(),
  amountMinor: z.number().int(),
  status: RefundEntryStatus,
  /** Unused credits to withdraw when the refund is processed. */
  creditsToWithdraw: z.number().int(),
  creditsWithdrawn: z.number().int(),
  reason: z.string().nullable(),
  requestedAt: z.iso.datetime(),
  processedAt: z.iso.datetime().nullable(),
});
export type AdminRefund = z.infer<typeof AdminRefund>;

export const AdminPurchase = PurchaseSummary.extend({
  userId: z.string(),
  userEmail: z.string().nullable(),
  /** The gateway reported a refund as failed; cleared by the next refund request. */
  refundFailed: z.boolean(),
  payment: z
    .object({
      provider: z.string(),
      orderId: z.string(),
      paymentId: z.string().nullable(),
      status: PaymentStatus,
      signatureVerified: z.boolean(),
      history: z.array(
        z.object({ status: PaymentStatus, at: z.iso.datetime(), source: z.string() }),
      ),
      refunds: z.array(AdminRefund),
    })
    .nullable(),
});
export type AdminPurchase = z.infer<typeof AdminPurchase>;

export const AdminPurchaseQuery = z.object({
  status: PurchaseStatus.optional(),
  q: z.string().trim().max(120).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type AdminPurchaseQuery = z.infer<typeof AdminPurchaseQuery>;

export const RefundBody = z.object({
  reason: z.string().trim().min(3).max(300),
  /** Paise to refund; omitted refunds everything not refunded yet. */
  amountMinor: z.number().int().min(1).max(10_000_000).optional(),
  /**
   * Unused credits to withdraw when the refund is processed; omitted withdraws
   * every unused credit. A refund that completes the full amount always
   * withdraws every unused credit.
   */
  withdrawCredits: z.number().int().min(0).max(500).optional(),
  /** Required when the candidate has already used credits from this purchase. */
  acknowledgeUsedCredits: z.boolean().default(false),
});
export type RefundBody = z.infer<typeof RefundBody>;

/** What a refund of a purchase would involve, for the admin to decide. */
export const RefundPreview = z.object({
  currency: PaymentCurrency,
  capturedMinor: z.number().int(),
  refundedMinor: z.number().int(),
  /** Captured minus already refunded (0 when not refundable now). */
  refundableMinor: z.number().int(),
  refundable: z.boolean(),
  creditsGranted: z.number().int(),
  /** Still usable in the purchase's lot. */
  creditsUnused: z.number().int(),
  /** Spent, or held by an interview in progress. */
  creditsUsed: z.number().int(),
  /** Left unused until the lot expired. */
  creditsExpired: z.number().int(),
  /** Already withdrawn by earlier refunds. */
  creditsWithdrawn: z.number().int(),
  /** Prorated to the unused credits, capped at the refundable amount. */
  suggestedMinor: z.number().int(),
});
export type RefundPreview = z.infer<typeof RefundPreview>;

/**
 * The refund suggested for a purchase: the captured amount prorated to the
 * credits still unused, never more than what is left to refund.
 */
export function proratedRefundMinor(input: {
  capturedMinor: number;
  creditsGranted: number;
  creditsUnused: number;
  refundableMinor: number;
}): number {
  if (input.creditsGranted <= 0 || input.refundableMinor <= 0) return 0;
  const unused = Math.min(Math.max(input.creditsUnused, 0), input.creditsGranted);
  const prorated = Math.floor((input.capturedMinor * unused) / input.creditsGranted);
  return Math.min(prorated, input.refundableMinor);
}

/**
 * Purchases are reconciled after this long in CREATED, and expire after a day
 * without payment. A refund claim with no gateway answer after
 * `refundClaimStaleMs` is checked with the gateway (the admin request died).
 */
export const PAYMENT_POLICY = {
  reconcileAfterMs: 30 * 60_000,
  expireAfterMs: 24 * 3600_000,
  refundClaimStaleMs: 15 * 60_000,
} as const;

// ---- Receipts and invoices ------------------------------------------------------------------

/** India's financial year (April–March, IST) that `at` falls in, as its starting year. */
export function financialYearStart(at: Date): number {
  const ist = new Date(at.getTime() + 330 * 60_000);
  const year = ist.getUTCFullYear();
  return ist.getUTCMonth() >= 3 ? year : year - 1;
}

/**
 * `CPI/26-27/000042`: consecutive per financial year and at most 16
 * characters (the GST limit for invoice numbers).
 */
export function formatInvoiceNumber(fyStart: number, seq: number): string {
  const yy = (n: number) => String(n % 100).padStart(2, '0');
  return `CPI/${yy(fyStart)}-${yy(fyStart + 1)}/${String(seq).padStart(6, '0')}`;
}

/** Splits a GST-inclusive total into its taxable value and tax (rounded to the paisa). */
export function gstBreakdown(
  totalMinor: number,
  ratePercent: number,
): { taxableMinor: number; taxMinor: number } {
  if (ratePercent <= 0) return { taxableMinor: totalMinor, taxMinor: 0 };
  const taxableMinor = Math.round((totalMinor * 100) / (100 + ratePercent));
  return { taxableMinor, taxMinor: totalMinor - taxableMinor };
}

/** Activating or retiring a plan version. */
export const PlanActivationBody = z.object({ reason: z.string().trim().min(3).max(300) });
export type PlanActivationBody = z.infer<typeof PlanActivationBody>;

/** DEVELOPMENT ONLY: stands in for the customer completing (or failing) mock Checkout. */
export const MockCheckoutBody = z.object({
  purchaseId: z.string().regex(/^[0-9a-f]{24}$/i),
  outcome: z.enum(['success', 'failure']),
});
export type MockCheckoutBody = z.infer<typeof MockCheckoutBody>;

export const MockCheckoutResult = z.object({
  /** Checkout's success fields, to send to /payments/verify as the real flow does. */
  checkout: VerifyPaymentBody.nullable(),
  purchase: PurchaseSummary,
});
export type MockCheckoutResult = z.infer<typeof MockCheckoutResult>;

export const AdminRefundResult = z.object({
  purchase: AdminPurchase,
  refundStatus: z.enum(['pending', 'processed', 'failed']),
  creditsWithdrawn: z.number().int(),
});
export type AdminRefundResult = z.infer<typeof AdminRefundResult>;

export const ReconcileOutcome = z.enum([
  'PAID',
  'REFUNDED',
  'EXPIRED',
  'PENDING',
  'AMOUNT_MISMATCH',
  'UNCHANGED',
]);
export type ReconcileOutcome = z.infer<typeof ReconcileOutcome>;

export const AdminReconcileResult = z.object({
  outcome: ReconcileOutcome,
  purchase: AdminPurchase,
});
export type AdminReconcileResult = z.infer<typeof AdminReconcileResult>;

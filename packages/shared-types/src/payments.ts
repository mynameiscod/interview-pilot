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
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type PurchaseSummary = z.infer<typeof PurchaseSummary>;

// ---- Admin ------------------------------------------------------------------------------------

export const PaymentStatus = z.enum([
  'CREATED',
  'AUTHORIZED',
  'CAPTURED',
  'FAILED',
  'REFUND_PENDING',
  'REFUNDED',
]);
export type PaymentStatus = z.infer<typeof PaymentStatus>;

export const AdminPurchase = PurchaseSummary.extend({
  userId: z.string(),
  userEmail: z.string().nullable(),
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

export const RefundBody = z.object({ reason: z.string().trim().min(3).max(300) });
export type RefundBody = z.infer<typeof RefundBody>;

/** Purchases are reconciled after this long in CREATED, and expire after a day without payment. */
export const PAYMENT_POLICY = {
  reconcileAfterMs: 30 * 60_000,
  expireAfterMs: 24 * 3600_000,
} as const;

import { CouponType, PaymentCurrency, PaymentStatus, PurchaseStatus } from '@cbi/shared-types';
import type {
  CouponType as CouponTypeT,
  PaymentCurrency as PaymentCurrencyT,
  PaymentStatus as PaymentStatusT,
  PurchaseStatus as PurchaseStatusT,
} from '@cbi/shared-types';
import mongoose, { Schema, type Model, type Types } from 'mongoose';

function model<T>(name: string, schema: Schema<T>): Model<T> {
  return (mongoose.models[name] as Model<T> | undefined) ?? mongoose.model<T>(name, schema);
}

// ---- plans (append-only by version) -------------------------------------------------------

export interface PlanRecord {
  _id: Types.ObjectId;
  code: string;
  version: number;
  active: boolean;
  name: string;
  description: string;
  priceMinor: number;
  currency: PaymentCurrencyT;
  credits: number;
  validityDays: number | null;
  features: string[];
  displayOrder: number;
  featured: boolean;
  createdBy: Types.ObjectId | null;
  reason: string | null;
  createdAt: Date;
}

const planSchema = new Schema<PlanRecord>(
  {
    code: { type: String, required: true },
    version: { type: Number, required: true },
    active: { type: Boolean, required: true, default: false },
    name: { type: String, required: true },
    description: { type: String, default: '' },
    priceMinor: { type: Number, required: true, min: 0 },
    currency: { type: String, enum: PaymentCurrency.options, required: true },
    credits: { type: Number, required: true, min: 1 },
    validityDays: { type: Number, default: null },
    features: { type: [String], default: [] },
    displayOrder: { type: Number, default: 0 },
    featured: { type: Boolean, default: false },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    reason: { type: String, default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false }, collection: 'plans' },
);
planSchema.index({ code: 1, version: 1 }, { unique: true });
planSchema.index(
  { code: 1 },
  { unique: true, partialFilterExpression: { active: true }, name: 'one_active_per_code' },
);
// Only the active flag may change; a price change is a new version.
for (const op of ['updateOne', 'updateMany', 'findOneAndUpdate'] as const) {
  planSchema.pre(op, function () {
    const update = (this.getUpdate() ?? {}) as Record<string, unknown>;
    const fields = Object.entries(update).flatMap(([k, v]) =>
      k.startsWith('$') ? Object.keys((v ?? {}) as object) : [k],
    );
    const forbidden = fields.filter((f) => f !== 'active');
    if (forbidden.length)
      throw new Error(`plan versions are immutable (attempted: ${forbidden.join(', ')})`);
  });
}

export const PlanModel = model<PlanRecord>('Plan', planSchema);

// ---- coupons ----------------------------------------------------------------------------------

export interface CouponRecord {
  _id: Types.ObjectId;
  code: string;
  type: CouponTypeT;
  value: number;
  validFrom: Date | null;
  validTo: Date | null;
  maxUses: number | null;
  perUserLimit: number;
  usedCount: number;
  planCodes: string[];
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const couponSchema = new Schema<CouponRecord>(
  {
    code: { type: String, required: true },
    type: { type: String, enum: CouponType.options, required: true },
    value: { type: Number, required: true, min: 1 },
    validFrom: { type: Date, default: null },
    validTo: { type: Date, default: null },
    maxUses: { type: Number, default: null },
    perUserLimit: { type: Number, default: 1 },
    usedCount: { type: Number, default: 0 },
    planCodes: { type: [String], default: [] },
    active: { type: Boolean, default: true },
  },
  { timestamps: true, collection: 'coupons' },
);
couponSchema.index({ code: 1 }, { unique: true });

export const CouponModel = model<CouponRecord>('Coupon', couponSchema);

/**
 * A coupon use, one per purchase (unique `purchaseId`). `RESERVED` when the
 * order is created, `REDEEMED` when it is paid, `RELEASED` when the order can
 * no longer be paid or is refunded in full. Rows written before reservations
 * existed have no status and count as `REDEEMED`.
 */
export type CouponRedemptionStatus = 'RESERVED' | 'REDEEMED' | 'RELEASED';

export interface CouponRedemptionRecord {
  _id: Types.ObjectId;
  couponId: Types.ObjectId;
  userId: Types.ObjectId;
  purchaseId: Types.ObjectId;
  status: CouponRedemptionStatus;
  redeemedAt: Date | null;
  releasedAt: Date | null;
  createdAt: Date;
}

const redemptionSchema = new Schema<CouponRedemptionRecord>(
  {
    couponId: { type: Schema.Types.ObjectId, ref: 'Coupon', required: true },
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    purchaseId: { type: Schema.Types.ObjectId, ref: 'Purchase', required: true },
    status: {
      type: String,
      enum: ['RESERVED', 'REDEEMED', 'RELEASED'],
      required: true,
      default: 'REDEEMED',
    },
    redeemedAt: { type: Date, default: null },
    releasedAt: { type: Date, default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false }, collection: 'couponRedemptions' },
);
redemptionSchema.index({ purchaseId: 1 }, { unique: true });
// Not unique: a coupon may allow several uses per user. The per-user limit is
// enforced by the unique `couponUserUsages` counter below.
redemptionSchema.index({ couponId: 1, userId: 1 });

export const CouponRedemptionModel = model<CouponRedemptionRecord>(
  'CouponRedemption',
  redemptionSchema,
);

/**
 * How many uses of a coupon one user holds (reserved or redeemed). The
 * unique (couponId, userId) index makes the guarded upsert in
 * `reserveCoupon` atomic: a second concurrent first use collides instead of
 * creating a second counter.
 */
export interface CouponUserUsageRecord {
  _id: Types.ObjectId;
  couponId: Types.ObjectId;
  userId: Types.ObjectId;
  held: number;
  updatedAt: Date;
}

const couponUsageSchema = new Schema<CouponUserUsageRecord>(
  {
    couponId: { type: Schema.Types.ObjectId, ref: 'Coupon', required: true },
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    held: { type: Number, required: true, default: 0, min: 0 },
  },
  { timestamps: { createdAt: false, updatedAt: true }, collection: 'couponUserUsages' },
);
couponUsageSchema.index({ couponId: 1, userId: 1 }, { unique: true });

export const CouponUserUsageModel = model<CouponUserUsageRecord>(
  'CouponUserUsage',
  couponUsageSchema,
);

// ---- purchases ------------------------------------------------------------------------------------

export interface PurchaseRecord {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  planId: Types.ObjectId;
  /** What was bought, frozen at order time (plans can change later). */
  plan: {
    code: string;
    version: number;
    name: string;
    credits: number;
    validityDays: number | null;
  };
  couponId: Types.ObjectId | null;
  couponCode: string | null;
  listPriceMinor: number;
  discountMinor: number;
  amountMinor: number;
  currency: PaymentCurrencyT;
  status: PurchaseStatusT;
  statusHistory: { status: PurchaseStatusT; at: Date; source: string }[];
  creditsIssuedAt: Date | null;
  creditLotId: Types.ObjectId | null;
  /** `CPI/26-27/000042`, assigned once when the purchase is paid. */
  invoiceNumber: string | null;
  invoiceIssuedAt: Date | null;
  /**
   * The buyer's GST state code (place of supply) at order time, from the
   * checkout profile; null when not given (the invoice charges IGST).
   */
  buyerState: string | null;
  createdAt: Date;
  updatedAt: Date;
}

const purchaseSchema = new Schema<PurchaseRecord>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    planId: { type: Schema.Types.ObjectId, ref: 'Plan', required: true },
    plan: {
      type: new Schema(
        {
          code: { type: String, required: true },
          version: { type: Number, required: true },
          name: { type: String, required: true },
          credits: { type: Number, required: true },
          validityDays: { type: Number, default: null },
        },
        { _id: false },
      ),
      required: true,
    },
    couponId: { type: Schema.Types.ObjectId, ref: 'Coupon', default: null },
    couponCode: { type: String, default: null },
    listPriceMinor: { type: Number, required: true },
    discountMinor: { type: Number, required: true },
    amountMinor: { type: Number, required: true, min: 0 },
    currency: { type: String, enum: PaymentCurrency.options, required: true },
    status: { type: String, enum: PurchaseStatus.options, required: true, default: 'CREATED' },
    statusHistory: {
      type: [
        new Schema(
          {
            status: { type: String, enum: PurchaseStatus.options, required: true },
            at: { type: Date, required: true },
            source: { type: String, required: true },
          },
          { _id: false },
        ),
      ],
      default: [],
    },
    creditsIssuedAt: { type: Date, default: null },
    creditLotId: { type: Schema.Types.ObjectId, default: null },
    invoiceNumber: { type: String, default: null },
    invoiceIssuedAt: { type: Date, default: null },
    buyerState: { type: String, default: null },
  },
  { timestamps: true, collection: 'purchases' },
);
purchaseSchema.index({ userId: 1, createdAt: -1 });
purchaseSchema.index({ status: 1, createdAt: 1 });
purchaseSchema.index(
  { invoiceNumber: 1 },
  {
    unique: true,
    partialFilterExpression: { invoiceNumber: { $type: 'string' } },
    name: 'unique_invoice_number',
  },
);

export const PurchaseModel = model<PurchaseRecord>('Purchase', purchaseSchema);

// ---- payments ------------------------------------------------------------------------------------------

export type RefundEntryStatus = 'requested' | 'pending' | 'processed' | 'failed';

/** One refund of a payment (several partial refunds may add up to the amount paid). */
export interface RefundEntryRecord {
  /** Our id for the entry, known before the gateway answers. */
  key: string;
  /** The gateway's refund id (null while only requested). */
  id: string | null;
  amountMinor: number;
  status: RefundEntryStatus;
  creditsToWithdraw: number;
  creditsWithdrawn: number;
  reason: string | null;
  actorId: Types.ObjectId | null;
  requestedAt: Date;
  processedAt: Date | null;
  /** `CN/26-27/000007`, issued when the refund is processed (older refunds: at first download). */
  creditNoteNumber?: string | null;
  creditNoteIssuedAt?: Date | null;
}

export interface PaymentRecord {
  _id: Types.ObjectId;
  purchaseId: Types.ObjectId;
  userId: Types.ObjectId;
  provider: 'razorpay' | 'mock';
  orderId: string;
  paymentId: string | null;
  amountMinor: number;
  currency: PaymentCurrencyT;
  status: PaymentStatusT;
  statusHistory: { status: PaymentStatusT; at: Date; source: string }[];
  signatureVerified: boolean;
  /** The latest refund (kept for older readers; `refunds` has them all). */
  refund: { id: string; amountMinor: number; status: 'pending' | 'processed' | 'failed' } | null;
  refunds: RefundEntryRecord[];
  /** Sum of processed refunds. */
  refundedMinor: number;
  /** The gateway reported a refund as failed; cleared by the next refund request. */
  refundFailed: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const paymentSchema = new Schema<PaymentRecord>(
  {
    purchaseId: { type: Schema.Types.ObjectId, ref: 'Purchase', required: true },
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    provider: { type: String, enum: ['razorpay', 'mock'], required: true },
    orderId: { type: String, required: true },
    paymentId: { type: String, default: null },
    amountMinor: { type: Number, required: true },
    currency: { type: String, enum: PaymentCurrency.options, required: true },
    status: { type: String, enum: PaymentStatus.options, required: true, default: 'CREATED' },
    statusHistory: {
      type: [
        new Schema(
          {
            status: { type: String, enum: PaymentStatus.options, required: true },
            at: { type: Date, required: true },
            source: { type: String, required: true },
          },
          { _id: false },
        ),
      ],
      default: [],
    },
    signatureVerified: { type: Boolean, default: false },
    refund: {
      type: new Schema(
        {
          id: { type: String, required: true },
          amountMinor: { type: Number, required: true },
          status: { type: String, enum: ['pending', 'processed', 'failed'], required: true },
        },
        { _id: false },
      ),
      default: null,
    },
    refunds: {
      type: [
        new Schema<RefundEntryRecord>(
          {
            key: { type: String, required: true },
            id: { type: String, default: null },
            amountMinor: { type: Number, required: true, min: 1 },
            status: {
              type: String,
              enum: ['requested', 'pending', 'processed', 'failed'],
              required: true,
            },
            creditsToWithdraw: { type: Number, required: true, default: 0 },
            creditsWithdrawn: { type: Number, required: true, default: 0 },
            reason: { type: String, default: null },
            actorId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
            requestedAt: { type: Date, required: true },
            processedAt: { type: Date, default: null },
            creditNoteNumber: { type: String, default: null },
            creditNoteIssuedAt: { type: Date, default: null },
          },
          { _id: false },
        ),
      ],
      default: [],
    },
    refundedMinor: { type: Number, required: true, default: 0, min: 0 },
    refundFailed: { type: Boolean, default: false },
  },
  { timestamps: true, collection: 'payments' },
);
paymentSchema.index({ orderId: 1 }, { unique: true });
paymentSchema.index(
  { paymentId: 1 },
  {
    unique: true,
    partialFilterExpression: { paymentId: { $type: 'string' } },
    name: 'unique_payment_id',
  },
);
paymentSchema.index({ purchaseId: 1 });
paymentSchema.index(
  { 'refunds.creditNoteNumber': 1 },
  {
    unique: true,
    partialFilterExpression: { 'refunds.creditNoteNumber': { $type: 'string' } },
    name: 'unique_credit_note_number',
  },
);
paymentSchema.index({ status: 1, updatedAt: 1 });

export const PaymentModel = model<PaymentRecord>('Payment', paymentSchema);

// ---- invoiceCounters ---------------------------------------------------------------------------

/**
 * One consecutive sequence per financial year: invoices (`_id` = `fy:2026`)
 * and credit notes (`cn:2026`).
 */
export interface InvoiceCounterRecord {
  _id: string;
  seq: number;
}

const invoiceCounterSchema = new Schema<InvoiceCounterRecord>(
  { _id: { type: String, required: true }, seq: { type: Number, required: true, default: 0 } },
  { collection: 'invoiceCounters', versionKey: false },
);

export const InvoiceCounterModel = model<InvoiceCounterRecord>(
  'InvoiceCounter',
  invoiceCounterSchema,
);

// ---- webhookEvents ------------------------------------------------------------------------------------------

export interface WebhookEventRecord {
  _id: Types.ObjectId;
  provider: string;
  eventId: string;
  type: string;
  receivedAt: Date;
  processedAt: Date | null;
  result: string | null;
}

const webhookEventSchema = new Schema<WebhookEventRecord>(
  {
    provider: { type: String, required: true },
    eventId: { type: String, required: true },
    type: { type: String, required: true },
    receivedAt: { type: Date, required: true },
    processedAt: { type: Date, default: null },
    result: { type: String, default: null },
  },
  { collection: 'webhookEvents' },
);
webhookEventSchema.index({ provider: 1, eventId: 1 }, { unique: true });
webhookEventSchema.index({ receivedAt: 1 }, { expireAfterSeconds: 180 * 24 * 3600 });

export const WebhookEventModel = model<WebhookEventRecord>('WebhookEvent', webhookEventSchema);

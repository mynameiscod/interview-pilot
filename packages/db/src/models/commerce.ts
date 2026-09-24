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

export interface CouponRedemptionRecord {
  _id: Types.ObjectId;
  couponId: Types.ObjectId;
  userId: Types.ObjectId;
  purchaseId: Types.ObjectId;
  createdAt: Date;
}

const redemptionSchema = new Schema<CouponRedemptionRecord>(
  {
    couponId: { type: Schema.Types.ObjectId, ref: 'Coupon', required: true },
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    purchaseId: { type: Schema.Types.ObjectId, ref: 'Purchase', required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false }, collection: 'couponRedemptions' },
);
redemptionSchema.index({ purchaseId: 1 }, { unique: true });
redemptionSchema.index({ couponId: 1, userId: 1 });

export const CouponRedemptionModel = model<CouponRedemptionRecord>(
  'CouponRedemption',
  redemptionSchema,
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
  },
  { timestamps: true, collection: 'purchases' },
);
purchaseSchema.index({ userId: 1, createdAt: -1 });
purchaseSchema.index({ status: 1, createdAt: 1 });

export const PurchaseModel = model<PurchaseRecord>('Purchase', purchaseSchema);

// ---- payments ------------------------------------------------------------------------------------------

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
  refund: { id: string; amountMinor: number; status: 'pending' | 'processed' | 'failed' } | null;
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

export const PaymentModel = model<PaymentRecord>('Payment', paymentSchema);

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

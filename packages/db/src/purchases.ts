import type { PaymentStatus } from '@cbi/shared-types';
import mongoose, { type ClientSession, type Types } from 'mongoose';
import { grantCredits, inTransaction, revokeLotCredits } from './credits.js';
import {
  CouponModel,
  CouponRedemptionModel,
  PaymentModel,
  PlanModel,
  PurchaseModel,
  type PurchaseRecord,
} from './models/commerce.js';
import { CreditLedgerModel } from './models/credits.js';

/**
 * Purchase state changes. Every one is a conditional update inside a
 * transaction, so the frontend verify call, the webhook and the
 * reconciliation job can all report the same payment, in any order and at
 * the same time, and credits are still issued exactly once.
 */

type Id = Types.ObjectId | string;
export type PurchaseEventSource = 'VERIFY' | 'WEBHOOK' | 'RECONCILE' | 'FREE' | 'ADMIN';

const history = (status: string, at: Date, source: string) => ({ status, at, source });

async function paymentStatus(
  purchaseId: Id,
  status: PaymentStatus,
  at: Date,
  source: string,
  set: Record<string, unknown>,
  session: ClientSession,
) {
  await PaymentModel.updateOne(
    { purchaseId },
    { $set: { status, ...set }, $push: { statusHistory: history(status, at, source) } },
    { session },
  );
}

export interface MarkPaidResult {
  /** True only for the call that moved the purchase to PAID and issued its credits. */
  issued: boolean;
  purchase: PurchaseRecord | null;
}

/** CREATED / FAILED / EXPIRED → PAID, issuing the plan's credits once. */
export async function markPurchasePaid(input: {
  purchaseId: Id;
  source: PurchaseEventSource;
  paymentId?: string | null;
  signatureVerified?: boolean;
  now?: Date;
}): Promise<MarkPaidResult> {
  const now = input.now ?? new Date();
  return inTransaction(undefined, async (tx) => {
    // A later successful attempt on the same order can follow a failed one.
    const purchase = await PurchaseModel.findOneAndUpdate(
      { _id: input.purchaseId, status: { $in: ['CREATED', 'FAILED', 'EXPIRED'] } },
      {
        $set: { status: 'PAID', creditsIssuedAt: now },
        $push: { statusHistory: history('PAID', now, input.source) },
      },
      { returnDocument: 'after', session: tx },
    ).lean<PurchaseRecord>();
    if (!purchase) {
      return {
        issued: false,
        purchase: await PurchaseModel.findById(input.purchaseId, null, {
          session: tx,
        }).lean<PurchaseRecord>(),
      };
    }
    const key = `purchase:${String(purchase._id)}`;
    await grantCredits(
      {
        userId: purchase.userId,
        amount: purchase.plan.credits,
        source: 'PURCHASE',
        idempotencyKey: key,
        expiresAt: purchase.plan.validityDays
          ? new Date(now.getTime() + purchase.plan.validityDays * 86_400_000)
          : null,
        refType: 'purchase',
        refId: String(purchase._id),
        reason: `${purchase.plan.name} plan`,
      },
      tx,
    );
    const lot = await CreditLedgerModel.findOne(
      { idempotencyKey: key },
      { lotId: 1 },
      { session: tx },
    ).lean();
    await PurchaseModel.updateOne(
      { _id: purchase._id },
      { $set: { creditLotId: lot!.lotId } },
      { session: tx },
    );
    if (purchase.couponId) {
      await CouponRedemptionModel.create(
        [{ couponId: purchase.couponId, userId: purchase.userId, purchaseId: purchase._id }],
        { session: tx },
      );
      await CouponModel.updateOne(
        { _id: purchase.couponId },
        { $inc: { usedCount: 1 } },
        { session: tx },
      );
    }
    await paymentStatus(
      purchase._id,
      'CAPTURED',
      now,
      input.source,
      {
        ...(input.paymentId ? { paymentId: input.paymentId } : {}),
        ...(input.signatureVerified ? { signatureVerified: true } : {}),
      },
      tx,
    );
    return { issued: true, purchase: { ...purchase, creditLotId: lot!.lotId } };
  });
}

/** CREATED → FAILED (a failed attempt; the order can still be paid later). */
export async function markPurchaseFailed(input: {
  purchaseId: Id;
  source: PurchaseEventSource;
  paymentId?: string | null;
  now?: Date;
}): Promise<boolean> {
  const now = input.now ?? new Date();
  return inTransaction(undefined, async (tx) => {
    const res = await PurchaseModel.updateOne(
      { _id: input.purchaseId, status: 'CREATED' },
      {
        $set: { status: 'FAILED' },
        $push: { statusHistory: history('FAILED', now, input.source) },
      },
      { session: tx },
    );
    if (res.modifiedCount === 0) return false;
    await paymentStatus(
      input.purchaseId,
      'FAILED',
      now,
      input.source,
      input.paymentId ? { paymentId: input.paymentId } : {},
      tx,
    );
    return true;
  });
}

/** CREATED / FAILED → EXPIRED when nothing was paid in time. */
export async function expirePurchase(purchaseId: Id, now = new Date()): Promise<boolean> {
  const res = await PurchaseModel.updateOne(
    { _id: purchaseId, status: { $in: ['CREATED', 'FAILED'] } },
    { $set: { status: 'EXPIRED' }, $push: { statusHistory: history('EXPIRED', now, 'RECONCILE') } },
  );
  return res.modifiedCount === 1;
}

/** Records a refund the gateway accepted but has not processed yet. */
export async function markRefundPending(input: {
  purchaseId: Id;
  refundId: string;
  amountMinor: number;
  now?: Date;
}) {
  const now = input.now ?? new Date();
  await PaymentModel.updateOne(
    { purchaseId: input.purchaseId, status: 'CAPTURED' },
    {
      $set: {
        status: 'REFUND_PENDING',
        refund: { id: input.refundId, amountMinor: input.amountMinor, status: 'pending' },
      },
      $push: { statusHistory: history('REFUND_PENDING', now, 'ADMIN') },
    },
  );
}

/**
 * PAID → REFUNDED once the gateway has processed the refund. Credits from
 * the purchase that are still unused are withdrawn; credits already spent
 * or held by an interview in progress stay with the candidate.
 */
export async function markPurchaseRefunded(input: {
  purchaseId: Id;
  refundId: string;
  source: PurchaseEventSource;
  now?: Date;
}): Promise<{ refunded: boolean; creditsWithdrawn: number }> {
  const now = input.now ?? new Date();
  return inTransaction(undefined, async (tx) => {
    const purchase = await PurchaseModel.findOneAndUpdate(
      { _id: input.purchaseId, status: 'PAID' },
      {
        $set: { status: 'REFUNDED' },
        $push: { statusHistory: history('REFUNDED', now, input.source) },
      },
      { returnDocument: 'after', session: tx },
    ).lean<PurchaseRecord>();
    if (!purchase) return { refunded: false, creditsWithdrawn: 0 };
    const creditsWithdrawn = purchase.creditLotId
      ? await revokeLotCredits(
          purchase.userId,
          purchase.creditLotId,
          `refund:${String(purchase._id)}`,
          'Purchase refunded',
          tx,
        )
      : 0;
    await PaymentModel.updateOne(
      { purchaseId: purchase._id },
      {
        $set: {
          status: 'REFUNDED',
          refund: { id: input.refundId, amountMinor: purchase.amountMinor, status: 'processed' },
        },
        $push: { statusHistory: history('REFUNDED', now, input.source) },
      },
      { session: tx },
    );
    return { refunded: true, creditsWithdrawn };
  });
}

// ---- Seed -------------------------------------------------------------------------------------------

/** Seed plans (design §11). Admins edit them later by creating new versions. */
export const SEED_PLANS = [
  {
    code: 'FREE',
    name: 'Free',
    description: 'One practice interview to try the platform, given to every new account.',
    priceMinor: 0,
    credits: 1,
    validityDays: null,
    features: ['1 practice interview', 'Full readiness report', 'Personal practice plan'],
    displayOrder: 0,
    featured: false,
  },
  {
    code: 'SPRINT',
    name: 'Sprint',
    description: 'Three interviews to practise for an upcoming interview this week.',
    priceMinor: 19_900,
    credits: 3,
    validityDays: 7,
    features: [
      '3 practice interviews',
      'Readiness reports and plans',
      'Compare your attempts',
      'Valid for 7 days',
    ],
    displayOrder: 10,
    featured: false,
  },
  {
    code: 'JOB_HUNT',
    name: 'Job hunt',
    description: 'Twelve interviews across roles and companies during an active job search.',
    priceMinor: 49_900,
    credits: 12,
    validityDays: 30,
    features: [
      '12 practice interviews',
      'Readiness reports and plans',
      'Compare your attempts',
      'Valid for 30 days',
    ],
    displayOrder: 20,
    featured: true,
  },
] as const;

/** Inserts version 1 of each seed plan whose code has no versions yet. Never changes existing plans. */
export async function ensureCommerceCatalog(): Promise<number> {
  let created = 0;
  for (const seed of SEED_PLANS) {
    if (await PlanModel.exists({ code: seed.code })) continue;
    try {
      await PlanModel.create({
        ...seed,
        features: [...seed.features],
        currency: 'INR',
        version: 1,
        active: true,
        reason: 'Seeded default',
      });
      created++;
    } catch (err) {
      if ((err as { code?: number }).code !== 11000) throw err;
    }
  }
  return created;
}

export const isObjectId = (id: string) =>
  mongoose.isValidObjectId(id) && /^[0-9a-f]{24}$/i.test(id);

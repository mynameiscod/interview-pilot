import {
  financialYearStart,
  formatCreditNoteNumber,
  formatInvoiceNumber,
  PAYMENT_POLICY,
  type PaymentStatus,
} from '@cbi/shared-types';
import mongoose, { type ClientSession, type Types } from 'mongoose';
import { grantCredits, inTransaction, revokeLotCredits } from './credits.js';
import {
  CouponModel,
  CouponRedemptionModel,
  CouponUserUsageModel,
  InvoiceCounterModel,
  PaymentModel,
  PlanModel,
  PurchaseModel,
  type CouponRecord,
  type CouponRedemptionStatus,
  type PaymentRecord,
  type PurchaseRecord,
  type RefundEntryRecord,
} from './models/commerce.js';
import { CreditLedgerModel } from './models/credits.js';

/**
 * Purchase state changes. Every one is a conditional update inside a
 * transaction, so the frontend verify call, the webhook and the
 * reconciliation job can all report the same payment, in any order and at
 * the same time, and credits are still issued exactly once.
 */

type Id = Types.ObjectId | string;
export type PurchaseEventSource = 'ORDER' | 'VERIFY' | 'WEBHOOK' | 'RECONCILE' | 'FREE' | 'ADMIN';

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

// ---- Coupon uses ------------------------------------------------------------------------------

/**
 * A coupon use is held from order creation (RESERVED) and kept when the
 * order is paid (REDEEMED). Both limits are enforced by the writes that take
 * the use, so concurrent orders cannot overrun them:
 *   - `coupons.usedCount` is incremented only while it is below `maxUses`;
 *   - the user's `couponUserUsages.held` is incremented only while it is
 *     below `perUserLimit` (one counter per coupon and user, unique index).
 * In a transaction, two orders racing for the last use write the same
 * document; one gets a write conflict, is retried by the driver, and then
 * sees the limit reached.
 */
export type CouponUnavailableReason = 'USED_UP' | 'ALREADY_USED';

export class CouponUnavailableError extends Error {
  constructor(readonly reason: CouponUnavailableReason) {
    super(`coupon unavailable: ${reason}`);
    this.name = 'CouponUnavailableError';
  }
}

/** Uses this user holds (reserved or redeemed; redemptions from before reservations count too). */
const heldFilter = (couponId: Id, userId: Id) => ({
  couponId,
  userId,
  status: { $ne: 'RELEASED' as const },
});

/** Uses of a coupon a user currently holds. */
export async function couponUsesHeld(couponId: Id, userId: Id): Promise<number> {
  const usage = await CouponUserUsageModel.findOne({ couponId, userId }, { held: 1 }).lean();
  return usage?.held ?? CouponRedemptionModel.countDocuments(heldFilter(couponId, userId));
}

/**
 * Makes sure the user's counter for a coupon exists before an order's
 * transaction takes a use from it. A new counter starts from the uses
 * already on record, so redemptions made before counters existed still
 * count (no data migration is needed). Idempotent; call outside the
 * transaction (an upsert on the unique key is retried by the server).
 */
export async function ensureCouponCounter(couponId: Id, userId: Id): Promise<void> {
  if (await CouponUserUsageModel.exists({ couponId, userId })) return;
  const held = await CouponRedemptionModel.countDocuments(heldFilter(couponId, userId));
  await CouponUserUsageModel.updateOne(
    { couponId, userId },
    { $setOnInsert: { held } },
    { upsert: true },
  );
}

/**
 * Takes one use of `coupon` for a new purchase, in the order's transaction.
 * Throws CouponUnavailableError when the coupon or the user's allowance is
 * used up. Call `ensureCouponCounter` first.
 */
export async function reserveCoupon(
  input: {
    coupon: Pick<CouponRecord, '_id' | 'perUserLimit'>;
    userId: Id;
    purchaseId: Id;
  },
  session: ClientSession,
): Promise<void> {
  const total = await CouponModel.updateOne(
    {
      _id: input.coupon._id,
      $or: [{ maxUses: null }, { $expr: { $lt: ['$usedCount', '$maxUses'] } }],
    },
    { $inc: { usedCount: 1 } },
    { session },
  );
  if (total.modifiedCount === 0) throw new CouponUnavailableError('USED_UP');
  const own = await CouponUserUsageModel.updateOne(
    {
      couponId: input.coupon._id,
      userId: input.userId,
      held: { $lt: input.coupon.perUserLimit },
    },
    { $inc: { held: 1 } },
    { session },
  );
  if (own.modifiedCount === 0) throw new CouponUnavailableError('ALREADY_USED');
  await CouponRedemptionModel.create(
    [
      {
        couponId: input.coupon._id,
        userId: input.userId,
        purchaseId: input.purchaseId,
        status: 'RESERVED',
      },
    ],
    { session },
  );
}

/** Gives a purchase's coupon use back, once (the order can no longer be paid, or was refunded). */
async function releaseCoupon(
  purchaseId: Id,
  from: CouponRedemptionStatus[],
  now: Date,
  session: ClientSession,
): Promise<boolean> {
  const redemption = await CouponRedemptionModel.findOneAndUpdate(
    {
      purchaseId,
      // Rows from before reservations have no status and count as REDEEMED.
      $or: [
        { status: { $in: from } },
        ...(from.includes('REDEEMED') ? [{ status: { $exists: false } }] : []),
      ],
    },
    { $set: { status: 'RELEASED', releasedAt: now } },
    { session },
  ).lean();
  if (!redemption) return false;
  await CouponUserUsageModel.updateOne(
    { couponId: redemption.couponId, userId: redemption.userId, held: { $gt: 0 } },
    { $inc: { held: -1 } },
    { session },
  );
  await CouponModel.updateOne(
    { _id: redemption.couponId, usedCount: { $gt: 0 } },
    { $inc: { usedCount: -1 } },
    { session },
  );
  return true;
}

/**
 * Turns the purchase's reservation into a redemption. Without a live
 * reservation (a late payment after the order expired, or an order from
 * before reservations) the use is recorded anyway: the money was taken, so
 * the limits do not apply.
 */
async function redeemCoupon(purchase: PurchaseRecord, now: Date, session: ClientSession) {
  if (!purchase.couponId) return;
  const reserved = await CouponRedemptionModel.updateOne(
    { purchaseId: purchase._id, status: 'RESERVED' },
    { $set: { status: 'REDEEMED', redeemedAt: now } },
    { session },
  );
  if (reserved.modifiedCount === 1) return;
  const existing = await CouponRedemptionModel.findOne({ purchaseId: purchase._id }, null, {
    session,
  }).lean();
  if (existing && existing.status !== 'RELEASED') return;
  await CouponModel.updateOne({ _id: purchase.couponId }, { $inc: { usedCount: 1 } }, { session });
  await CouponUserUsageModel.updateOne(
    { couponId: purchase.couponId, userId: purchase.userId },
    { $inc: { held: 1 } },
    { upsert: true, session },
  );
  if (existing) {
    await CouponRedemptionModel.updateOne(
      { _id: existing._id },
      { $set: { status: 'REDEEMED', redeemedAt: now, releasedAt: null } },
      { session },
    );
  } else {
    await CouponRedemptionModel.create(
      [
        {
          couponId: purchase.couponId,
          userId: purchase.userId,
          purchaseId: purchase._id,
          status: 'REDEEMED',
          redeemedAt: now,
        },
      ],
      { session },
    );
  }
}

// ---- Invoice numbers ----------------------------------------------------------------------------

/**
 * Gives a paid (or since refunded) purchase the next invoice number of the
 * financial year it was paid in, once. In a transaction, so a number is
 * never taken without being stored (the sequence has no gaps).
 */
export async function issueInvoiceNumber(
  purchaseId: Id,
  at = new Date(),
  session?: ClientSession,
): Promise<string | null> {
  return inTransaction(session, async (tx) => {
    const purchase = await PurchaseModel.findById(
      purchaseId,
      { invoiceNumber: 1, status: 1, creditsIssuedAt: 1 },
      { session: tx },
    ).lean<Pick<PurchaseRecord, 'invoiceNumber' | 'status' | 'creditsIssuedAt'>>();
    if (!purchase) return null;
    if (purchase.invoiceNumber) return purchase.invoiceNumber;
    if (purchase.status !== 'PAID' && purchase.status !== 'REFUNDED') return null;
    const fy = financialYearStart(purchase.creditsIssuedAt ?? at);
    const counter = await InvoiceCounterModel.findOneAndUpdate(
      { _id: `fy:${fy}` },
      { $inc: { seq: 1 } },
      { upsert: true, returnDocument: 'after', session: tx },
    ).lean();
    const invoiceNumber = formatInvoiceNumber(fy, counter!.seq);
    // A concurrent issuer writes the same purchase: one of the two transactions retries.
    await PurchaseModel.updateOne(
      { _id: purchaseId, invoiceNumber: null },
      { $set: { invoiceNumber, invoiceIssuedAt: at } },
      { session: tx },
    );
    return invoiceNumber;
  });
}

/** The next credit note number of the financial year `at` falls in (inside `session`). */
async function nextCreditNoteNumber(at: Date, session: ClientSession): Promise<string> {
  const fy = financialYearStart(at);
  const counter = await InvoiceCounterModel.findOneAndUpdate(
    { _id: `cn:${fy}` },
    { $inc: { seq: 1 } },
    { upsert: true, returnDocument: 'after', session },
  ).lean();
  return formatCreditNoteNumber(fy, counter!.seq);
}

/**
 * The credit note number of a processed refund (`key` is the refund entry's
 * key), issuing one for a refund processed before credit notes existed.
 * Null when there is no such processed refund.
 */
export async function issueCreditNoteNumber(
  purchaseId: Id,
  key: string,
  at = new Date(),
): Promise<{ number: string; issuedAt: Date } | null> {
  return inTransaction(undefined, async (tx) => {
    const payment = await PaymentModel.findOne(
      { purchaseId },
      { refunds: 1 },
      { session: tx },
    ).lean<Pick<PaymentRecord, '_id' | 'refunds'>>();
    const entry = payment?.refunds?.find((r) => r.key === key && r.status === 'processed');
    if (!payment || !entry) return null;
    if (entry.creditNoteNumber) {
      return { number: entry.creditNoteNumber, issuedAt: entry.creditNoteIssuedAt ?? at };
    }
    const number = await nextCreditNoteNumber(at, tx);
    // A concurrent issuer writes the same payment: one of the two transactions retries.
    await PaymentModel.updateOne(
      { _id: payment._id },
      {
        $set: {
          'refunds.$[r].creditNoteNumber': number,
          'refunds.$[r].creditNoteIssuedAt': at,
        },
      },
      { session: tx, arrayFilters: [{ 'r.key': key, 'r.creditNoteNumber': null }] },
    );
    return { number, issuedAt: at };
  });
}

// ---- Payment outcomes -------------------------------------------------------------------------

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
    await redeemCoupon(purchase, now, tx);
    const invoiceNumber = await issueInvoiceNumber(purchase._id, now, tx);
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
    return {
      issued: true,
      purchase: { ...purchase, creditLotId: lot!.lotId, invoiceNumber, invoiceIssuedAt: now },
    };
  });
}

/**
 * CREATED → FAILED (a failed attempt; the order can still be paid later, so
 * its coupon use is kept). With source ORDER no gateway order was created,
 * so nothing can be paid and the coupon use is released.
 */
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
    if (input.source === 'ORDER') await releaseCoupon(input.purchaseId, ['RESERVED'], now, tx);
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

/** CREATED / FAILED → EXPIRED when nothing was paid in time; its coupon use is released. */
export async function expirePurchase(purchaseId: Id, now = new Date()): Promise<boolean> {
  return inTransaction(undefined, async (tx) => {
    const res = await PurchaseModel.updateOne(
      { _id: purchaseId, status: { $in: ['CREATED', 'FAILED'] } },
      {
        $set: { status: 'EXPIRED' },
        $push: { statusHistory: history('EXPIRED', now, 'RECONCILE') },
      },
      { session: tx },
    );
    if (res.modifiedCount !== 1) return false;
    await releaseCoupon(purchaseId, ['RESERVED'], now, tx);
    return true;
  });
}

// ---- Refunds ------------------------------------------------------------------------------------

/**
 * A refund is claimed before the gateway is called: CAPTURED →
 * REFUND_REQUESTED in one conditional update that also checks the amount
 * left to refund. Of two concurrent requests exactly one gets the claim, so
 * the gateway is never asked twice. The claim then becomes REFUND_PENDING
 * (the gateway accepted it) or is released back to CAPTURED (it refused).
 * When the refund is processed the payment is REFUNDED if everything has
 * been refunded, else CAPTURED again (a partial refund).
 */
export interface RefundClaim {
  /** Our id for the refund entry. */
  key: string;
  payment: PaymentRecord;
}

const OPEN_REFUND: RefundEntryRecord['status'][] = ['requested', 'pending'];

export async function claimRefund(
  input: {
    purchaseId: Id;
    amountMinor: number;
    creditsToWithdraw: number;
    reason: string;
    actorId: Id | null;
    now?: Date;
  },
  session?: ClientSession,
): Promise<RefundClaim | null> {
  const now = input.now ?? new Date();
  const key = new mongoose.Types.ObjectId().toHexString();
  const entry: RefundEntryRecord = {
    key,
    id: null,
    amountMinor: input.amountMinor,
    status: 'requested',
    creditsToWithdraw: input.creditsToWithdraw,
    creditsWithdrawn: 0,
    reason: input.reason,
    actorId: input.actorId ? new mongoose.Types.ObjectId(String(input.actorId)) : null,
    requestedAt: now,
    processedAt: null,
  };
  const payment = await PaymentModel.findOneAndUpdate(
    {
      purchaseId: input.purchaseId,
      status: 'CAPTURED',
      paymentId: { $type: 'string' },
      $expr: {
        $lte: [{ $add: [{ $ifNull: ['$refundedMinor', 0] }, input.amountMinor] }, '$amountMinor'],
      },
    },
    {
      $set: { status: 'REFUND_REQUESTED', refundFailed: false },
      $push: {
        refunds: entry,
        statusHistory: history('REFUND_REQUESTED', now, 'ADMIN'),
      },
    },
    { returnDocument: 'after', session },
  ).lean<PaymentRecord>();
  return payment ? { key, payment } : null;
}

/** The gateway refused (or never received) the request: back to CAPTURED, so it can be retried. */
export async function releaseRefundClaim(input: {
  purchaseId: Id;
  key: string;
  source?: PurchaseEventSource;
  now?: Date;
}): Promise<boolean> {
  const now = input.now ?? new Date();
  const res = await PaymentModel.updateOne(
    {
      purchaseId: input.purchaseId,
      status: 'REFUND_REQUESTED',
      refunds: { $elemMatch: { key: input.key, status: 'requested' } },
    },
    {
      $set: { status: 'CAPTURED', 'refunds.$.status': 'failed' },
      $push: { statusHistory: history('CAPTURED', now, input.source ?? 'ADMIN') },
    },
  );
  return res.modifiedCount === 1;
}

/** Records the refund the gateway accepted but has not processed yet. */
export async function markRefundPending(input: {
  purchaseId: Id;
  key: string;
  refundId: string;
  amountMinor: number;
  now?: Date;
}): Promise<boolean> {
  const now = input.now ?? new Date();
  const res = await PaymentModel.updateOne(
    {
      purchaseId: input.purchaseId,
      status: 'REFUND_REQUESTED',
      refunds: { $elemMatch: { key: input.key, status: 'requested' } },
    },
    {
      $set: {
        status: 'REFUND_PENDING',
        'refunds.$.id': input.refundId,
        'refunds.$.status': 'pending',
        refund: { id: input.refundId, amountMinor: input.amountMinor, status: 'pending' },
      },
      $push: { statusHistory: history('REFUND_PENDING', now, 'ADMIN') },
    },
  );
  if (res.modifiedCount === 1) return true;
  // The claim was released meanwhile (stale); keep the gateway id so the webhook still matches it.
  await PaymentModel.updateOne(
    { purchaseId: input.purchaseId, 'refunds.key': input.key },
    { $set: { 'refunds.$.id': input.refundId } },
  );
  return false;
}

export interface RefundProcessedResult {
  /** True only for the call that applied this refund. */
  refunded: boolean;
  /** Everything paid has now been refunded (the purchase is REFUNDED). */
  fully: boolean;
  creditsWithdrawn: number;
}

/**
 * Applies a refund the gateway has processed, once per gateway refund id.
 * Unused credits from the purchase are withdrawn: all of them when the
 * refund completes the full amount, else the number the admin chose. Credits
 * already spent or held by an interview in progress stay with the candidate.
 * A refund we did not request (made in the gateway dashboard) is recorded
 * too, for `amountMinor` (default: everything not refunded yet).
 */
export async function markPurchaseRefunded(input: {
  purchaseId: Id;
  refundId: string;
  source: PurchaseEventSource;
  amountMinor?: number;
  now?: Date;
}): Promise<RefundProcessedResult> {
  const now = input.now ?? new Date();
  const none: RefundProcessedResult = { refunded: false, fully: false, creditsWithdrawn: 0 };
  return inTransaction(undefined, async (tx) => {
    const purchase = await PurchaseModel.findById(input.purchaseId, null, {
      session: tx,
    }).lean<PurchaseRecord>();
    const payment = await PaymentModel.findOne({ purchaseId: input.purchaseId }, null, {
      session: tx,
    }).lean<PaymentRecord>();
    if (!purchase || !payment || purchase.status !== 'PAID') return none;
    // Read-modify-write inside the transaction: a concurrent change to the
    // payment makes one transaction conflict and retry with fresh data.
    const refunds = (payment.refunds ?? []).map((r) => ({ ...r }));
    let entry =
      refunds.find((r) => r.id === input.refundId) ??
      // Our request whose answer was lost: the gateway's refund is that claim.
      refunds.find(
        (r) =>
          r.id === null &&
          r.status === 'requested' &&
          (input.amountMinor === undefined || r.amountMinor === input.amountMinor),
      );
    if (entry?.status === 'processed') return none;
    const refundedBefore = payment.refundedMinor ?? 0;
    if (!entry) {
      const amountMinor = input.amountMinor ?? payment.amountMinor - refundedBefore;
      if (amountMinor <= 0) return none;
      entry = {
        key: new mongoose.Types.ObjectId().toHexString(),
        id: input.refundId,
        amountMinor,
        status: 'pending',
        creditsToWithdraw: 0,
        creditsWithdrawn: 0,
        reason: null,
        actorId: null,
        requestedAt: now,
        processedAt: null,
      };
      refunds.push(entry);
    }
    const refundedMinor = refundedBefore + entry.amountMinor;
    const fully = refundedMinor >= payment.amountMinor;
    const creditsWithdrawn =
      purchase.creditLotId && (fully || entry.creditsToWithdraw > 0)
        ? await revokeLotCredits(
            purchase.userId,
            purchase.creditLotId,
            `refund:${String(purchase._id)}:${input.refundId}`,
            fully ? 'Purchase refunded' : 'Purchase partly refunded',
            tx,
            fully ? Number.POSITIVE_INFINITY : entry.creditsToWithdraw,
          )
        : 0;
    Object.assign(entry, {
      id: input.refundId,
      status: 'processed',
      processedAt: now,
      creditsWithdrawn,
      // Numbered in the same transaction, so the series has no gaps.
      creditNoteNumber: await nextCreditNoteNumber(now, tx),
      creditNoteIssuedAt: now,
    });
    const stillOpen = refunds.some((r) => OPEN_REFUND.includes(r.status));
    const status: PaymentStatus = fully
      ? 'REFUNDED'
      : stillOpen
        ? payment.status
        : payment.status === 'REFUND_PENDING' || payment.status === 'REFUND_REQUESTED'
          ? 'CAPTURED'
          : payment.status;
    await PaymentModel.updateOne(
      { _id: payment._id },
      {
        $set: {
          refunds,
          refundedMinor,
          status,
          refund: { id: input.refundId, amountMinor: entry.amountMinor, status: 'processed' },
        },
        $push: { statusHistory: history(status, now, input.source) },
      },
      { session: tx },
    );
    if (fully) {
      await PurchaseModel.updateOne(
        { _id: purchase._id, status: 'PAID' },
        {
          $set: { status: 'REFUNDED' },
          $push: { statusHistory: history('REFUNDED', now, input.source) },
        },
        { session: tx },
      );
      await releaseCoupon(purchase._id, ['REDEEMED'], now, tx);
    }
    return { refunded: true, fully, creditsWithdrawn };
  });
}

/**
 * The gateway reported a refund as failed: the payment is flagged for the
 * admin and returns to CAPTURED (so the refund can be requested again).
 * Returns what failed, or null when there is nothing to change.
 */
export async function markRefundFailed(input: {
  paymentId: string;
  refundId: string;
  amountMinor?: number;
  now?: Date;
}): Promise<{ purchaseId: Types.ObjectId; amountMinor: number } | null> {
  const now = input.now ?? new Date();
  return inTransaction(undefined, async (tx) => {
    const payment = await PaymentModel.findOne({ paymentId: input.paymentId }, null, {
      session: tx,
    }).lean<PaymentRecord>();
    if (!payment) return null;
    const refunds = (payment.refunds ?? []).map((r) => ({ ...r }));
    const entry =
      refunds.find((r) => r.id === input.refundId) ??
      refunds.find((r) => r.id === null && r.status === 'requested');
    if (entry && entry.status !== 'pending' && entry.status !== 'requested') return null;
    if (entry) Object.assign(entry, { id: input.refundId, status: 'failed' });
    const amountMinor = entry?.amountMinor ?? input.amountMinor ?? 0;
    const stillOpen = refunds.some((r) => OPEN_REFUND.includes(r.status));
    const reopen =
      !stillOpen && (payment.status === 'REFUND_PENDING' || payment.status === 'REFUND_REQUESTED');
    await PaymentModel.updateOne(
      { _id: payment._id },
      {
        $set: {
          refunds,
          refundFailed: true,
          ...(reopen ? { status: 'CAPTURED' } : {}),
          refund: { id: input.refundId, amountMinor, status: 'failed' },
        },
        ...(reopen ? { $push: { statusHistory: history('CAPTURED', now, 'WEBHOOK') } } : {}),
      },
      { session: tx },
    );
    return { purchaseId: payment.purchaseId, amountMinor };
  });
}

// ---- Reconciliation --------------------------------------------------------------------------

/** The part of a payment gateway reconciliation needs (structural, so db has no adapter dependency). */
export interface ReconcileGateway {
  fetchOrderPayments(
    orderId: string,
  ): Promise<{ id: string; amountMinor: number; currency: string; status: string }[]>;
  fetchPayment(
    paymentId: string,
  ): Promise<{ id: string; status: string; amountRefundedMinor?: number }>;
}

export type ReconcileOutcome =
  'PAID' | 'REFUNDED' | 'EXPIRED' | 'PENDING' | 'AMOUNT_MISMATCH' | 'UNCHANGED';

/** Completes (or clears) the refund a paid purchase has open with the gateway. */
async function reconcileRefund(
  purchaseId: Id,
  payment: PaymentRecord,
  gateway: ReconcileGateway,
  now: Date,
): Promise<ReconcileOutcome> {
  const open = (payment.refunds ?? []).find((r) => OPEN_REFUND.includes(r.status));
  // Refunds requested before entries were recorded.
  const legacy =
    !open && payment.status === 'REFUND_PENDING' && payment.refund ? payment.refund : null;
  if ((!open && !legacy) || !payment.paymentId) return 'UNCHANGED';
  // A claim younger than this is an admin request still waiting for the gateway.
  if (
    open?.status === 'requested' &&
    now.getTime() - open.requestedAt.getTime() < PAYMENT_POLICY.refundClaimStaleMs
  ) {
    return 'PENDING';
  }
  const remote = await gateway.fetchPayment(payment.paymentId);
  const target = (payment.refundedMinor ?? 0) + (open?.amountMinor ?? legacy!.amountMinor);
  const done = remote.status === 'refunded' || (remote.amountRefundedMinor ?? 0) >= target;
  if (open?.status === 'requested') {
    if (done) return 'PENDING'; // The gateway has it; its refund.processed webhook names the refund.
    // The request never reached the gateway (the process died): release the claim.
    await releaseRefundClaim({ purchaseId, key: open.key, source: 'RECONCILE', now });
    return 'UNCHANGED';
  }
  if (!done) return 'PENDING';
  await markPurchaseRefunded({
    purchaseId,
    refundId: open?.id ?? legacy!.id,
    source: 'RECONCILE',
    now,
  });
  return 'REFUNDED';
}

/**
 * Asks the gateway what happened to a purchase whose outcome we never heard
 * about (closed browser, lost webhook). Captured payments are credited; an
 * order unpaid after `expireAfterMs` expires; a pending refund the gateway
 * has processed is completed. Safe to run at any time and in parallel with
 * verify and webhooks.
 */
export async function reconcilePurchase(
  purchaseId: Id,
  gateway: ReconcileGateway,
  opts: { expireAfterMs: number; now?: Date },
): Promise<ReconcileOutcome> {
  const now = opts.now ?? new Date();
  const purchase = await PurchaseModel.findById(purchaseId).lean<PurchaseRecord>();
  const payment = await PaymentModel.findOne({ purchaseId }).lean<PaymentRecord>();
  if (!purchase || !payment) return 'UNCHANGED';

  if (purchase.status === 'PAID') return reconcileRefund(purchaseId, payment, gateway, now);
  if (purchase.status === 'REFUNDED') return 'UNCHANGED';

  const payments = await gateway.fetchOrderPayments(payment.orderId);
  const captured = payments.filter((p) => p.status === 'captured');
  const match = captured.find(
    (p) => p.amountMinor === payment.amountMinor && p.currency === payment.currency,
  );
  if (match) {
    await markPurchasePaid({ purchaseId, source: 'RECONCILE', paymentId: match.id, now });
    return 'PAID';
  }
  if (captured.length > 0) return 'AMOUNT_MISMATCH';
  if (
    purchase.status !== 'EXPIRED' &&
    now.getTime() - purchase.createdAt.getTime() >= opts.expireAfterMs
  ) {
    return (await expirePurchase(purchaseId, now)) ? 'EXPIRED' : 'UNCHANGED';
  }
  return purchase.status === 'EXPIRED' ? 'UNCHANGED' : 'PENDING';
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

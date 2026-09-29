import type { Logger } from '@cbi/config';
import {
  claimRefund,
  CouponModel,
  CouponUnavailableError,
  couponUsesHeld,
  ensureCouponCounter,
  issueCreditNoteNumber,
  issueInvoiceNumber,
  lotUsage,
  markPurchaseFailed,
  markPurchasePaid,
  markPurchaseRefunded,
  markRefundFailed,
  markRefundPending,
  PaymentModel,
  PlanModel,
  PurchaseModel,
  reconcilePurchase,
  releaseRefundClaim,
  reserveCoupon,
  UserModel,
  UserProfileModel,
  WebhookEventModel,
  type CouponRecord,
  type PaymentRecord,
  type PlanRecord,
  type PurchaseRecord,
  type ReconcileOutcome,
} from '@cbi/db';
import { NotConfiguredError, type PaymentGateway } from '@cbi/provider-adapters';
import {
  GstStateCode,
  PAYMENT_POLICY,
  proratedRefundMinor,
  type AdminPurchase,
  type AdminPurchaseQuery,
  type AdminRefundResult,
  type BillingSetting,
  type CheckoutOrder,
  type CheckoutProfile,
  type CouponRejection,
  type CouponSummary,
  type CreateOrderBody,
  type CreatePlanVersionBody,
  type PlanSummary,
  type PublicPlan,
  type PurchaseSummary,
  type Quote,
  type QuoteBody,
  type RefundBody,
  type RefundPreview,
  type UpsertCouponBody,
  type VerifyPaymentBody,
} from '@cbi/shared-types';
import type { AuditService } from '../../lib/audit.js';
import { AppError } from '../../lib/errors.js';
import { iso, objectId } from '../../lib/ids.js';
import type { ClientContext } from '../../lib/request-context.js';
import { transaction } from '../../lib/transaction.js';
import { renderCreditNotePdf, renderReceiptPdf } from './receipt-pdf.js';

/** Razorpay's smallest chargeable amount (₹1). Discounted totals below it are raised to it. */
export const MIN_CHARGE_MINOR = 100;

// ---- Mappers ------------------------------------------------------------------------------

export const planSummary = (p: PlanRecord): PlanSummary => ({
  id: String(p._id),
  code: p.code,
  version: p.version,
  active: p.active,
  name: p.name,
  description: p.description,
  priceMinor: p.priceMinor,
  currency: p.currency,
  credits: p.credits,
  validityDays: p.validityDays,
  features: p.features,
  displayOrder: p.displayOrder,
  featured: p.featured,
  createdAt: iso(p.createdAt),
});

export const couponSummary = (c: CouponRecord): CouponSummary => ({
  id: String(c._id),
  code: c.code,
  type: c.type,
  value: c.value,
  validFrom: c.validFrom ? iso(c.validFrom) : null,
  validTo: c.validTo ? iso(c.validTo) : null,
  maxUses: c.maxUses,
  perUserLimit: c.perUserLimit,
  usedCount: c.usedCount,
  planCodes: c.planCodes,
  active: c.active,
  updatedAt: iso(c.updatedAt),
});

/** A receipt exists for anything that was paid, including purchases refunded since. */
const receiptAvailable = (p: PurchaseRecord) => p.status === 'PAID' || p.status === 'REFUNDED';

/** Processed refunds, each with its credit note (numbered unless processed before they existed). */
const creditNotes = (payment: Pick<PaymentRecord, 'refunds'> | null) =>
  (payment?.refunds ?? [])
    .filter((r) => r.status === 'processed')
    .map((r) => ({
      key: r.key,
      number: r.creditNoteNumber ?? null,
      amountMinor: r.amountMinor,
      processedAt: r.processedAt ? iso(r.processedAt) : null,
    }));

export const purchaseSummary = (
  p: PurchaseRecord,
  payment: Pick<PaymentRecord, 'refundedMinor' | 'refunds'> | null = null,
): PurchaseSummary => ({
  id: String(p._id),
  status: p.status,
  plan: {
    code: p.plan.code,
    name: p.plan.name,
    credits: p.plan.credits,
    validityDays: p.plan.validityDays,
  },
  couponCode: p.couponCode,
  listPriceMinor: p.listPriceMinor,
  discountMinor: p.discountMinor,
  totalMinor: p.amountMinor,
  currency: p.currency,
  creditsIssuedAt: p.creditsIssuedAt ? iso(p.creditsIssuedAt) : null,
  refundedMinor: payment?.refundedMinor ?? (p.status === 'REFUNDED' ? p.amountMinor : 0),
  invoiceNumber: p.invoiceNumber ?? null,
  receiptAvailable: receiptAvailable(p),
  creditNotes: creditNotes(payment),
  createdAt: iso(p.createdAt),
  updatedAt: iso(p.updatedAt),
});

function adminPurchase(
  p: PurchaseRecord,
  payment: PaymentRecord | null,
  email: string | null,
): AdminPurchase {
  return {
    ...purchaseSummary(p, payment),
    userId: String(p.userId),
    userEmail: email,
    refundFailed: payment?.refundFailed ?? false,
    payment: payment
      ? {
          provider: payment.provider,
          orderId: payment.orderId,
          paymentId: payment.paymentId,
          status: payment.status,
          signatureVerified: payment.signatureVerified,
          history: payment.statusHistory.map((h) => ({
            status: h.status,
            at: iso(h.at),
            source: h.source,
          })),
          refunds: (payment.refunds ?? []).map((r) => ({
            id: r.id,
            amountMinor: r.amountMinor,
            status: r.status,
            creditsToWithdraw: r.creditsToWithdraw,
            creditsWithdrawn: r.creditsWithdrawn,
            reason: r.reason,
            requestedAt: iso(r.requestedAt),
            processedAt: r.processedAt ? iso(r.processedAt) : null,
          })),
        }
      : null,
  };
}

// ---- Pricing (pure) -------------------------------------------------------------------------

/** Why `coupon` cannot be used for `planCode` by a user who already redeemed it `redeemed` times. */
export function couponRejection(
  coupon: CouponRecord | null,
  planCode: string,
  redeemed: number,
  now: Date,
): CouponRejection | null {
  if (!coupon) return 'NOT_FOUND';
  if (!coupon.active) return 'INACTIVE';
  if (coupon.validFrom && coupon.validFrom > now) return 'NOT_STARTED';
  if (coupon.validTo && coupon.validTo <= now) return 'EXPIRED';
  if (coupon.maxUses !== null && coupon.usedCount >= coupon.maxUses) return 'USED_UP';
  if (coupon.planCodes.length > 0 && !coupon.planCodes.includes(planCode)) return 'NOT_FOR_PLAN';
  if (redeemed >= coupon.perUserLimit) return 'ALREADY_USED';
  return null;
}

/** Discount in minor units; a non-zero total is never below the gateway minimum. */
export function priceWithCoupon(
  listMinor: number,
  coupon: Pick<CouponRecord, 'type' | 'value'> | null,
): { discountMinor: number; totalMinor: number } {
  if (!coupon) return { discountMinor: 0, totalMinor: listMinor };
  const raw =
    coupon.type === 'PERCENT'
      ? Math.floor((listMinor * coupon.value) / 100)
      : Math.min(coupon.value, listMinor);
  let total = listMinor - raw;
  if (total > 0 && total < MIN_CHARGE_MINOR) total = Math.min(MIN_CHARGE_MINOR, listMinor);
  return { discountMinor: listMinor - total, totalMinor: total };
}

// ---- Service --------------------------------------------------------------------------------

export interface PaymentsServiceDeps {
  gateway: PaymentGateway;
  audit: AuditService;
  logger: Logger;
  /** The seller details printed on receipts (System → Settings → Billing). */
  billing: () => Promise<BillingSetting>;
  /**
   * RECEIPT_FONT_PATH: one font used for all receipt text instead of the
   * embedded Noto / Hind Guntur fonts (which cover English, Hindi and Telugu).
   */
  receiptFontPath?: string | null;
}

export type WebhookResult =
  | 'INVALID_SIGNATURE'
  | 'DUPLICATE'
  | 'PAID'
  | 'ALREADY_PAID'
  | 'FAILED'
  | 'REFUNDED'
  | 'REFUND_FAILED'
  | 'UNKNOWN_ORDER'
  | 'AMOUNT_MISMATCH'
  | 'IGNORED';

export function createPaymentsService(deps: PaymentsServiceDeps) {
  const { gateway, audit, logger } = deps;
  const refundInProgress = () =>
    new AppError(
      409,
      'INVALID_STATE',
      'A refund is already in progress for this purchase, or its refundable amount changed. Reload and try again.',
    );

  async function activePlan(code: string) {
    const plan = await PlanModel.findOne({ code, active: true }).lean<PlanRecord>();
    if (!plan) throw AppError.notFound('Plan not found');
    if (plan.priceMinor === 0) {
      throw new AppError(409, 'INVALID_STATE', 'This plan is free and cannot be purchased.');
    }
    return plan;
  }

  async function price(userId: string, body: QuoteBody, now = new Date()) {
    const plan = await activePlan(body.planCode);
    let coupon: CouponRecord | null = null;
    let rejection: CouponRejection | null = null;
    if (body.couponCode) {
      coupon = await CouponModel.findOne({ code: body.couponCode }).lean<CouponRecord>();
      const redeemed = coupon ? await couponUsesHeld(coupon._id, userId) : 0;
      rejection = couponRejection(coupon, plan.code, redeemed, now);
    }
    const applied = body.couponCode !== null && rejection === null;
    const { discountMinor, totalMinor } = priceWithCoupon(plan.priceMinor, applied ? coupon : null);
    const quote: Quote = {
      planCode: plan.code,
      planName: plan.name,
      credits: plan.credits,
      validityDays: plan.validityDays,
      currency: plan.currency,
      listPriceMinor: plan.priceMinor,
      discountMinor,
      totalMinor,
      coupon: body.couponCode ? { code: body.couponCode, applied, rejection } : null,
    };
    return { plan, coupon: applied ? coupon : null, quote };
  }

  /** The buyer details kept for invoices. */
  async function checkoutProfile(userId: string): Promise<CheckoutProfile> {
    const profile = await UserProfileModel.findOne({ userId }, { billingState: 1 }).lean();
    const parsed = GstStateCode.safeParse(profile?.billingState);
    return { billingState: parsed.success ? parsed.data : null };
  }

  async function ownPurchase(userId: string, id: string) {
    const purchase = await PurchaseModel.findOne({
      _id: objectId(id, 'Purchase'),
      userId,
    }).lean<PurchaseRecord>();
    if (!purchase) throw AppError.notFound('Purchase not found');
    return purchase;
  }

  const verificationFailed = () =>
    new AppError(400, 'PAYMENT_VERIFICATION_FAILED', 'We could not verify this payment.');

  async function handleWebhook(
    rawBody: Buffer,
    signature: string | undefined,
    eventIdHeader: string | undefined,
  ): Promise<WebhookResult> {
    const event = gateway.parseWebhook(rawBody, signature, eventIdHeader);
    if (!event) {
      logger.warn({ provider: gateway.name }, 'payment webhook with an invalid signature');
      return 'INVALID_SIGNATURE';
    }
    const type = event.kind === 'ignored' ? event.type : event.kind;
    // Claim the event first: a redelivery (or a concurrent duplicate) stops here.
    try {
      await WebhookEventModel.create({
        provider: gateway.name,
        eventId: event.eventId,
        type,
        receivedAt: new Date(),
      });
    } catch (err) {
      if ((err as { code?: number }).code === 11000) return 'DUPLICATE';
      throw err;
    }

    let result: WebhookResult;
    try {
      result = await processWebhook(event);
    } catch (err) {
      // Release the claim so the gateway's retry processes the event again (all steps are idempotent).
      await WebhookEventModel.deleteOne({ provider: gateway.name, eventId: event.eventId });
      throw err;
    }
    await WebhookEventModel.updateOne(
      { provider: gateway.name, eventId: event.eventId },
      { $set: { processedAt: new Date(), result } },
    );
    return result;
  }

  async function processWebhook(
    event: NonNullable<ReturnType<PaymentGateway['parseWebhook']>>,
  ): Promise<WebhookResult> {
    switch (event.kind) {
      case 'payment.captured':
      case 'order.paid': {
        const payment = await PaymentModel.findOne({ orderId: event.payment.orderId }).lean();
        if (!payment) return 'UNKNOWN_ORDER';
        if (event.payment.status !== 'captured') return 'IGNORED';
        if (
          event.payment.amountMinor !== payment.amountMinor ||
          event.payment.currency !== payment.currency
        ) {
          logger.error(
            { purchaseId: String(payment.purchaseId), orderId: payment.orderId },
            'captured amount does not match the order; credits not issued',
          );
          return 'AMOUNT_MISMATCH';
        }
        const { issued } = await markPurchasePaid({
          purchaseId: payment.purchaseId,
          source: 'WEBHOOK',
          paymentId: event.payment.id,
        });
        return issued ? 'PAID' : 'ALREADY_PAID';
      }
      case 'payment.failed': {
        const payment = await PaymentModel.findOne({ orderId: event.payment.orderId }).lean();
        if (!payment) return 'UNKNOWN_ORDER';
        await markPurchaseFailed({
          purchaseId: payment.purchaseId,
          source: 'WEBHOOK',
          paymentId: event.payment.id,
        });
        return 'FAILED';
      }
      case 'refund.processed': {
        const payment = await PaymentModel.findOne({ paymentId: event.refund.paymentId }).lean();
        if (!payment) return 'UNKNOWN_ORDER';
        await markPurchaseRefunded({
          purchaseId: payment.purchaseId,
          refundId: event.refund.id,
          amountMinor: event.refund.amountMinor,
          source: 'WEBHOOK',
        });
        return 'REFUNDED';
      }
      case 'refund.failed': {
        const failed = await markRefundFailed({
          paymentId: event.refund.paymentId,
          refundId: event.refund.id,
          amountMinor: event.refund.amountMinor,
        });
        logger.error({ refundId: event.refund.id }, 'refund failed at the gateway');
        if (failed) {
          // Flagged on the payment for the admin; recorded here for the audit trail.
          await audit.record({
            actorType: 'SYSTEM',
            action: 'payments.refund.failed',
            resourceType: 'purchase',
            resourceId: String(failed.purchaseId),
            outcome: 'FAILURE',
            details: { refundId: event.refund.id, amountMinor: failed.amountMinor },
          });
        }
        return 'REFUND_FAILED';
      }
      case 'ignored':
        return 'IGNORED';
    }
  }

  return {
    gatewayName: gateway.name,

    /** Active plans for the pricing page (FREE included, shown as the sign-up credit). */
    async publicPlans(): Promise<PublicPlan[]> {
      const plans = await PlanModel.find({ active: true })
        .sort({ displayOrder: 1, code: 1 })
        .lean<PlanRecord[]>();
      return plans.map((p) => ({
        code: p.code,
        name: p.name,
        description: p.description,
        priceMinor: p.priceMinor,
        currency: p.currency,
        credits: p.credits,
        validityDays: p.validityDays,
        features: p.features,
        featured: p.featured,
      }));
    },

    async quote(userId: string, body: QuoteBody): Promise<Quote> {
      return (await price(userId, body)).quote;
    },

    /**
     * Prices the order on the server and opens a gateway order for it. A
     * coupon that cannot be applied fails the request (the quote shows why).
     */
    async createOrder(
      userId: string,
      body: CreateOrderBody,
      ctx: ClientContext,
    ): Promise<CheckoutOrder> {
      const { plan, coupon, quote } = await price(userId, body);
      if (quote.coupon && !quote.coupon.applied) {
        throw AppError.validation('This coupon cannot be applied.', {
          rejection: quote.coupon.rejection,
        });
      }
      const now = new Date();
      // The place of supply on the invoice: given now (and kept for next time), or saved before.
      let buyerState: string | null;
      if (body.billingState !== undefined) {
        buyerState = body.billingState;
        await UserProfileModel.updateOne(
          { userId },
          body.billingState === null
            ? { $unset: { billingState: 1 } }
            : { $set: { billingState: body.billingState } },
        );
      } else {
        buyerState = (await checkoutProfile(userId)).billingState;
      }
      if (coupon) await ensureCouponCounter(coupon._id, userId);
      // The purchase and its coupon use are created together: the limits are
      // checked by the writes that take the use, so concurrent orders cannot
      // overrun them (see reserveCoupon).
      let purchase;
      try {
        purchase = await transaction(async (session) => {
          const [created] = await PurchaseModel.create(
            [
              {
                userId,
                planId: plan._id,
                plan: {
                  code: plan.code,
                  version: plan.version,
                  name: plan.name,
                  credits: plan.credits,
                  validityDays: plan.validityDays,
                },
                couponId: coupon?._id ?? null,
                couponCode: coupon?.code ?? null,
                listPriceMinor: quote.listPriceMinor,
                discountMinor: quote.discountMinor,
                amountMinor: quote.totalMinor,
                currency: quote.currency,
                buyerState,
                statusHistory: [{ status: 'CREATED', at: now, source: 'ORDER' }],
              },
            ],
            { session },
          );
          if (coupon) await reserveCoupon({ coupon, userId, purchaseId: created!._id }, session);
          return created!;
        });
      } catch (err) {
        if (err instanceof CouponUnavailableError) {
          throw AppError.validation('This coupon cannot be applied.', { rejection: err.reason });
        }
        throw err;
      }
      const purchaseId = String(purchase._id);
      await audit.record(
        {
          actorType: 'USER',
          actorId: userId,
          action: 'payments.order.create',
          resourceType: 'purchase',
          resourceId: purchaseId,
          details: { plan: plan.code, totalMinor: quote.totalMinor, coupon: coupon?.code ?? null },
        },
        ctx,
      );

      if (quote.totalMinor === 0) {
        // A 100% coupon: nothing to charge, so the purchase completes now.
        await markPurchasePaid({ purchaseId, source: 'FREE', now });
        return {
          purchaseId,
          status: 'PAID',
          totalMinor: 0,
          currency: quote.currency,
          provider: null,
        };
      }

      let order;
      try {
        order = await gateway.createOrder({
          amountMinor: quote.totalMinor,
          currency: quote.currency,
          receipt: purchaseId,
          notes: { purchaseId, plan: plan.code },
        });
      } catch (err) {
        logger.error({ err, purchaseId }, 'payment order creation failed');
        await markPurchaseFailed({ purchaseId, source: 'ORDER' });
        // Not set up yet (System → Integrations): say so rather than "try again shortly".
        if (err instanceof NotConfiguredError) throw err;
        throw new AppError(
          503,
          'PROVIDER_UNAVAILABLE',
          'Payments are temporarily unavailable. Please try again shortly.',
        );
      }
      // An order was created, so a real gateway is configured.
      const providerName = gateway.name as 'razorpay' | 'mock';
      await PaymentModel.create({
        purchaseId: purchase._id,
        userId,
        provider: providerName,
        orderId: order.id,
        amountMinor: quote.totalMinor,
        currency: quote.currency,
        statusHistory: [{ status: 'CREATED', at: now, source: 'ORDER' }],
      });
      return {
        purchaseId,
        status: 'CREATED',
        totalMinor: quote.totalMinor,
        currency: quote.currency,
        provider: { name: providerName, keyId: gateway.publicKeyId, orderId: order.id },
      };
    },

    /**
     * Checkout's success callback. The signature proves the fields came from
     * the gateway; the payment is then fetched to confirm it was captured for
     * the exact amount before credits are issued.
     */
    async verify(
      userId: string,
      body: VerifyPaymentBody,
      ctx: ClientContext,
    ): Promise<PurchaseSummary> {
      const payment = await PaymentModel.findOne({
        orderId: body.razorpay_order_id,
        userId,
      }).lean();
      if (!payment) throw AppError.notFound('Order not found');
      const fail = async (reason: string) => {
        await audit.record(
          {
            actorType: 'USER',
            actorId: userId,
            action: 'payments.verify',
            resourceType: 'purchase',
            resourceId: String(payment.purchaseId),
            outcome: 'FAILURE',
            details: { reason },
          },
          ctx,
        );
        return verificationFailed();
      };
      if (
        !gateway.verifyPaymentSignature(
          body.razorpay_order_id,
          body.razorpay_payment_id,
          body.razorpay_signature,
        )
      ) {
        throw await fail('signature');
      }
      let remote;
      try {
        remote = (await gateway.fetchOrderPayments(payment.orderId)).find(
          (p) => p.id === body.razorpay_payment_id,
        );
      } catch (err) {
        // The webhook or reconciliation will finish the purchase; the page keeps polling.
        logger.warn({ err, orderId: payment.orderId }, 'payment lookup failed during verify');
        return purchaseSummary(await ownPurchase(userId, String(payment.purchaseId)));
      }
      if (!remote) throw await fail('payment_not_on_order');
      if (remote.amountMinor !== payment.amountMinor || remote.currency !== payment.currency) {
        logger.error({ orderId: payment.orderId }, 'verified payment amount does not match');
        throw await fail('amount_mismatch');
      }
      if (remote.status === 'captured') {
        await markPurchasePaid({
          purchaseId: payment.purchaseId,
          source: 'VERIFY',
          paymentId: remote.id,
          signatureVerified: true,
        });
      } else if (remote.status === 'failed') {
        await markPurchaseFailed({
          purchaseId: payment.purchaseId,
          source: 'VERIFY',
          paymentId: remote.id,
        });
      }
      // Authorized but not yet captured: the webhook completes it.
      return purchaseSummary(await ownPurchase(userId, String(payment.purchaseId)));
    },

    handleWebhook,

    async history(userId: string): Promise<PurchaseSummary[]> {
      const rows = await PurchaseModel.find({ userId })
        .sort({ createdAt: -1, _id: -1 })
        .limit(100)
        .lean<PurchaseRecord[]>();
      const payments = await PaymentModel.find(
        { purchaseId: { $in: rows.map((r) => r._id) } },
        { purchaseId: 1, refundedMinor: 1, refunds: 1 },
      ).lean();
      const refundedBy = new Map(payments.map((p) => [String(p.purchaseId), p]));
      return rows.map((r) => purchaseSummary(r, refundedBy.get(String(r._id)) ?? null));
    },

    async get(userId: string, id: string): Promise<PurchaseSummary> {
      const purchase = await ownPurchase(userId, id);
      return purchaseSummary(
        purchase,
        await PaymentModel.findOne(
          { purchaseId: purchase._id },
          { refundedMinor: 1, refunds: 1 },
        ).lean(),
      );
    },

    /** The receipt PDF of the caller's paid purchase. */
    async receipt(userId: string, id: string) {
      return receiptFor(await ownPurchase(userId, id), deps);
    },

    /** The credit note PDF of one processed refund of the caller's purchase. */
    async creditNote(userId: string, id: string, key: string) {
      return creditNoteFor(await ownPurchase(userId, id), key, deps);
    },

    checkoutProfile,

    /** The order's gateway id for a purchase the user owns (mock checkout in development). */
    async orderIdFor(userId: string, id: string): Promise<string> {
      const purchase = await ownPurchase(userId, id);
      const payment = await PaymentModel.findOne({ purchaseId: purchase._id }).lean();
      if (!payment || purchase.status === 'PAID' || purchase.status === 'REFUNDED') {
        throw new AppError(409, 'INVALID_STATE', 'This purchase is not awaiting payment.');
      }
      return payment.orderId;
    },

    // ---- Admin ----------------------------------------------------------------------------

    async listPlans(): Promise<PlanSummary[]> {
      const rows = await PlanModel.find()
        .sort({ displayOrder: 1, code: 1, version: -1 })
        .lean<PlanRecord[]>();
      return rows.map(planSummary);
    },

    /** Adds an inactive version (prices never change in place; activate it separately). */
    async createPlanVersion(
      body: CreatePlanVersionBody,
      actorId: string,
      ctx: ClientContext,
    ): Promise<PlanSummary> {
      return transaction(async (session) => {
        const latest = await PlanModel.findOne({ code: body.code }, { version: 1 }, { session })
          .sort({ version: -1 })
          .lean();
        const [plan] = await PlanModel.create(
          [
            {
              ...body.content,
              code: body.code,
              version: (latest?.version ?? 0) + 1,
              active: false,
              createdBy: actorId,
              reason: body.reason,
            },
          ],
          { session },
        );
        await audit.record(
          {
            actorType: 'ADMIN',
            actorId,
            action: 'payments.plan.create_version',
            resourceType: 'plan',
            resourceId: String(plan!._id),
            details: {
              code: body.code,
              version: plan!.version,
              priceMinor: body.content.priceMinor,
              credits: body.content.credits,
              reason: body.reason,
            },
          },
          ctx,
          session,
        );
        return planSummary(plan!.toObject());
      });
    },

    /** Makes one version the active one for its code (or retires the code when `active` is false). */
    async setPlanActive(
      id: string,
      active: boolean,
      reason: string,
      actorId: string,
      ctx: ClientContext,
    ): Promise<PlanSummary> {
      const planId = objectId(id, 'Plan');
      return transaction(async (session) => {
        const plan = await PlanModel.findById(planId, null, { session }).lean<PlanRecord>();
        if (!plan) throw AppError.notFound('Plan not found');
        if (active) {
          await PlanModel.updateMany(
            { code: plan.code, active: true, _id: { $ne: planId } },
            { $set: { active: false } },
            { session },
          );
        }
        await PlanModel.updateOne({ _id: planId }, { $set: { active } }, { session });
        await audit.record(
          {
            actorType: 'ADMIN',
            actorId,
            action: active ? 'payments.plan.activate' : 'payments.plan.deactivate',
            resourceType: 'plan',
            resourceId: id,
            details: { code: plan.code, version: plan.version, reason },
          },
          ctx,
          session,
        );
        return planSummary({ ...plan, active });
      });
    },

    async listCoupons(): Promise<CouponSummary[]> {
      const rows = await CouponModel.find().sort({ createdAt: -1 }).lean<CouponRecord[]>();
      return rows.map(couponSummary);
    },

    async upsertCoupon(
      id: string | null,
      body: UpsertCouponBody,
      actorId: string,
      ctx: ClientContext,
    ): Promise<CouponSummary> {
      const fields = {
        ...body,
        validFrom: body.validFrom ? new Date(body.validFrom) : null,
        validTo: body.validTo ? new Date(body.validTo) : null,
      };
      return transaction(async (session) => {
        let coupon: CouponRecord | null;
        if (id === null) {
          if (await CouponModel.exists({ code: body.code }).session(session)) {
            throw AppError.conflict('A coupon with this code already exists.');
          }
          const [created] = await CouponModel.create([fields], { session });
          coupon = created!.toObject();
        } else {
          const existing = await CouponModel.findById(objectId(id, 'Coupon'), null, {
            session,
          }).lean<CouponRecord>();
          if (!existing) throw AppError.notFound('Coupon not found');
          if (existing.code !== body.code) {
            throw AppError.validation('A coupon code cannot be changed; create a new coupon.');
          }
          coupon = await CouponModel.findByIdAndUpdate(
            existing._id,
            { $set: fields },
            { returnDocument: 'after', session },
          ).lean<CouponRecord>();
        }
        await audit.record(
          {
            actorType: 'ADMIN',
            actorId,
            action: id === null ? 'payments.coupon.create' : 'payments.coupon.update',
            resourceType: 'coupon',
            resourceId: String(coupon!._id),
            details: {
              code: body.code,
              type: body.type,
              value: body.value,
              maxUses: body.maxUses,
              active: body.active,
            },
          },
          ctx,
          session,
        );
        return couponSummary(coupon!);
      });
    },

    async listPurchases(query: AdminPurchaseQuery): Promise<AdminPurchase[]> {
      const filter: Record<string, unknown> = {};
      if (query.status) filter.status = query.status;
      if (query.q) {
        const q = query.q;
        const byId = /^[0-9a-f]{24}$/i.test(q) ? [{ _id: q }, { userId: q }] : [];
        const payments = await PaymentModel.find(
          { $or: [{ orderId: q }, { paymentId: q }] },
          { purchaseId: 1 },
        ).lean();
        const users = q.includes('@')
          ? await UserModel.find({ primaryEmail: q.toLowerCase() }, { _id: 1 }).lean()
          : [];
        filter.$or = [
          ...byId,
          { _id: { $in: payments.map((p) => p.purchaseId) } },
          { userId: { $in: users.map((u) => u._id) } },
        ];
      }
      const rows = await PurchaseModel.find(filter)
        .sort({ createdAt: -1, _id: -1 })
        .limit(query.limit)
        .lean<PurchaseRecord[]>();
      return decorate(rows);
    },

    async getPurchase(id: string): Promise<AdminPurchase> {
      const row = await PurchaseModel.findById(objectId(id, 'Purchase')).lean<PurchaseRecord>();
      if (!row) throw AppError.notFound('Purchase not found');
      return (await decorate([row]))[0]!;
    },

    async adminReceipt(id: string) {
      const purchase = await PurchaseModel.findById(
        objectId(id, 'Purchase'),
      ).lean<PurchaseRecord>();
      if (!purchase) throw AppError.notFound('Purchase not found');
      return receiptFor(purchase, deps);
    },

    async adminCreditNote(id: string, key: string) {
      const purchase = await PurchaseModel.findById(
        objectId(id, 'Purchase'),
      ).lean<PurchaseRecord>();
      if (!purchase) throw AppError.notFound('Purchase not found');
      return creditNoteFor(purchase, key, deps);
    },

    /** What refunding a purchase involves: amounts, and how its credits were used. */
    async refundPreview(id: string): Promise<RefundPreview> {
      const purchase = await PurchaseModel.findById(
        objectId(id, 'Purchase'),
      ).lean<PurchaseRecord>();
      if (!purchase) throw AppError.notFound('Purchase not found');
      const payment = await PaymentModel.findOne({
        purchaseId: purchase._id,
      }).lean<PaymentRecord>();
      return previewFor(purchase, payment);
    },

    /**
     * Refunds all or part of a paid purchase through the gateway. The payment
     * is claimed first (CAPTURED → REFUND_REQUESTED, one conditional update,
     * audited in the same transaction), so concurrent requests cannot both
     * reach the gateway; a refused request releases the claim. Unused credits
     * are withdrawn when the refund is processed (immediately, or on the
     * refund webhook): all of them for a refund that completes the full
     * amount, else the number chosen.
     */
    async refund(
      id: string,
      body: RefundBody,
      actorId: string,
      ctx: ClientContext,
    ): Promise<AdminRefundResult> {
      const purchaseId = objectId(id, 'Purchase');
      const purchase = await PurchaseModel.findById(purchaseId).lean<PurchaseRecord>();
      if (!purchase) throw AppError.notFound('Purchase not found');
      const payment = await PaymentModel.findOne({ purchaseId }).lean<PaymentRecord>();
      if (payment?.status === 'REFUND_REQUESTED' || payment?.status === 'REFUND_PENDING') {
        throw refundInProgress();
      }
      const preview = await previewFor(purchase, payment);
      if (!preview.refundable || !payment?.paymentId) {
        throw new AppError(
          409,
          'INVALID_STATE',
          'Only captured, paid purchases with an amount left to refund can be refunded.',
        );
      }
      const amountMinor = body.amountMinor ?? preview.refundableMinor;
      if (amountMinor > preview.refundableMinor) {
        throw AppError.validation('The refund is more than is left to refund.', {
          field: 'amountMinor',
          refundableMinor: preview.refundableMinor,
        });
      }
      if (preview.creditsUsed > 0 && !body.acknowledgeUsedCredits) {
        throw AppError.validation(
          `The candidate has used ${preview.creditsUsed} of ${preview.creditsGranted} credits from this purchase. Confirm to refund anyway.`,
          { field: 'acknowledgeUsedCredits', creditsUsed: preview.creditsUsed },
        );
      }
      const fully = amountMinor === preview.refundableMinor;
      const withdrawable = preview.creditsUnused + preview.creditsExpired;
      const creditsToWithdraw = fully
        ? withdrawable
        : (body.withdrawCredits ?? preview.creditsUnused);
      if (creditsToWithdraw > withdrawable) {
        throw AppError.validation('Only unused credits can be withdrawn.', {
          field: 'withdrawCredits',
          creditsUnused: preview.creditsUnused,
        });
      }

      // Claim and audit together: a failed audit write undoes the claim, and
      // a request that loses the race is refused before anything is recorded.
      const claim = await transaction(async (session) => {
        const claimed = await claimRefund(
          { purchaseId, amountMinor, creditsToWithdraw, reason: body.reason, actorId },
          session,
        );
        if (!claimed) return null;
        await audit.record(
          {
            actorType: 'ADMIN',
            actorId,
            action: 'payments.refund',
            resourceType: 'purchase',
            resourceId: id,
            details: {
              amountMinor,
              refundableMinor: preview.refundableMinor,
              completesRefund: fully,
              creditsToWithdraw,
              creditsUsed: preview.creditsUsed,
              acknowledgedUsedCredits: body.acknowledgeUsedCredits,
              reason: body.reason,
            },
          },
          ctx,
          session,
        );
        return claimed;
      });
      if (!claim) throw refundInProgress();

      let refund;
      try {
        refund = await gateway.refund(payment.paymentId, amountMinor, { purchaseId: id });
      } catch (err) {
        logger.error({ err, purchaseId: id }, 'refund request failed');
        await releaseRefundClaim({ purchaseId, key: claim.key });
        await audit.record(
          {
            actorType: 'ADMIN',
            actorId,
            action: 'payments.refund.request_failed',
            resourceType: 'purchase',
            resourceId: id,
            outcome: 'FAILURE',
            details: { amountMinor },
          },
          ctx,
        );
        throw new AppError(503, 'PROVIDER_UNAVAILABLE', 'The refund could not be requested.');
      }
      await markRefundPending({
        purchaseId,
        key: claim.key,
        refundId: refund.id,
        amountMinor: refund.amountMinor,
      });
      let creditsWithdrawn = 0;
      if (refund.status === 'processed') {
        ({ creditsWithdrawn } = await markPurchaseRefunded({
          purchaseId,
          refundId: refund.id,
          source: 'ADMIN',
        }));
      } else if (refund.status === 'failed') {
        await markRefundFailed({ paymentId: payment.paymentId, refundId: refund.id });
      }
      return {
        purchase: (await decorate([(await PurchaseModel.findById(purchaseId).lean())!]))[0]!,
        refundStatus: refund.status,
        creditsWithdrawn,
      };
    },

    async reconcile(id: string, actorId: string | null, ctx?: ClientContext) {
      const purchaseId = objectId(id, 'Purchase');
      if (!(await PurchaseModel.exists({ _id: purchaseId }))) {
        throw AppError.notFound('Purchase not found');
      }
      let outcome: ReconcileOutcome;
      try {
        outcome = await reconcilePurchase(purchaseId, gateway, {
          expireAfterMs: PAYMENT_POLICY.expireAfterMs,
        });
      } catch (err) {
        logger.error({ err, purchaseId: id }, 'reconciliation failed');
        throw new AppError(503, 'PROVIDER_UNAVAILABLE', 'The payment provider did not respond.');
      }
      if (actorId) {
        await audit.record(
          {
            actorType: 'ADMIN',
            actorId,
            action: 'payments.reconcile',
            resourceType: 'purchase',
            resourceId: id,
            details: { outcome },
          },
          ctx,
        );
      }
      return {
        outcome,
        purchase: (await decorate([(await PurchaseModel.findById(purchaseId).lean())!]))[0]!,
      };
    },
  };
}

/** Amounts and credit use for a refund decision (see RefundPreview). */
export async function previewFor(
  purchase: PurchaseRecord,
  payment: PaymentRecord | null,
  now = new Date(),
): Promise<RefundPreview> {
  const usage = purchase.creditLotId
    ? await lotUsage(purchase.userId, purchase.creditLotId, now)
    : { granted: 0, remaining: 0, expired: false, withdrawn: 0, used: 0 };
  const capturedMinor = payment?.amountMinor ?? 0;
  const refundedMinor = payment?.refundedMinor ?? 0;
  const refundable =
    purchase.status === 'PAID' &&
    payment?.status === 'CAPTURED' &&
    Boolean(payment.paymentId) &&
    capturedMinor > refundedMinor;
  const refundableMinor = refundable ? capturedMinor - refundedMinor : 0;
  const creditsUnused = usage.expired ? 0 : usage.remaining;
  return {
    currency: purchase.currency,
    capturedMinor,
    refundedMinor,
    refundableMinor,
    refundable,
    creditsGranted: usage.granted,
    creditsUnused,
    creditsUsed: usage.used,
    creditsExpired: usage.expired ? usage.remaining : 0,
    creditsWithdrawn: usage.withdrawn,
    suggestedMinor: proratedRefundMinor({
      capturedMinor,
      creditsGranted: usage.granted,
      creditsUnused,
      refundableMinor,
    }),
  };
}

/**
 * The receipt of a paid (or since refunded) purchase. Purchases paid before
 * invoice numbers existed get theirs now.
 */
async function receiptFor(
  purchase: PurchaseRecord,
  deps: Pick<PaymentsServiceDeps, 'billing' | 'receiptFontPath'>,
): Promise<{ body: Buffer; fileName: string }> {
  if (!receiptAvailable(purchase)) {
    throw new AppError(409, 'INVALID_STATE', 'A receipt is available once the purchase is paid.');
  }
  const invoiceNumber =
    purchase.invoiceNumber ?? (await issueInvoiceNumber(purchase._id, new Date()));
  if (!invoiceNumber) throw AppError.notFound('Purchase not found');
  const [fresh, payment, user, profile, seller] = await Promise.all([
    PurchaseModel.findById(purchase._id, { invoiceIssuedAt: 1 }).lean(),
    PaymentModel.findOne({ purchaseId: purchase._id }).lean<PaymentRecord>(),
    UserModel.findById(purchase.userId, { primaryEmail: 1 }).lean(),
    UserProfileModel.findOne({ userId: purchase.userId }, { displayName: 1 }).lean(),
    deps.billing(),
  ]);
  const body = await renderReceiptPdf(
    {
      invoiceNumber,
      issuedAt: fresh?.invoiceIssuedAt ?? purchase.creditsIssuedAt ?? purchase.createdAt,
      seller,
      buyer: {
        name: profile?.displayName ?? null,
        email: (user as { primaryEmail?: string | null } | null)?.primaryEmail ?? null,
        state: purchase.buyerState ?? null,
      },
      plan: purchase.plan,
      couponCode: purchase.couponCode,
      listPriceMinor: purchase.listPriceMinor,
      discountMinor: purchase.discountMinor,
      totalMinor: purchase.amountMinor,
      refundedMinor: payment?.refundedMinor ?? 0,
      currency: purchase.currency,
      payment: payment ? { provider: payment.provider, paymentId: payment.paymentId } : null,
      purchaseId: String(purchase._id),
    },
    { fontPath: deps.receiptFontPath ?? null },
  );
  return { body, fileName: `receipt-${invoiceNumber.replaceAll('/', '-')}.pdf` };
}

/**
 * The credit note of a processed refund (`key`), against the purchase's
 * invoice. Refunds processed before credit notes existed are numbered now.
 */
async function creditNoteFor(
  purchase: PurchaseRecord,
  key: string,
  deps: Pick<PaymentsServiceDeps, 'billing' | 'receiptFontPath'>,
): Promise<{ body: Buffer; fileName: string }> {
  const payment = await PaymentModel.findOne({ purchaseId: purchase._id }).lean<PaymentRecord>();
  const entry = payment?.refunds?.find((r) => r.key === key && r.status === 'processed');
  if (!payment || !entry) throw AppError.notFound('Credit note not found');
  const issued = await issueCreditNoteNumber(purchase._id, key, entry.processedAt ?? new Date());
  if (!issued) throw AppError.notFound('Credit note not found');
  const invoiceNumber =
    purchase.invoiceNumber ?? (await issueInvoiceNumber(purchase._id, new Date()));
  if (!invoiceNumber) throw AppError.notFound('Credit note not found');
  const [fresh, user, profile, seller] = await Promise.all([
    PurchaseModel.findById(purchase._id, { invoiceIssuedAt: 1 }).lean(),
    UserModel.findById(purchase.userId, { primaryEmail: 1 }).lean(),
    UserProfileModel.findOne({ userId: purchase.userId }, { displayName: 1 }).lean(),
    deps.billing(),
  ]);
  const body = await renderCreditNotePdf(
    {
      creditNoteNumber: issued.number,
      issuedAt: issued.issuedAt,
      invoice: {
        number: invoiceNumber,
        issuedAt: fresh?.invoiceIssuedAt ?? purchase.creditsIssuedAt ?? purchase.createdAt,
      },
      seller,
      buyer: {
        name: profile?.displayName ?? null,
        email: (user as { primaryEmail?: string | null } | null)?.primaryEmail ?? null,
        state: purchase.buyerState ?? null,
      },
      plan: purchase.plan,
      amountMinor: entry.amountMinor,
      currency: purchase.currency,
      refundId: entry.id,
      purchaseId: String(purchase._id),
    },
    { fontPath: deps.receiptFontPath ?? null },
  );
  return { body, fileName: `credit-note-${issued.number.replaceAll('/', '-')}.pdf` };
}

async function decorate(rows: PurchaseRecord[]): Promise<AdminPurchase[]> {
  const ids = rows.map((r) => r._id);
  const userIds = [...new Set(rows.map((r) => String(r.userId)))];
  const [payments, users] = await Promise.all([
    PaymentModel.find({ purchaseId: { $in: ids } }).lean<PaymentRecord[]>(),
    UserModel.find({ _id: { $in: userIds } }, { primaryEmail: 1 }).lean(),
  ]);
  const paymentBy = new Map(payments.map((p) => [String(p.purchaseId), p]));
  const emailBy = new Map(
    users.map((u) => [String(u._id), (u as { primaryEmail?: string | null }).primaryEmail ?? null]),
  );
  return rows.map((r) =>
    adminPurchase(r, paymentBy.get(String(r._id)) ?? null, emailBy.get(String(r.userId)) ?? null),
  );
}

export type PaymentsService = ReturnType<typeof createPaymentsService>;

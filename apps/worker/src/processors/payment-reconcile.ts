import type { Logger } from '@cbi/config';
import {
  PaymentModel,
  PurchaseModel,
  reconcilePurchase,
  type ReconcileGateway,
  type ReconcileOutcome,
} from '@cbi/db';
import { PAYMENT_POLICY } from '@cbi/shared-types';

export interface PaymentReconcileOptions {
  gateway: ReconcileGateway;
  logger: Logger;
  now?: Date;
  batchSize?: number;
}

export type PaymentReconcileResult = Record<ReconcileOutcome, number> & {
  checked: number;
  errors: number;
};

/**
 * Catches purchases whose outcome never reached us (browser closed before
 * verify, webhook lost): unconfirmed purchases older than
 * `reconcileAfterMs` are checked with the gateway, credited if captured and
 * expired after `expireAfterMs`; refunds still pending are completed once
 * the gateway reports them refunded. Every step is idempotent, so running
 * alongside verify and webhooks is safe.
 */
export async function reconcilePayments(
  opts: PaymentReconcileOptions,
): Promise<PaymentReconcileResult> {
  const now = opts.now ?? new Date();
  const limit = opts.batchSize ?? 200;
  const result: PaymentReconcileResult = {
    checked: 0,
    errors: 0,
    PAID: 0,
    REFUNDED: 0,
    EXPIRED: 0,
    PENDING: 0,
    AMOUNT_MISMATCH: 0,
    UNCHANGED: 0,
  };

  const unconfirmed = await PurchaseModel.find(
    {
      status: { $in: ['CREATED', 'FAILED'] },
      createdAt: { $lt: new Date(now.getTime() - PAYMENT_POLICY.reconcileAfterMs) },
    },
    { _id: 1 },
  )
    .sort({ createdAt: 1 })
    .limit(limit)
    .lean();
  const refunding = await PaymentModel.find({ status: 'REFUND_PENDING' }, { purchaseId: 1 })
    .limit(limit)
    .lean();
  const ids = [...unconfirmed.map((p) => p._id), ...refunding.map((p) => p.purchaseId)];

  for (const id of ids) {
    result.checked++;
    try {
      const outcome = await reconcilePurchase(id, opts.gateway, {
        expireAfterMs: PAYMENT_POLICY.expireAfterMs,
        now,
      });
      result[outcome]++;
      if (outcome === 'AMOUNT_MISMATCH') {
        opts.logger.error(
          { purchaseId: String(id) },
          'captured amount does not match the order; needs review',
        );
      }
    } catch (err) {
      // A gateway outage leaves the purchase for the next run.
      result.errors++;
      opts.logger.warn({ err, purchaseId: String(id) }, 'purchase reconciliation failed');
    }
  }
  return result;
}

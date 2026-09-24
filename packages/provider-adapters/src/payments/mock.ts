import { createHash, randomBytes } from 'node:crypto';
import { hmacHex, safeEqualHex } from './razorpay.js';
import type {
  GatewayOrder,
  GatewayPayment,
  GatewayRefund,
  GatewayWebhookEvent,
  PaymentGateway,
} from './types.js';

export const MOCK_PAYMENT_SECRET = 'mock-payment-secret-dev-only';
export const MOCK_WEBHOOK_SECRET = 'mock-webhook-secret-dev-only';

/**
 * DEVELOPMENT/TEST ONLY: an in-memory gateway that behaves like Razorpay
 * (same signatures, statuses and webhook shapes). Environment validation
 * refuses PAYMENT_PROVIDER=mock in staging and production. `pay()` plays the
 * role of the customer completing Checkout.
 */
export function createMockGateway() {
  const orders = new Map<string, GatewayOrder>();
  const payments = new Map<string, GatewayPayment>();
  const refunds = new Map<string, GatewayRefund>();
  const id = (prefix: string) => `${prefix}_mock${randomBytes(6).toString('hex')}`;

  const gateway: PaymentGateway = {
    name: 'mock',
    publicKeyId: 'rzp_test_mock',
    async createOrder(input) {
      const order: GatewayOrder = {
        id: id('order'),
        amountMinor: input.amountMinor,
        currency: input.currency,
        status: 'created',
      };
      orders.set(order.id, order);
      return { ...order };
    },
    async fetchOrderPayments(orderId) {
      return [...payments.values()].filter((p) => p.orderId === orderId).map((p) => ({ ...p }));
    },
    async fetchPayment(paymentId) {
      const p = payments.get(paymentId);
      if (!p) throw new Error('mock payment not found');
      return { ...p };
    },
    verifyPaymentSignature(orderId, paymentId, signature) {
      return safeEqualHex(hmacHex(MOCK_PAYMENT_SECRET, `${orderId}|${paymentId}`), signature);
    },
    parseWebhook(rawBody, signature, eventIdHeader): GatewayWebhookEvent | null {
      if (!signature || !safeEqualHex(hmacHex(MOCK_WEBHOOK_SECRET, rawBody), signature))
        return null;
      const event = JSON.parse(rawBody.toString('utf8')) as {
        event: string;
        payload: {
          payment?: {
            entity: {
              id: string;
              order_id: string;
              amount: number;
              currency: string;
              status: GatewayPayment['status'];
            };
          };
          refund?: {
            entity: {
              id: string;
              payment_id: string;
              amount: number;
              status: GatewayRefund['status'];
            };
          };
        };
      };
      const eventId = eventIdHeader ?? createHash('sha256').update(rawBody).digest('hex');
      const p = event.payload.payment?.entity;
      const r = event.payload.refund?.entity;
      const payment = p && {
        id: p.id,
        orderId: p.order_id,
        amountMinor: p.amount,
        currency: p.currency,
        status: p.status,
      };
      if (
        (event.event === 'payment.captured' ||
          event.event === 'order.paid' ||
          event.event === 'payment.failed') &&
        payment
      ) {
        return { kind: event.event, eventId, payment };
      }
      if ((event.event === 'refund.processed' || event.event === 'refund.failed') && r) {
        return {
          kind: event.event,
          eventId,
          refund: { id: r.id, paymentId: r.payment_id, amountMinor: r.amount, status: r.status },
        };
      }
      return { kind: 'ignored', eventId, type: event.event };
    },
    async refund(paymentId, amountMinor) {
      const refund: GatewayRefund = { id: id('rfnd'), paymentId, amountMinor, status: 'pending' };
      refunds.set(refund.id, refund);
      return { ...refund };
    },
  };

  /** The customer pays an order: returns what Checkout hands the browser. */
  function pay(
    orderId: string,
    opts: { status?: GatewayPayment['status']; amountMinor?: number } = {},
  ) {
    const order = orders.get(orderId);
    if (!order) throw new Error('mock order not found');
    const payment: GatewayPayment = {
      id: id('pay'),
      orderId,
      amountMinor: opts.amountMinor ?? order.amountMinor,
      currency: order.currency,
      status: opts.status ?? 'captured',
    };
    payments.set(payment.id, payment);
    if (payment.status === 'captured') order.status = 'paid';
    return {
      payment,
      checkout: {
        razorpay_order_id: orderId,
        razorpay_payment_id: payment.id,
        razorpay_signature: hmacHex(MOCK_PAYMENT_SECRET, `${orderId}|${payment.id}`),
      },
    };
  }

  /** A signed webhook request as Razorpay would send it. */
  function webhook(
    event: string,
    entity: { payment?: GatewayPayment; refund?: GatewayRefund },
    eventId = id('evt'),
  ) {
    const body = Buffer.from(
      JSON.stringify({
        event,
        payload: {
          ...(entity.payment
            ? {
                payment: {
                  entity: {
                    id: entity.payment.id,
                    order_id: entity.payment.orderId,
                    amount: entity.payment.amountMinor,
                    currency: entity.payment.currency,
                    status: entity.payment.status,
                  },
                },
              }
            : {}),
          ...(entity.refund
            ? {
                refund: {
                  entity: {
                    id: entity.refund.id,
                    payment_id: entity.refund.paymentId,
                    amount: entity.refund.amountMinor,
                    status: entity.refund.status,
                  },
                },
              }
            : {}),
        },
      }),
    );
    return { body, signature: hmacHex(MOCK_WEBHOOK_SECRET, body), eventId };
  }

  return { gateway, pay, webhook, orders, payments, refunds };
}

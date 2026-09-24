import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { ProviderError } from '../errors.js';
import type {
  GatewayOrder,
  GatewayPayment,
  GatewayRefund,
  GatewayWebhookEvent,
  PaymentGateway,
} from './types.js';

export interface RazorpayOptions {
  keyId: string;
  keySecret: string;
  webhookSecret: string;
  baseUrl?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/** Hex HMAC-SHA256, the form Razorpay uses for both signatures. */
export const hmacHex = (secret: string, data: string | Buffer) =>
  createHmac('sha256', secret).update(data).digest('hex');

/** Constant-time comparison of two hex strings (false on any length mismatch). */
export function safeEqualHex(expected: string, given: string): boolean {
  if (!/^[a-f0-9]+$/i.test(given)) return false;
  const a = Buffer.from(expected.toLowerCase(), 'hex');
  const b = Buffer.from(given.toLowerCase(), 'hex');
  return a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
}

interface RzPayment {
  id: string;
  order_id: string;
  amount: number;
  currency: string;
  status: GatewayPayment['status'];
}
interface RzRefund {
  id: string;
  payment_id: string;
  amount: number;
  status: GatewayRefund['status'];
}

const toPayment = (p: RzPayment): GatewayPayment => ({
  id: p.id,
  orderId: p.order_id,
  amountMinor: p.amount,
  currency: p.currency,
  status: p.status,
});
const toRefund = (r: RzRefund): GatewayRefund => ({
  id: r.id,
  paymentId: r.payment_id,
  amountMinor: r.amount,
  status: r.status,
});

/**
 * Razorpay over its REST API (there is no need for the SDK: four calls and
 * two HMAC checks). Payments are expected to be auto-captured (account
 * setting); only `captured` counts as paid.
 */
export function createRazorpayGateway(opts: RazorpayOptions): PaymentGateway {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const base = (opts.baseUrl ?? 'https://api.razorpay.com/v1').replace(/\/$/, '');
  const auth = `Basic ${Buffer.from(`${opts.keyId}:${opts.keySecret}`).toString('base64')}`;

  async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await fetchImpl(`${base}${path}`, {
        method,
        headers: { Authorization: auth, 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000),
      });
    } catch (err) {
      throw new ProviderError(
        'razorpay',
        `${method} ${path.split('/')[1]} failed (network/timeout)`,
        true,
        { cause: err },
      );
    }
    if (!res.ok) {
      // Razorpay error descriptions can echo input; keep only the code.
      const code = ((await res.json().catch(() => null)) as { error?: { code?: string } } | null)
        ?.error?.code;
      throw new ProviderError(
        'razorpay',
        `${method} ${path.split('/')[1]} rejected (HTTP ${res.status}${code ? ` ${code}` : ''})`,
        res.status >= 500 || res.status === 429,
      );
    }
    return (await res.json()) as T;
  }

  return {
    name: 'razorpay',
    publicKeyId: opts.keyId,

    async createOrder(input) {
      const order = await call<{
        id: string;
        amount: number;
        currency: string;
        status: GatewayOrder['status'];
      }>('POST', '/orders', {
        amount: input.amountMinor,
        currency: input.currency,
        receipt: input.receipt.slice(0, 40),
        notes: input.notes ?? {},
      });
      return {
        id: order.id,
        amountMinor: order.amount,
        currency: order.currency,
        status: order.status,
      };
    },

    async fetchOrderPayments(orderId) {
      const list = await call<{ items: RzPayment[] }>(
        'GET',
        `/orders/${encodeURIComponent(orderId)}/payments`,
      );
      return list.items.map(toPayment);
    },

    async fetchPayment(paymentId) {
      return toPayment(await call<RzPayment>('GET', `/payments/${encodeURIComponent(paymentId)}`));
    },

    verifyPaymentSignature(orderId, paymentId, signature) {
      return safeEqualHex(hmacHex(opts.keySecret, `${orderId}|${paymentId}`), signature);
    },

    parseWebhook(rawBody, signature, eventIdHeader) {
      if (!signature || !safeEqualHex(hmacHex(opts.webhookSecret, rawBody), signature)) return null;
      let event: {
        event?: string;
        payload?: {
          payment?: { entity?: RzPayment };
          refund?: { entity?: RzRefund };
        };
      };
      try {
        event = JSON.parse(rawBody.toString('utf8'));
      } catch {
        return null;
      }
      // Razorpay sends x-razorpay-event-id; fall back to a hash of the body for idempotency.
      const eventId = eventIdHeader?.trim() || createHash('sha256').update(rawBody).digest('hex');
      const type = event.event ?? 'unknown';
      const payment = event.payload?.payment?.entity;
      const refund = event.payload?.refund?.entity;
      if ((type === 'payment.captured' || type === 'order.paid') && payment) {
        return { kind: type, eventId, payment: toPayment(payment) };
      }
      if (type === 'payment.failed' && payment)
        return { kind: type, eventId, payment: toPayment(payment) };
      if ((type === 'refund.processed' || type === 'refund.failed') && refund) {
        return { kind: type, eventId, refund: toRefund(refund) };
      }
      return { kind: 'ignored', eventId, type };
    },

    async refund(paymentId, amountMinor, notes) {
      return toRefund(
        await call<RzRefund>('POST', `/payments/${encodeURIComponent(paymentId)}/refund`, {
          amount: amountMinor,
          notes: notes ?? {},
        }),
      );
    },
  };
}

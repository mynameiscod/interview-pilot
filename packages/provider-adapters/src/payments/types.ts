/**
 * Payment gateway adapter (Razorpay in production, a mock in development and
 * tests). Amounts are integer minor units (paise). Signature checks are
 * constant-time; secrets never appear in errors or logs.
 */
export interface GatewayOrder {
  id: string;
  amountMinor: number;
  currency: string;
  status: 'created' | 'attempted' | 'paid';
}

export interface GatewayPayment {
  id: string;
  orderId: string;
  amountMinor: number;
  currency: string;
  /** Only `captured` means the money was taken. */
  status: 'created' | 'authorized' | 'captured' | 'refunded' | 'failed';
}

export interface GatewayRefund {
  id: string;
  paymentId: string;
  amountMinor: number;
  status: 'pending' | 'processed' | 'failed';
}

/** A verified webhook, reduced to what the platform acts on. */
export type GatewayWebhookEvent =
  | { kind: 'payment.captured' | 'order.paid'; eventId: string; payment: GatewayPayment }
  | { kind: 'payment.failed'; eventId: string; payment: GatewayPayment }
  | { kind: 'refund.processed' | 'refund.failed'; eventId: string; refund: GatewayRefund }
  | { kind: 'ignored'; eventId: string; type: string };

export interface PaymentGateway {
  readonly name: 'razorpay' | 'mock' | 'none';
  /** Public key id the browser uses to open Checkout. */
  readonly publicKeyId: string;
  createOrder(input: {
    amountMinor: number;
    currency: string;
    /** Our purchase id (Razorpay's `receipt`, max 40 chars). */
    receipt: string;
    notes?: Record<string, string>;
  }): Promise<GatewayOrder>;
  /** Payments made against an order (for verification and reconciliation). */
  fetchOrderPayments(orderId: string): Promise<GatewayPayment[]>;
  fetchPayment(paymentId: string): Promise<GatewayPayment>;
  /** Checkout's `razorpay_signature` for `orderId|paymentId`. */
  verifyPaymentSignature(orderId: string, paymentId: string, signature: string): boolean;
  /**
   * Checks `X-Razorpay-Signature` against the raw request body and parses
   * the event. Returns null when the signature is invalid.
   */
  parseWebhook(
    rawBody: Buffer,
    signature: string | undefined,
    eventIdHeader: string | undefined,
  ): GatewayWebhookEvent | null;
  refund(
    paymentId: string,
    amountMinor: number,
    notes?: Record<string, string>,
  ): Promise<GatewayRefund>;
}

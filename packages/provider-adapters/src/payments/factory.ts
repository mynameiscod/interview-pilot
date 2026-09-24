import { createMockGateway } from './mock.js';
import { createRazorpayGateway } from './razorpay.js';
import type { PaymentGateway } from './types.js';

/** Payment settings validated by @cbi/config (shared by the API and the worker). */
export interface PaymentSettings {
  PAYMENT_PROVIDER: 'razorpay' | 'mock';
  RAZORPAY_KEY_ID?: string;
  RAZORPAY_KEY_SECRET?: string;
  RAZORPAY_WEBHOOK_SECRET?: string;
}

/** One mock per process, so orders created by the API are visible to its own reconciliation. */
let sharedMock: ReturnType<typeof createMockGateway> | null = null;

export function createPaymentGateway(env: PaymentSettings): PaymentGateway {
  if (env.PAYMENT_PROVIDER === 'razorpay') {
    return createRazorpayGateway({
      keyId: env.RAZORPAY_KEY_ID!,
      keySecret: env.RAZORPAY_KEY_SECRET!,
      webhookSecret: env.RAZORPAY_WEBHOOK_SECRET!,
    });
  }
  sharedMock ??= createMockGateway();
  return sharedMock.gateway;
}

/** The process's mock gateway controls (development/test only), or null with a real gateway. */
export function mockGatewayControls(env: PaymentSettings) {
  if (env.PAYMENT_PROVIDER !== 'mock') return null;
  sharedMock ??= createMockGateway();
  return sharedMock;
}

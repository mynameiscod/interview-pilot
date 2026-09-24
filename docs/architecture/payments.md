# Payments, plans and credits (Phase 6)

Candidates buy **plans**. A plan grants a number of interview **credits** that stay usable for the plan's validity period. Razorpay takes the money. The append-only credit ledger stays authoritative for what a candidate can spend. A paid purchase adds exactly one ledger lot.

- Contracts: [`packages/shared-types/src/payments.ts`](../../packages/shared-types/src/payments.ts)
- Gateway adapters (Razorpay REST and a dev/test mock): [`packages/provider-adapters/src/payments/`](../../packages/provider-adapters/src/payments/)
- State changes: [`packages/db/src/purchases.ts`](../../packages/db/src/purchases.ts)
- API: [`apps/api/src/modules/payments/`](../../apps/api/src/modules/payments/)
- Reconciliation: [`apps/worker/src/processors/payment-reconcile.ts`](../../apps/worker/src/processors/payment-reconcile.ts)

## Data

| Collection          | Purpose                                                                                                                                                                                                                                                                                     |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `plans`             | Append-only versions per `code`. Only `active` can change, and a partial unique index allows at most one active version per code. A price change is a new version that an admin activates.                                                                                                  |
| `coupons`           | `PERCENT` (1–100) or `FIXED` (paise off) discounts. Each has an optional validity window, total `maxUses`, `perUserLimit` and optional plan restriction.                                                                                                                                    |
| `couponRedemptions` | One row per paid purchase that used a coupon (unique `purchaseId`).                                                                                                                                                                                                                         |
| `purchases`         | What was bought, with a frozen snapshot of the plan, the list price, discount, total and currency. Status `CREATED → PAID \| FAILED \| EXPIRED`, and `PAID → REFUNDED`. The status history records the source of each change: `ORDER`, `VERIFY`, `WEBHOOK`, `RECONCILE`, `FREE` or `ADMIN`. |
| `payments`          | The gateway side: `orderId` (unique), `paymentId` (unique when set), status, history, whether a Checkout signature was verified, and the refund.                                                                                                                                            |
| `webhookEvents`     | One row per processed gateway event (unique `provider + eventId`), kept for 180 days.                                                                                                                                                                                                       |

Money is stored as integer minor units (paise) with a currency. Only INR is supported at launch.

Seed plans are created at API start when a code has no versions, and existing plans are never changed:

| Plan     | Price           | Credits | Validity  |
| -------- | --------------- | ------- | --------- |
| FREE     | ₹0              | 1       | no expiry |
| SPRINT   | ₹199            | 3       | 7 days    |
| JOB_HUNT | ₹499 (featured) | 12      | 30 days   |

FREE is shown on the pricing page but cannot be bought. Its credit is the existing one-time `FREE_GRANT`.

## Flow

```text
POST /payments/quote   {planCode, couponCode?}   → server price (and why a coupon does not apply)
POST /payments/orders  {planCode, couponCode?}
  price on the server → purchase CREATED → gateway order → payment CREATED → {keyId, orderId}
  (total 0 with a 100 % coupon → PAID immediately, no gateway)
browser: Razorpay Checkout (or mock Checkout in development)
POST /payments/verify  {razorpay_order_id, razorpay_payment_id, razorpay_signature}
  order must belong to the caller → HMAC check → fetch the order's payments from Razorpay
  → payment must exist on the order, captured, same amount and currency → markPurchasePaid
POST /payments/webhooks/razorpay   (raw body, X-Razorpay-Signature, X-Razorpay-Event-Id)
  HMAC check on the exact bytes → claim the event id (unique insert) → act → record the result
worker, hourly: CREATED/FAILED older than 30 min → ask the gateway → PAID, still pending, or EXPIRED after 24 h
```

`markPurchasePaid` is the single place credits are issued. It runs one transaction:

1. A conditional update moves the purchase from `CREATED`, `FAILED` or `EXPIRED` to `PAID`. A late success after a failed attempt, or after expiry, still counts.
2. It grants a `PURCHASE` lot with idempotency key `purchase:<id>` and an expiry of now + validity.
3. It records the coupon redemption and increments `usedCount`.
4. It marks the payment `CAPTURED`.

Only the call whose conditional update matched issues credits. Every other call (a second verify, the webhook, `order.paid` after `payment.captured`, or reconciliation) returns `issued: false`. The unique ledger key is a second guard. Tests run verify, duplicate webhooks and `order.paid` concurrently and assert one ledger entry. See `payments.integration.test.ts` in `apps/api` and `purchases.integration.test.ts` in `packages/db`.

### Webhooks

- Mounted before the JSON parser, with `express.raw`. The signature covers the bytes as received, so re-serialised JSON fails.
- An invalid signature returns 400 and nothing is stored.
- The event id comes from `X-Razorpay-Event-Id`, or a SHA-256 of the body when the header is missing. It is inserted before any processing. A duplicate returns 200 `DUPLICATE` without being processed again.
- If processing throws, the claim is deleted and the response is 500. Razorpay then retries, and every step is idempotent.
- Handled events:
  - `payment.captured` and `order.paid` mark the purchase paid.
  - `payment.failed` marks it failed.
  - `refund.processed` marks it refunded.
  - `refund.failed` puts the payment back to `CAPTURED` and logs an error.
  - Other events are recorded as `IGNORED`.
- A captured amount or currency that does not match the order issues no credits (`AMOUNT_MISMATCH`, logged as an error for review).

### Refunds

Admins with `payments.manage` refund a paid purchase in full.

1. The refund is audited before the gateway call.
2. The payment moves to `REFUND_PENDING`.
3. When the gateway reports it processed, either immediately, through the `refund.processed` webhook, or through hourly reconciliation, the purchase becomes `REFUNDED`.
4. The credits still unused in that purchase's lot are withdrawn with an `ADMIN_ADJUSTMENT` entry keyed `refund:<id>`.

Credits already spent, or held by an interview in progress, stay with the candidate.

### Coupons

The server checks a coupon's rules in this order: exists, active, started, not expired, total uses, plan restriction, per-user limit. The quote returns the first failing rule, and the checkout shows it next to the field. An order with a coupon that does not apply is refused, never silently charged in full.

Uses are counted when a purchase is paid, not when it is ordered. Two unpaid orders can therefore both pass the limit check, and both are honoured if both are paid. A candidate who has paid is never refused.

A discounted total between ₹0 and ₹1 is raised to ₹1, Razorpay's minimum.

## Security

- **Prices come from the server only.** The client sends a plan code and a coupon code, never an amount. The amount charged is re-checked against the order during verify, webhook and reconciliation.
- **Signatures are checked in constant time.**
  - Checkout: HMAC-SHA256 of `order_id|payment_id` with the key secret.
  - Webhooks: HMAC-SHA256 of the raw body with the webhook secret.
    Secrets never appear in errors or logs, and Razorpay error descriptions are dropped; only the error code is kept.
- **Ownership:**
  - Verify looks the order up together with the caller's user id. Another user's order returns 404.
  - Purchases are always read with the caller's user id.
- **Mock gateway:**
  - `PAYMENT_PROVIDER=mock` is refused in staging and production (environment validation).
  - `POST /payments/mock/checkout` answers 404 unless the mock gateway is configured and `APP_ENV` is development or test.
  - The mock keeps orders in the memory of the process that created them. The worker's reconciliation cannot see API orders in development, so unpaid mock orders simply expire.
- **Rate limits:** the `payment` limiter (40 per 10 minutes per user, fail-closed) covers quote, order, verify and mock checkout. Webhooks are authenticated by their signature and are not rate limited.
- **Audit:**
  - Every admin mutation is audited in its transaction: plan versions, activation, coupons, refund, and manual reconcile.
  - Orders and failed verifications are audited too.
- **Permissions:** `payments.read` (support, finance, super) and `payments.manage` (finance, super).

## Configuration

| Variable                               | Where       | Notes                                                                                                                                                                                     |
| -------------------------------------- | ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PAYMENT_PROVIDER`                     | API, worker | `mock` (default; development/test only) or `razorpay`                                                                                                                                     |
| `RAZORPAY_KEY_ID`                      | API, worker | Public key id. It is returned with each order, so the frontends need no build-time key.                                                                                                   |
| `RAZORPAY_KEY_SECRET`                  | API, worker | Secret                                                                                                                                                                                    |
| `RAZORPAY_WEBHOOK_SECRET`              | API         | Secret. The webhook URL is `https://<api>/api/v1/payments/webhooks/razorpay`, with the events `payment.captured`, `order.paid`, `payment.failed`, `refund.processed` and `refund.failed`. |
| `WORKER_PAYMENT_RECONCILE_INTERVAL_MS` | worker      | Default 1 hour                                                                                                                                                                            |

Razorpay must be set to **auto-capture** payments. Only `captured` counts as paid.

The candidate app loads `https://checkout.razorpay.com/v1/checkout.js`. Any Content-Security-Policy in front of it must allow that script, and Razorpay's frames and API origins.

## Operations

- **"I paid but have no credits."** Search Admin → Payments by email, order id or payment id, open the purchase, and press **Reconcile**. It asks Razorpay and applies the result.
- A purchase that shows `AMOUNT_MISMATCH` in the logs needs a manual decision: refund it through the Razorpay dashboard, or grant credits through a credit adjustment.
- A refund stuck in `REFUND_PENDING` is completed by the hourly job once Razorpay reports the payment refunded.

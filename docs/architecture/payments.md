# Payments, plans and credits (Phase 6)

Candidates buy **plans**. A plan grants a number of interview **credits** that stay usable for the plan's validity period. Razorpay takes the money. The append-only credit ledger stays authoritative for what a candidate can spend. A paid purchase adds exactly one ledger lot.

- Contracts: [`packages/shared-types/src/payments.ts`](../../packages/shared-types/src/payments.ts)
- Gateway adapters (Razorpay REST and a dev/test mock): [`packages/provider-adapters/src/payments/`](../../packages/provider-adapters/src/payments/)
- State changes: [`packages/db/src/purchases.ts`](../../packages/db/src/purchases.ts)
- API: [`apps/api/src/modules/payments/`](../../apps/api/src/modules/payments/)
- Reconciliation: [`apps/worker/src/processors/payment-reconcile.ts`](../../apps/worker/src/processors/payment-reconcile.ts)

## Data

| Collection          | Purpose                                                                                                                                                                                                                                                                                                                                               |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `plans`             | Append-only versions per `code`. Only `active` can change, and a partial unique index allows at most one active version per code. A price change is a new version that an admin activates.                                                                                                                                                            |
| `coupons`           | `PERCENT` (1–100) or `FIXED` (paise off) discounts. Each has an optional validity window, total `maxUses`, `perUserLimit` and optional plan restriction. `usedCount` counts uses held by orders (reserved or redeemed).                                                                                                                               |
| `couponRedemptions` | One row per purchase that used a coupon (unique `purchaseId`), `RESERVED` → `REDEEMED` or `RELEASED`. Rows from before reservations have no status and count as `REDEEMED`.                                                                                                                                                                           |
| `couponUserUsages`  | How many uses of a coupon one user holds (unique `couponId + userId`). The per-user limit is enforced on this counter.                                                                                                                                                                                                                                |
| `purchases`         | What was bought, with a frozen snapshot of the plan, the list price, discount, total and currency. Status `CREATED → PAID \| FAILED \| EXPIRED`, and `PAID → REFUNDED`. The status history records the source of each change: `ORDER`, `VERIFY`, `WEBHOOK`, `RECONCILE`, `FREE` or `ADMIN`. A paid purchase has an `invoiceNumber` (unique when set). |
| `payments`          | The gateway side: `orderId` (unique), `paymentId` (unique when set), status, history, whether a Checkout signature was verified, the itemised `refunds`, `refundedMinor` and the `refundFailed` flag.                                                                                                                                                 |
| `invoiceCounters`   | One consecutive invoice sequence per Indian financial year (`fy:2026`).                                                                                                                                                                                                                                                                               |
| `webhookEvents`     | One row per processed gateway event (unique `provider + eventId`), kept for 180 days.                                                                                                                                                                                                                                                                 |

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
  price on the server → purchase CREATED + coupon use RESERVED (one transaction)
  → gateway order → payment CREATED → {keyId, orderId}
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
3. It turns the coupon reservation into a redemption (see [Coupons](#coupons)).
4. It gives the purchase the next invoice number of the financial year (see [Receipts](#receipts-and-invoices)).
5. It marks the payment `CAPTURED`.

Only the call whose conditional update matched issues credits. Every other call (a second verify, the webhook, `order.paid` after `payment.captured`, or reconciliation) returns `issued: false`. The unique ledger key is a second guard. Tests run verify, duplicate webhooks and `order.paid` concurrently and assert one ledger entry. See `payments.integration.test.ts` in `apps/api` and `purchases.integration.test.ts` in `packages/db`.

### Webhooks

- Mounted before the JSON parser, with `express.raw`. The signature covers the bytes as received, so re-serialised JSON fails.
- An invalid signature returns 400 and nothing is stored.
- The event id comes from `X-Razorpay-Event-Id`, or a SHA-256 of the body when the header is missing. It is inserted before any processing. A duplicate returns 200 `DUPLICATE` without being processed again.
- If processing throws, the claim is deleted and the response is 500. Razorpay then retries, and every step is idempotent.
- Handled events:
  - `payment.captured` and `order.paid` mark the purchase paid.
  - `payment.failed` marks it failed.
  - `refund.processed` applies the refund (partial or full) once per refund id.
  - `refund.failed` marks the refund failed, puts the payment back to `CAPTURED`, sets `refundFailed` (shown in Admin → Purchases) and records a `payments.refund.failed` audit entry (actor `SYSTEM`).
  - Other events are recorded as `IGNORED`.
- A captured amount or currency that does not match the order issues no credits (`AMOUNT_MISMATCH`, logged as an error for review).

### Refunds

Admins with `payments.manage` refund all or part of a paid purchase.

1. **Preview.** `GET /admin/purchases/:id/refund-preview` returns the amount paid, already refunded and left to refund, and how the purchase's credits were used: granted, used (spent or held by an interview in progress), unused, expired and already withdrawn. It suggests the amount paid prorated to the unused credits (`proratedRefundMinor`, never more than is left). The admin form defaults to this suggestion.
2. **Confirmation.** If the candidate has used credits from the purchase, the request must carry `acknowledgeUsedCredits: true` (the form shows the count and a separate checkbox); otherwise it is refused with 400. A reason is always required.
3. **Claim.** One conditional update moves the payment `CAPTURED → REFUND_REQUESTED` and records the refund entry, only if the amount still fits (`refundedMinor + amount ≤ amountMinor`). The `payments.refund` audit entry is written in the same transaction. Of concurrent requests exactly one gets the claim; the others answer 409 and write nothing, so the gateway is called once and the refund is audited once.
4. **Gateway.** Razorpay is asked to refund the amount (its `amount` parameter makes partial refunds). If the call fails, the claim is released (`CAPTURED` again, entry `failed`, a `payments.refund.request_failed` audit entry) and the admin can retry. Otherwise the payment moves to `REFUND_PENDING` with the gateway refund id.
5. **Processed.** When the gateway reports the refund processed (immediately, through the `refund.processed` webhook, or through hourly reconciliation), it is applied once per refund id: `refundedMinor` grows by the amount. A refund that completes the full amount makes the purchase `REFUNDED`, the payment `REFUNDED`, withdraws **every** unused credit of the purchase's lot and releases the coupon use. A partial refund leaves the purchase `PAID` and the payment `CAPTURED` (so another partial refund can follow) and withdraws the number of unused credits the admin chose (default: all unused). Withdrawals are `ADMIN_ADJUSTMENT` entries keyed `refund:<purchaseId>:<refundId>`.

Credits already spent, or held by an interview in progress, stay with the candidate. A refund made in the Razorpay dashboard arrives only as a webhook: it is recorded for its amount and, if it completes the full amount, withdraws the unused credits.

A claim whose admin request died before reaching the gateway stays `REFUND_REQUESTED`. After `PAYMENT_POLICY.refundClaimStaleMs` (15 minutes) reconciliation asks the gateway: if nothing was refunded the claim is released; if the gateway has it, the `refund.processed` webhook completes it.

### Coupons

The server checks a coupon's rules in this order: exists, active, started, not expired, total uses, plan restriction, per-user limit. The quote returns the first failing rule, and the checkout shows it next to the field. An order with a coupon that does not apply is refused, never silently charged in full.

A use is **reserved when the order is created**, in the same transaction as the purchase, and both limits are enforced by the writes themselves:

- `coupons.usedCount` is incremented only while it is below `maxUses` (a conditional `$inc`).
- The user's `couponUserUsages.held` is incremented only while it is below `perUserLimit`. The counter is unique per coupon and user, and is created (outside the transaction) before the first use.

Two orders racing for the last use write the same document; one transaction gets a write conflict, is retried by the driver and then sees the limit reached. A refused order answers 400 with `rejection: USED_UP` or `ALREADY_USED`, and its purchase is rolled back. Both `usedCount` and the quote therefore count unpaid orders too.

| Event                                                   | Coupon use                                                                          |
| ------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Order created                                           | `RESERVED` (both counters +1)                                                       |
| Payment captured                                        | `REDEEMED`                                                                          |
| Failed payment attempt                                  | kept (the order can still be paid)                                                  |
| No gateway order could be created                       | `RELEASED` (both counters −1)                                                       |
| Order expired (24 h unpaid)                             | `RELEASED`                                                                          |
| Refund completing the full amount                       | `RELEASED`                                                                          |
| Paid after being released (a late capture after expiry) | `REDEEMED` again; the counters grow even past the limits, since the money was taken |

**Migration.** No data migration is needed. `ensureIndexes` creates the unique `couponUserUsages` index at API start. A user's counter is created on their next use of a coupon, starting from the redemptions already on record (rows without a status count), so earlier redemptions still count against `perUserLimit`. Existing `usedCount` values already count paid uses; unpaid orders created before the upgrade reserved nothing and are counted when they are paid.

A discounted total between ₹0 and ₹1 is raised to ₹1, Razorpay's minimum.

### Receipts and invoices

Every purchase that was paid (including one refunded since) has a receipt PDF: `GET /payments/purchases/:id/receipt` for the candidate (Purchases page) and `GET /admin/purchases/:id/receipt` (`payments.read`, purchase detail).

- **Invoice numbers** (`CPI/26-27/000042`, at most 16 characters as GST requires) are consecutive per Indian financial year (April–March, IST). A purchase gets its number when it is paid, in the same transaction, from `invoiceCounters`; a purchase paid before numbers existed gets one at its first download.
- **Seller details** come from System → Settings → **Billing** (`billing` setting): legal name (blank prints the product name), address, GSTIN, SAC code and the GST rate included in prices. With a GSTIN the receipt is a **tax invoice**: seller GSTIN, SAC, taxable value and GST (`gstBreakdown`, prices are GST-inclusive). Without one it is a plain receipt that says it is not a tax invoice.
- Discounts, the coupon code and any refunded amount are shown. Refunds do not issue credit notes yet.
- **Fonts.** Receipts are rendered with pdfkit, as report PDFs are. The standard PDF fonts cover Latin-1 only, so a buyer name in another script (Hindi, Telugu) is left off rather than printed as `?`; the email still identifies the buyer. Set `RECEIPT_FONT_PATH` to one TrueType/OpenType font covering the scripts in use to print every name. No such font ships with the repository.
- The place of supply (CGST/SGST vs IGST) is not determined; the invoice shows a single GST line.

### Credit adjustments

Admins can grant or deduct a candidate's credits by hand in Admin → Payments → **Credits** (also linked from each purchase and from the user column of the purchases list). The page finds an account by exact email or user id (`GET /admin/credits/account`, `payments.read`) and shows the balance, usable lots and the latest ledger entries.

`POST /admin/credits/adjustments` (`credits.adjust`: finance and super admins) takes the user id, a non-zero `delta` (−500 to 500), a required reason and, for grants, optional `expiresInDays`. A grant adds an `ADMIN_ADJUSTMENT` lot; a deduction takes usable credits earliest-expiring first (one ledger entry per lot) and is refused with 409 `INSUFFICIENT_CREDITS` when there are not enough (credits held by an interview in progress are never taken). The ledger entries carry the admin as actor, and the `credits.grant` / `credits.deduct` audit entry is written in the same transaction.

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
  - Every admin mutation is audited in its transaction: plan versions, activation, coupons, refund (with the claim), credit adjustments, and manual reconcile.
  - Orders, failed verifications, refused refund requests and refunds the gateway reports as failed are audited too.
- **Permissions:** `payments.read` (support, finance, super), `payments.manage` (finance, super) and `credits.adjust` (finance, super).
- **Receipts** are served only to the purchase's owner (404 otherwise) and to admins with `payments.read`.

## Configuration

| Variable                               | Where       | Notes                                                                                                                                                                                     |
| -------------------------------------- | ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PAYMENT_PROVIDER`                     | API, worker | `mock` (default; development/test only) or `razorpay`                                                                                                                                     |
| `RAZORPAY_KEY_ID`                      | API, worker | Public key id. It is returned with each order, so the frontends need no build-time key.                                                                                                   |
| `RAZORPAY_KEY_SECRET`                  | API, worker | Secret                                                                                                                                                                                    |
| `RAZORPAY_WEBHOOK_SECRET`              | API         | Secret. The webhook URL is `https://<api>/api/v1/payments/webhooks/razorpay`, with the events `payment.captured`, `order.paid`, `payment.failed`, `refund.processed` and `refund.failed`. |
| `WORKER_PAYMENT_RECONCILE_INTERVAL_MS` | worker      | Default 1 hour                                                                                                                                                                            |
| `RECEIPT_FONT_PATH`                    | API         | Optional. A TrueType/OpenType font covering the scripts of candidates' names; without it non-Latin names are left off receipts.                                                           |

Seller details for receipts are the `billing` system setting (Admin → System → Settings → Billing), not environment variables.

Razorpay must be set to **auto-capture** payments. Only `captured` counts as paid.

The candidate app loads `https://checkout.razorpay.com/v1/checkout.js`. Any Content-Security-Policy in front of it must allow that script, and Razorpay's frames and API origins.

## Operations

- **"I paid but have no credits."** Search Admin → Payments by email, order id or payment id, open the purchase, and press **Reconcile**. It asks Razorpay and applies the result.
- A purchase that shows `AMOUNT_MISMATCH` in the logs needs a manual decision: refund it through the Razorpay dashboard, or grant credits in Admin → Payments → Credits.
- A refund stuck in `REFUND_PENDING` is completed by the hourly job once Razorpay reports the amount refunded. A `REFUND_REQUESTED` claim older than 15 minutes is checked with Razorpay and released if nothing was refunded.
- **Refund failed** (red badge in Purchases, alert on the purchase): Razorpay could not refund. Check the Razorpay dashboard; the payment is `CAPTURED` again, so the refund can be requested again (which clears the flag).

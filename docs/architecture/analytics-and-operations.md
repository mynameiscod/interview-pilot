# Analytics and operations (Phase 11)

Phase 11 adds five things:

- product analytics;
- the admin dashboard, and cost and margin views;
- system health and a queue view;
- feature flags and system settings, including maintenance mode;
- the Candidate Proof architecture, which ships behind a flag that is off.

Links:

- Contracts: [`analytics.ts`](../../packages/shared-types/src/analytics.ts), [`system.ts`](../../packages/shared-types/src/system.ts), [`proof.ts`](../../packages/shared-types/src/proof.ts)
- Models and rollups: [`models/ops.ts`](../../packages/db/src/models/ops.ts), [`analytics.ts`](../../packages/db/src/analytics.ts)
- API: [`apps/api/src/modules/ops/`](../../apps/api/src/modules/ops/)
- Tests: [`ops.integration.test.ts`](../../apps/api/src/modules/ops/ops.integration.test.ts)

## Product analytics

The web apps send **allow-listed client events** to `POST /analytics/events`: up to 25 per batch, and 60 batches a minute per IP. The events describe what a person saw or clicked, such as `page_view`, `report_viewed`, `pricing_viewed` or `checkout_started`.

**Business facts are never client events.** Registrations, interviews, payments and AI cost are read from the source collections, so a client can't inflate them.

**No personal data** is accepted:

- event names come from a fixed list;
- `path` must be a route pattern such as `/app/interviews/:id/setup`: no real ids, tokens or query strings;
- `props` holds at most 10 short scalar values with camelCase keys;
- the IP address is not stored.

Each browser keeps a random `anonId`. When the caller is signed in, the event is also linked to the user. The web client doesn't send anything when the browser's Do Not Track setting is on.

Client timestamps are trusted only within the 24 hours before receipt. Anything else is stamped with the receive time.

`analyticsEvents` is kept for 400 days (a TTL index) and is separate from the append-only audit log.

## Daily rollups

`analyticsDaily` holds one row per India-time calendar day, metric and dimension set (`dimsHash`; `''` is the total). The metrics are computed from the source collections:

| Metric                                                                  | Source                                                                                 |
| ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| registrations, onboarded                                                | `users` (candidates only) `createdAt` / `onboardingCompletedAt`                        |
| active_users                                                            | distinct users with a client event, or an interview created or started that day        |
| interviews_created / started / completed                                | `interviewSessions` `createdAt` / `startedAt` / `endedAt` (PROCESSING or REPORT_READY) |
| interviews_failed                                                       | started interviews whose history reaches FAILED or EXPIRED that day                    |
| reports_ready                                                           | report revision 0 `generatedAt`                                                        |
| purchases_paid, revenue_minor, refunds_minor, first_purchases           | `purchases.statusHistory` (PAID / REFUNDED)                                            |
| ai_calls, ai_cost_usd_micros, ai_cost_inr_micros (total and by feature) | `aiUsage`                                                                              |

**How and when rollups run.** A day's rows are replaced in one transaction, so recomputing is idempotent. The worker recomputes today and yesterday every 15 minutes (`WORKER_ANALYTICS_ROLLUP_INTERVAL_MS`); yesterday is included to catch late updates after midnight. Admins with `queues.manage` can recompute any range of up to 366 days (`POST /admin/analytics/rollup`), and each backfill is audited.

## Dashboard and costs

**Dashboard.** `GET /admin/analytics/dashboard?from&to` (`analytics.read`) covers a range of India-time days (default 30, maximum 366). It returns:

- **KPIs:** sums of the daily totals.
  - Active users are counted as distinct users over the whole range, because daily counts can't be added up.
  - Completion and failure rates are divided by interviews started.
  - The free→paid rate is the share of candidates who registered in the range and have ever paid.
- **Money** (INR paise):
  - AI cost in USD is converted at the configured `finance.usdToInr` rate.
  - Gateway fees are `revenue × finance.gatewayFeeRate`.
  - Gross margin is `(revenue − refunds − AI cost − fees) ÷ (revenue − refunds)`.
- **Funnel:** follows the cohort of candidates who registered in the range. The steps are registered → onboarded → created an interview → started → completed → viewed a report (a client event) → paid.
- **Provider health:** the latest window per provider and model.
- **Targets:** the `targets` setting. The brief's §57 target values were never received, so the defaults are **placeholders**: completion 70%, free→paid 5%, gross margin 60%, failure rate at most 3%. The business should set real values in **System → Settings**.
- **`computedAt`:** tells the admin how fresh the rollups are.

**Costs.** `GET /admin/analytics/costs?groupBy=feature|provider|model|day` groups AI cost live from `aiUsage`, by India-time day when grouped by day. It returns calls, failures and cost per group, the revenue and margin totals, the AI cost per completed interview, and a daily margin series.

## System health and queues

**Health.** `GET /admin/system/health` (`system.read`) reports:

- MongoDB and Redis reachability and latency;
- worker heartbeats: the Redis keys each worker refreshes, with their age;
- job counts for every BullMQ queue;
- live, processing and **stuck** interviews (PROCESSING for more than 30 minutes);
- the maintenance setting.

**Queue view.** It lists failed jobs, with the first 500 characters of the error. It shows only the id-like fields of each job's payload, although payloads carry ids only anyway.

**Retry.** `POST /admin/system/queues/:name/jobs/:id/retry` (`queues.manage`) moves one failed job back to waiting. Each retry is audited. It answers 404 if the job is no longer failed.

The API opens its queue connections only when the queue view is first used.

## Feature flags

`featureFlags` holds a key, a description, `enabled`, `rolloutPercent` (0–100) and `clientVisible`.

- **Seeding.** Known flags are created, off, at API start.
- **Rollout.** A user is in the rollout when `sha256(key:userId) mod 100 < rolloutPercent`, so a rollout is stable per user. Partial rollouts never include anonymous visitors.
- **Reading flags.** `GET /flags` returns the client-visible flags evaluated for the caller.
- **Changing flags.** Changes need `system.manage` (SUPER_ADMIN only) and a reason, and are audited with the before and after values.
- **Caching.** Flags and settings are cached for 15 seconds per API process, so a change reaches every replica within 15 seconds.

## System settings

`systemSettings` holds validated values. A stored value that fails its schema falls back to the default, so a bad row never breaks callers.

| Key           | Value                                                           | Default                  |
| ------------- | --------------------------------------------------------------- | ------------------------ |
| `maintenance` | `{enabled, message}`                                            | off                      |
| `finance`     | `{usdToInr, gatewayFeeRate}`                                    | ₹84 per USD, 2%          |
| `targets`     | `{completionRate, freeToPaidRate, grossMargin, maxFailureRate}` | placeholders (see above) |

**Maintenance mode** makes interview starts and campaign joins answer `503 MAINTENANCE` with the admin's message. Interviews already running continue. The web apps show the banner from the public `GET /system/status`, which can be cached for 30 seconds.

## Candidate Proof (flag `reports.publicProof`, off)

A candidate can share a read-only proof of one report by link.

- **While the flag is off, every proof endpoint answers 404**, as if it didn't exist.
- **Tokens:** 144 random bits. Only the SHA-256 is stored, and the path is shown once.
- **Links:** they last 1–30 days (default 14), each report can have at most 5 active, and the candidate can revoke them. Creating and revoking are audited. Views are counted, with no viewer data kept. Expired links are deleted 30 days after they expire.
- **What the proof shows:** the candidate's display name, the role title, the mode, the completion date, the overall score, band and confidence, the dimension scores and weights, and whether the report was reviewed.
- **What it never shows:** the transcript, answers, evidence, rationales, summary, the target company, or contact details.
- **Which revision:** the latest report revision the candidate may see. If the report stops being visible to the candidate (a campaign hides it), its links stop working.
- **Search engines:** proof pages are served with `X-Robots-Tag: noindex`.

## Permissions

| Permission       | Roles                      | Grants                                    |
| ---------------- | -------------------------- | ----------------------------------------- |
| `analytics.read` | SUPER, OPERATIONS, FINANCE | Dashboard, costs                          |
| `system.read`    | SUPER, OPERATIONS          | Health, queues, flags and settings (view) |
| `system.manage`  | SUPER                      | Change flags and settings                 |
| `queues.manage`  | SUPER, OPERATIONS          | Retry failed jobs, recompute rollups      |

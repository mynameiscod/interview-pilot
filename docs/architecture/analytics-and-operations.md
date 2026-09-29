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
- API: [`apps/api/src/modules/ops/`](../../apps/api/src/modules/ops/), [`middleware/maintenance.ts`](../../apps/api/src/middleware/maintenance.ts), [`admin/audit-log.service.ts`](../../apps/api/src/modules/admin/audit-log.service.ts)
- Tests: [`ops.integration.test.ts`](../../apps/api/src/modules/ops/ops.integration.test.ts)

## Product analytics

The web apps send **allow-listed client events** to `POST /analytics/events`: up to 25 per batch, and 60 batches a minute per IP. The events describe what a person saw or clicked, such as `page_view`, `pricing_viewed` or `checkout_started`.

**Business facts are never client events.** Registrations, interviews, payments and AI cost are read from the source collections, so a client can't inflate them.

**Server events.** A few events feed the funnel and are recorded only by the API (`ServerEventName`); the ingestion endpoint rejects them. `report_viewed` is stored when the owner fetches their report (`GET /reports/:sessionId`, a candidate-visible revision only), at most once per user and India-time day, with `anonId: "server"`. Before this, any caller could post `report_viewed` and inflate the "viewed a report" step.

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
- **Funnel:** follows the cohort of candidates who registered in the range. The steps are registered → onboarded → created an interview → started → completed → viewed a report (recorded by the server) → paid.
  - It is one aggregation on `users` (`funnelPipeline`): each step after onboarding is a `$lookup` into interviews, analytics events or purchases that stops at the first matching record, and a final `$group` counts the users per step. No id lists travel between MongoDB and the API, however large the cohort. Active users are counted the same way (`$unionWith` + `$group`).
  - The integration tests seed a mixed cohort and check that the results match the previous `distinct()`/`$in` implementation.
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
- **Caching.** Flags and settings are cached per API process. A change is published on the Redis channel `cbi:ops:config-changed` (`OPS_CONFIG_CHANNEL`), and every API process drops its cached flags and settings as soon as the message arrives, the same way AI configuration and integration changes are shared. Each process subscribes on its own Redis connection at start and unsubscribes on shutdown. The 15-second cache lifetime stays as a fallback in case a message is missed (for example during a Redis blip). The worker reads no flags or settings, so it does not subscribe.

## System settings

`systemSettings` holds validated values. A stored value that fails its schema falls back to the default, so a bad row never breaks callers.

| Key           | Value                                                           | Default                  |
| ------------- | --------------------------------------------------------------- | ------------------------ |
| `maintenance` | `{enabled, message}`                                            | off                      |
| `finance`     | `{usdToInr, gatewayFeeRate}`                                    | ₹84 per USD, 2%          |
| `targets`     | `{completionRate, freeToPaidRate, grossMargin, maxFailureRate}` | placeholders (see above) |

**Maintenance mode** makes the candidate API read-only. A middleware on `/api/v1` (`maintenanceGuard`) answers every `POST`, `PUT`, `PATCH` and `DELETE` with `503 MAINTENANCE`, the admin's message, `details.maintenance` and `Retry-After: 120`. Reads keep working, so candidates can still see their reports. These writes stay open (`MAINTENANCE_EXEMPT_PATHS`):

- `/auth/**`: signing in and out, OTP, refresh and identity linking, so nobody is locked out;
- `/admin/**`: admins run the maintenance. A request from any admin (a current admin token, or a candidate token of a user with admin roles) also passes on candidate routes;
- payment webhooks and `POST /payments/verify` (and the development mock checkout): the money has already moved, so the purchase must be recorded;
- `POST /analytics/events`: telemetry, not a change;
- an interview that is already running: ending it, switching mode, transcription, coding answers and recording uploads. New interviews can't be created, set up, started or joined (campaigns), as before.

The setting is read through the settings cache, so the check costs no database query, and an admin change applies on every process at once. If the setting can't be read, the request goes through: maintenance must never cause an outage. The web apps show the banner from the public `GET /system/status`, which can be cached for 30 seconds. The candidate app also turns the banner on as soon as any request is refused with `503 MAINTENANCE`, even if the candidate dismissed it, and shows the admin's message instead of a generic error.

## Candidate Proof (flag `reports.publicProof`, off)

A candidate can share a read-only proof of one report by link.

- **While the flag is off, every proof endpoint answers 404**, as if it didn't exist.
- **Tokens:** 144 random bits. Only the SHA-256 is stored, and the path is shown once.
- **Links:** they last 1–30 days (default 14), each report can have at most 5 active, and the candidate can revoke them. Creating and revoking are audited. Views are counted, with no viewer data kept. Expired links are deleted 30 days after they expire.
- **What the proof shows:** the candidate's display name, the role title, the mode, the completion date, the overall score, band and confidence, the dimension scores and weights, and whether the report was reviewed.
- **What it never shows:** the transcript, answers, evidence, rationales, summary, the target company, or contact details.
- **Which revision:** the latest report revision the candidate may see. If the report stops being visible to the candidate (a campaign hides it), its links stop working.
- **Search engines:** proof pages are served with `X-Robots-Tag: noindex`.

## Audit log

Admin → Audit log (`audit.read`) lists `auditLogs` newest first, 50 at a time. It filters by action, actor id, resource id and a date range (`from` inclusive, `to` exclusive, ISO 8601 instants; the admin app turns the chosen days into the admin's local midnights and includes the whole last day).

**CSV export.** `GET /admin/audit-logs/export.csv` takes the same filters and returns every matching entry. It needs `audit.export`, which only SUPER_ADMIN has:

- The export is recorded first (`audit.exported`, with the filters), in a transaction. If that write fails, nothing is sent.
- Rows are streamed from a MongoDB cursor, respecting back-pressure, and the cursor stops if the client goes away. The log is never held in memory.
- Cells that a spreadsheet would run as a formula (starting with `=`, `+`, `-`, `@`, tab or carriage return) are prefixed with `'`. `details` is written as JSON.

**Retention.** Entries are kept for `AUDIT_LOG_RETENTION_DAYS` (default 730 days = two years, 30–3650), then MongoDB's TTL monitor deletes them. This is the only way entries leave the append-only collection. The TTL sits on the `{ at: -1 }` index. At startup, `ensureIndexes` creates it with the configured expiry, or changes it in place with `collMod` when the value changed; this also converts the plain time index of older deployments. A lower value deletes older entries within about a minute of the next API start.

## Permissions

| Permission       | Roles                      | Grants                                    |
| ---------------- | -------------------------- | ----------------------------------------- |
| `analytics.read` | SUPER, OPERATIONS, FINANCE | Dashboard, costs                          |
| `system.read`    | SUPER, OPERATIONS          | Health, queues, flags and settings (view) |
| `system.manage`  | SUPER                      | Change flags and settings                 |
| `queues.manage`  | SUPER, OPERATIONS          | Retry failed jobs, recompute rollups      |
| `audit.read`     | SUPER, OPERATIONS, FINANCE | Audit log (view and filter)               |
| `audit.export`   | SUPER                      | Audit log CSV export                      |

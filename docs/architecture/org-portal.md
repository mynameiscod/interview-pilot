# Employer and college portal (org portal MVP)

Employers and colleges run their own campaigns: they invite candidates, follow them through a pipeline, review them together and export results. Colleges (training and placement offices, TPOs) also see cohort readiness. Everything is built on [campaigns and review](campaigns-and-review.md); this page covers what the portal adds.

- Contracts: [`packages/shared-types/src/org.ts`](../../packages/shared-types/src/org.ts), [`invite-csv.ts`](../../packages/shared-types/src/invite-csv.ts), org roles in [`permissions.ts`](../../packages/shared-types/src/permissions.ts)
- Models: [`packages/db/src/models/org.ts`](../../packages/db/src/models/org.ts); org results [`org-results.ts`](../../packages/db/src/org-results.ts); cohort analytics [`org-analytics.ts`](../../packages/db/src/org-analytics.ts); webhook outbox [`org-webhooks.ts`](../../packages/db/src/org-webhooks.ts)
- API: [`apps/api/src/modules/orgs/`](../../apps/api/src/modules/orgs/); campaigns reuse [`campaigns.service.ts`](../../apps/api/src/modules/campaigns/campaigns.service.ts) with an org scope
- Worker: [`invite-mailer.ts`](../../apps/worker/src/processors/invite-mailer.ts), [`webhook-dispatch.ts`](../../apps/worker/src/processors/webhook-dispatch.ts)
- Web: the portal lives in the admin web app under `/org` ([`apps/admin-web/src/org/`](../../apps/admin-web/src/org/)); CodeBegun admins manage organisations under `/orgs`
- Tests: [`orgs.integration.test.ts`](../../apps/api/src/modules/orgs/orgs.integration.test.ts) (tenant isolation, invites, wallet and quota, pipeline, webhooks, API keys, cohort, identity), [`org-outbox.integration.test.ts`](../../apps/worker/src/processors/org-outbox.integration.test.ts) (reminders, webhook signing and retry)

## Organisations and members

An organisation has a type (`EMPLOYER` or `COLLEGE`), a status, **seats** (live members), an **interview quota** (candidates who may join its campaigns in total; empty = unlimited) and a **wallet** of sponsored interviews.

- **Created by CodeBegun.** A super admin creates the organisation and its first owner is invited by email (`orgs.manage`; `orgs.read` for operations and support admins to look). Suspending an organisation blocks every member and API key at once.
- **Members.** Owners invite members by email within the seats. A person belongs to at most one organisation (unique index on live memberships) and staff accounts cannot be members. The first sign-in turns an `INVITED` membership `ACTIVE`. An organisation always keeps an owner; removing a member ends their org sessions.

| Org permission            | Owner | Recruiter | Viewer | Grants                                                 |
| ------------------------- | ----- | --------- | ------ | ------------------------------------------------------ |
| `org.read`                | ✔     | ✔         | ✔      | Campaigns, results, candidates, cohort analytics       |
| `org.campaigns.manage`    | ✔     | ✔         |        | Create and change campaigns, send and revoke invites   |
| `org.pipeline.manage`     | ✔     | ✔         |        | Move candidates between stages, decide identity checks |
| `org.review`              | ✔     | ✔         | ✔      | Notes and scorecards                                   |
| `org.export`              | ✔     | ✔         |        | Results CSV and cohort report CSV (audited)            |
| `org.members.manage`      | ✔     |           |        | Members and scorecard criteria                         |
| `org.integrations.manage` | ✔     |           |        | Webhooks and API keys                                  |

## Sign-in: the `org` session audience

Org members sign in at `/org/login` in the admin web app with an email (or SMS) code or Google, exactly like the other apps, but with their own audience (see [authentication](../security/authentication.md#organisation-members-org-portal)):

- tokens, refresh cookie (`cbi_org_rt`, path `/api/v1/org/auth`) and tab channel are separate from the staff console's, so an org token never opens an admin route and the reverse;
- codes go only to members of active organisations (others get the same answer and no code);
- **MFA is optional per organisation**: with `mfaRequired` members must set up an authenticator app (TOTP) at sign-in; otherwise it is asked only of members who set one up. The MFA challenge records its audience, so an org challenge can never complete an admin sign-in;
- every request and refresh checks the live membership: removal, a role change or suspension applies at once (user-state cache invalidated).

## Campaigns

Org campaigns are ordinary campaigns with `orgId` set. The campaign service takes a scope: for an org member **every query filters by `orgId`**, and another organisation's campaign id answers `404` exactly like a missing one. CodeBegun admins keep seeing every campaign.

New settings (defaults keep existing campaigns unchanged):

| Setting         | Meaning                                                                                                |
| --------------- | ------------------------------------------------------------------------------------------------------ |
| `requireInvite` | Invite only: only invited emails can join, even with the shared link (`403 INVITE_REQUIRED` otherwise) |
| `employerView`  | `SCORES` (overall, band, dimensions) or `FULL_REPORT` (also summary, strengths, gaps, transcript)      |
| `idCapture`     | Selfie and ID photo before starting (see identity check below)                                         |
| `reminders`     | On/off, at most **2** reminders, hours between them (≥ 12)                                             |

Candidates see the employer view, identity capture and invite-only notices on the landing page (en, hi, te) before joining.

**Wallet and quota.** A campaign's sponsored budget comes out of the organisation's wallet: creating or raising `sponsoredCredits` moves units from `wallet.balance` to `wallet.allocated` in the same transaction, conditional on the balance (`402 INSUFFICIENT_CREDITS` otherwise); lowering the budget gives units back; **closing** a campaign returns unused units. Starting an interview then uses the existing atomic claim on the campaign budget. Each join also claims one unit of the organisation's interview quota in the join transaction (`$inc` conditional on `used < total`), so the quota is never exceeded; a full quota answers `409 CAMPAIGN_CLOSED`.

## Invites

- **Single or bulk.** Up to 1,000 per request. Bulk upload is a CSV (`email`, optional `name`, `language` en/hi/te, `batch`, `branch`, `year`) checked by the server first (`POST …/invites/preview`: valid rows, errors by line, duplicates); nothing is saved until the organisation confirms the valid rows. One invite per email per campaign (unique index); repeats are skipped.
- **Personal links.** Each invite has its own token (144 bits) and link `/campaign/i/<token>`, in addition to the campaign's shared link. The token's SHA-256 is stored for lookups and the token itself is **encrypted with the platform secret box** (bound to the invite id), because the worker must put the same link in the invite and each reminder. Revoking an invite makes its link answer 404.
- **Matching.** Joining links the application to the invite when the candidate's verified emails include the invite's email (a forwarded personal link does not mark someone else's invite joined). Invite-only campaigns refuse candidates without a matching invite.
- **Status**: `PENDING` (queued) → `SENT` → `OPENED` (first visit of the personal link) → `JOINED` → `COMPLETED` (report ready); `FAILED` (email not delivered after 3 tries; can be retried) and `REVOKED`. The invites list shows the funnel per status.
- **Emails and reminders** are sent by the worker's `invite-mail` job (every `WORKER_INVITE_MAIL_INTERVAL_MS`, default 1 minute, `WORKER_INVITE_MAIL_BATCH` per run) in the invitee's language (en, hi, te). Each invite carries `nextSendAt`: the API sets it for a new invite; after the invite and each reminder the worker sets the next reminder time from the campaign's interval, or null when nothing more is due. It stops when the candidate joins, the invite is revoked or the campaign closes or ends, and waits while the campaign is a draft or paused. Claims (`nextSendAt` pushed forward before sending) keep two worker replicas from sending twice.

## Pipeline and collaboration

- **Consent first.** The org results are the shared results pipeline in org mode: **only applications whose interview has an accepted `CAMPAIGN_SHARING` consent** are listed, counted, exported, sent to webhooks or readable by API keys. A candidate who joined but has not agreed yet is invisible to the organisation. What is shown follows the campaign's employer view.
- **Stages**: `NEW`, `SHORTLISTED`, `ON_HOLD`, `REJECTED`, `HIRED`, kept on the application with its history (who, when, optional note). Bulk changes take up to 500 applications. Each change is audited and sent as `candidate.stage_changed`.
- **Notes** with `@mentions` stored as plain text next to the note (nothing is linked or notified). The audit log records that a note was added, not its text.
- **Scorecards**: the organisation's criteria (default communication, problem solving, role fit; owners edit them), each rated 1–5, and a recommendation (strong yes … strong no), one per reviewer per candidate. The results show the mean of the reviewers' averages.
- **Results view**: filters by status, stage, overall score, dimension (`key:min`) and scorecard average; a stage board with counts; everything paged in MongoDB. **CSV** (`org.export`) is streamed from a cursor like the admin export (BOM, formula neutralisation) with stage, scorecards, cohort tags and the identity check; every export is audited with its row count.
- Viewing a candidate (`org.candidate_viewed`), identity images (`org.identity_viewed`) and every change are audited with the organisation id.

## College cohort readiness (TPO)

For `COLLEGE` organisations, `GET /org/analytics/cohort` (filters: campaign, batch, branch, year from the invite tags):

- participation: invited, joined, completed, and completed ÷ invited;
- readiness bands and dimension averages on each student's **latest scored, shared** attempt across the college's campaigns;
- improvement per student between the **first and latest** scored attempts (students with two or more), with the average change and how many improved or declined.

The cohort report CSV (`org.export`, audited) has one row per student. The aggregation is a pure function ([`aggregateCohort`](../../packages/db/src/org-analytics.ts)) over attempts loaded with a few indexed queries.

## Webhooks

Owners register up to 10 HTTPS endpoints for `campaign.candidate_completed` (the report is ready; sent once per application) and `candidate.stage_changed`. The signing secret (`whsec_…`) is shown once and stored encrypted with the platform secret box.

- **Outbox.** Events are written to `webhookDeliveries` (in the same transaction as a stage change; by the evaluation pipeline's last stage for completions), then sent by the worker's `webhook-dispatch` job (every `WORKER_WEBHOOK_INTERVAL_MS`, default 15 s). The body is fixed when the event happens, so retries send the same bytes.
- **Request.** `POST` with `Content-Type: application/json` and headers `X-CB-Event`, `X-CB-Delivery` (the delivery id; use it to de-duplicate) and **`X-CB-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "<t>.<raw body>")>`**. Body: `{ "id", "event", "createdAt", "data" }` (`data` is `CandidateCompletedPayload` or `StageChangedPayload`).
- **Delivery.** Through the same SSRF guard as job-description fetching (public addresses only, pinned connection, no redirects), timeout `WEBHOOK_TIMEOUT_MS` (10 s). A 2xx is delivered; anything else is retried after 30 s, 2 min, 10 min, 30 min, 1 h, 3 h and 6 h, and the delivery is `FAILED` after 8 attempts. Paused webhooks and suspended organisations are not sent to. The delivery log (last 30 days) shows attempts, status codes and short reasons, never the receiver's response body.

Verifying a signature (Node.js):

```js
import { createHmac, timingSafeEqual } from 'node:crypto';

function verify(secret, header, rawBody, toleranceSec = 300) {
  const parts = Object.fromEntries(header.split(',').map((p) => p.split('=')));
  const t = Number(parts.t);
  if (!t || Math.abs(Date.now() / 1000 - t) > toleranceSec) return false;
  const expected = createHmac('sha256', secret).update(`${t}.${rawBody}`).digest();
  const given = Buffer.from(parts.v1 ?? '', 'hex');
  return given.length === expected.length && timingSafeEqual(given, expected);
}
```

## API keys

Owners create read-only keys (scope `results:read`) for ATS integrations: `cbk_<8-char prefix>_<256-bit secret>`, shown once; only the SHA-256 is stored (the key is random, so a slow hash adds nothing). `Authorization: Bearer cbk_…` on:

- `GET /api/v1/org-api/campaigns` — the organisation's campaigns;
- `GET /api/v1/org-api/campaigns/:id/results` — one page of results (same filters and consent rule as the portal).

Unknown and revoked keys answer `401` alike; another organisation's campaign `404`; a suspended organisation `403`. Rate limit 120 requests per minute per key. Every results read is audited (`org.api_results_read`, actor `API_KEY`); `lastUsedAt` is updated at most once a minute.

### Connecting Greenhouse, Lever or Zoho Recruit

There is no vendor-specific connector yet. The pattern is the same for all three:

1. Create an API key and a webhook (both in **Integrations**), subscribed to `campaign.candidate_completed` and `candidate.stage_changed`.
2. Point the webhook at a small integration service you run (or an iPaaS such as Zapier/Make/n8n with a code step). It verifies `X-CB-Signature`, de-duplicates on `X-CB-Delivery`, and on `campaign.candidate_completed` looks the candidate up by email in the ATS:
   - **Greenhouse (Harvest API):** find the candidate/application, then add the overall score, band and a link as a note or custom field on the application (and optionally advance the stage).
   - **Lever (API):** find the opportunity by email and add a note (or tag) with the scores; move the stage if your process does.
   - **Zoho Recruit (API):** find the candidate and update a custom field or add a note.
3. Use `GET /org-api/campaigns/:id/results` to backfill or reconcile (for example nightly), with the API key.
4. If you want stage changes in CareerPilot to follow the ATS, map `candidate.stage_changed` the other way only after deciding which system is the source of truth; stages here are the organisation's own shortlist, not a replacement for the ATS pipeline.

Remember that candidates agreed to share their results with the organisation, not with anyone else: keep the ATS access limited to the people who hire for the role.

## Identity check

A campaign can ask candidates to capture a **selfie and a photo of an ID** before the interview (and, in video interviews, one still frame is taken from the camera about 20 seconds in). Reviewers see the photos side by side and mark the capture **verified** or a **mismatch**. There is **no automated face matching**, deliberately:

- **Accuracy.** Face matching between a live selfie and a small, often worn ID photo has high error rates in uncontrolled conditions (lighting, cameras, age of the photo), and a false "mismatch" would unfairly stop a real candidate.
- **Bias.** Published evaluations of face recognition show uneven error rates across skin tones, ages and genders; an automated decision would carry that bias into hiring.
- **Law.** A face template is biometric data; building one needs a specific lawful basis and safeguards (DPDP Act, and stricter rules in other places the organisation may hire), and automated decisions with significant effects need human review anyway.

Rules:

- A required `IDENTITY_CAPTURE` consent (seeded text; translate it in Admin → Consent texts) is asked with the other consents; nothing is captured before it is accepted. The start gate refuses to start until both photos are saved.
- Images are uploaded as raw JPEG/PNG (≤ 2 MB, type checked against the magic bytes), stored under `identity/<user>/<session>/…` and kept for the recording retention (`MEDIA_RETENTION_DAYS_DEFAULT`, 90 days); the worker's media sweep deletes them after that and account erasure deletes them at once. A new photo clears an earlier decision.
- Reviewers fetch images through the API with their bearer token (audited per view); there are no public links. Candidates are asked to cover numbers they do not need to show (Aadhaar).

## Data protection

See [data protection](../security/data-protection.md#organisations-org-portal): organisations only see candidates who consented and only what the employer view allows; erasure removes identity captures, the organisation's notes and scorecards about the person, and the invites they joined through.

## Configuration

| Variable                         | Default | Where  | Meaning                                         |
| -------------------------------- | ------- | ------ | ----------------------------------------------- |
| `WORKER_INVITE_MAIL_INTERVAL_MS` | 60000   | worker | How often due invites and reminders are emailed |
| `WORKER_INVITE_MAIL_BATCH`       | 200     | worker | Emails per run                                  |
| `WORKER_WEBHOOK_INTERVAL_MS`     | 15000   | worker | How often due webhook deliveries are sent       |
| `WEBHOOK_TIMEOUT_MS`             | 10000   | worker | Receiver timeout per attempt                    |

Invite links use `PUBLIC_CANDIDATE_URL` (worker); member invitations point to `PUBLIC_ADMIN_URL/org` (API). Invite tokens and webhook secrets use `AI_SECRETS_MASTER_KEY` (the platform secret box): rotate it as in the key-rotation runbook.

## Not in this MVP

- One organisation per person; no organisation switcher.
- Org members cannot set up an authenticator from an account page (only at sign-in when the organisation requires it); staff remove a lost factor as for admins.
- No vendor-specific ATS connectors, no inbound (ATS → CareerPilot) sync, no per-webhook event filtering by campaign.
- No automated face matching (by design) and no liveness check.
- Package (ZIP) exports remain a CodeBegun admin feature; organisations export CSV.

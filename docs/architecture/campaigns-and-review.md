# Campaigns and manual review (Phase 10)

A **campaign** is a company's interview that every candidate takes on the same terms. The company fixes one role blueprint, one template version, and the same modes, languages and rules. Candidates join through an invite link. Results come back to the admins running the campaign, and the campaign decides whether candidates see their own report.

**Manual review** lets staff flag an interview and revise its scores. Each revision is a new score and report. The AI original is never changed.

Employers and colleges can also run campaigns themselves in the **org portal**: personal invites with reminders, invite-only campaigns, a candidate pipeline with notes and scorecards, cohort analytics, webhooks and API keys, and an optional identity check. See [the org portal](org-portal.md). CodeBegun admins still see and manage every campaign, including organisations' (`campaigns.orgId`).

- Contracts: [`packages/shared-types/src/campaign.ts`](../../packages/shared-types/src/campaign.ts), [`review.ts`](../../packages/shared-types/src/review.ts)
- Models: [`packages/db/src/models/campaign.ts`](../../packages/db/src/models/campaign.ts); results queries: [`packages/db/src/campaign-results.ts`](../../packages/db/src/campaign-results.ts)
- Package exports: [`apps/worker/src/processors/campaign-export.ts`](../../apps/worker/src/processors/campaign-export.ts)
- API: [`apps/api/src/modules/campaigns/`](../../apps/api/src/modules/campaigns/), [`apps/api/src/modules/review/`](../../apps/api/src/modules/review/)
- Authorization tests: [`campaigns.integration.test.ts`](../../apps/api/src/modules/campaigns/campaigns.integration.test.ts)

## Campaigns

### Everything is pinned at creation

Creating a campaign pins the following:

- the role's **active blueprint** (id and version);
- the **active template version** for the chosen template key.

Later library changes do not affect a running campaign.

For campaign interviews, the worker's role analysis uses the pinned blueprint and never generates a tailored one. So every candidate is assessed on the same competencies with the same weights. The optional job description is shown to candidates and is used in their analysis context, but it doesn't change the blueprint.

The role, template and modes cannot change after creation. These can: name, company name, job description, window, candidate limit, report visibility and sponsored budget. Every change needs a reason and is audited.

### Status

| From   | Allowed to     |
| ------ | -------------- |
| DRAFT  | ACTIVE, CLOSED |
| ACTIVE | PAUSED, CLOSED |
| PAUSED | ACTIVE, CLOSED |
| CLOSED | — (final)      |

Draft campaigns are invisible to candidates: their links answer 404.

### Invite links

- The token is 18 random bytes (144 bits), base64url. **Only its SHA-256 is stored.** The admin sees the full invite path once, in the create or rotate response. After that, only `tokenHint` (the first 4 characters) is kept, to recognise a link.
- **Rotating** replaces the hash: the old link answers 404 at once. Candidates who already joined keep their interview.
- Unknown, malformed and draft tokens all answer 404 in the same way.

The public landing page is `GET /campaigns/:token`. It needs no sign-in. With a candidate token, it also returns `joinedInterviewId`. It explains why a campaign can't be joined: `NOT_STARTED`, `ENDED`, `PAUSED`, `CLOSED` or `FULL`.

### Joining

`POST /campaigns/:token/join` needs a signed-in candidate.

- **One interview per candidate per campaign.** A unique index on `campaignApplications {campaignId, userId}` enforces this. Joining again returns the same interview: `200` with `created: false`. Two parallel joins by the same candidate resolve to one interview; the loser's duplicate-key error is turned into that answer.
- **The limit is never exceeded.** One transaction claims a place and creates the interview. The claim is a conditional increment of `joinedCount`: it requires status `ACTIVE`, a time inside the window, and `joinedCount < maxCandidates`. Parallel joins that exceed the limit get `409 CAMPAIGN_CLOSED`, with a message for the reason.
- In the same transaction, the join creates:
  - a job target: `PASTE` with the job description, or `ROLE_ONLY`. It is marked ready, since there is nothing to extract.
  - an interview (`DRAFT`) on the pinned template, with `campaignId` set. The mode is the first campaign mode the template offers. The language is the candidate's preference if the campaign offers it, otherwise the campaign's first language.
  - the application, and an audit entry.
- After the transaction, role analysis is started. If starting it fails, the candidate can retry from the interview page.
- Campaign interviews don't count toward the 10-open-drafts limit, because there is only one per campaign.
- Setup (`PATCH /interviews/:id/setup`) only accepts the campaign's modes and languages.

### Starting

- Starting requires the campaign to be `ACTIVE` and not past its end date. Otherwise the start answers `409 CAMPAIGN_CLOSED`. A candidate who joined before the end can finish an interview already in progress.
- **Consent.** Campaign interviews add a required `CAMPAIGN_SHARING` consent: results are shared with the company. The campaign's proctoring settings replace the template's for these interviews:
  - `recording` controls whether the RECORDING consent is asked (video only);
  - `tabSwitchTracking` controls whether the INTEGRITY consent is asked.
- **Sponsored budget.** When a campaign has `sponsoredCredits`, the start transaction tries to claim one: a conditional `$inc` with `used < total`. If the claim succeeds, the session is `sponsored` and its credit status is `SPONSORED`. The candidate's credits are never reserved or settled. If the claim fails because the budget is used up, the candidate's own credit is reserved as usual; with no credit, the start answers `402 INSUFFICIENT_CREDITS`.
  - A technical refund of a sponsored interview returns one unit to the campaign's budget.
  - The budget can be raised, but never lowered below what has been used.

### Report visibility

When `candidateSeesReport` is false:

- the worker creates report revision 0 with `visibility.candidate = false`, so the candidate's report endpoints answer 404;
- the notification email says that the interview was submitted to the company.

The candidate's interview summary carries `campaign.reportVisible`, so the UI shows a "submitted" message instead of a report link.

### Campaign list

`GET /admin/campaigns` is paginated: `page` (from 1) and `pageSize` (1–100, default 25), with an optional `status` filter. The response is `{ items, total, page, pageSize }`, newest first. The admin list page shows previous/next controls and keeps the page in the URL. The interview review filter loads the 100 most recent campaigns for its dropdown; a campaign id from the URL stays selectable.

### Results

`GET /admin/campaigns/:id/results` returns one page of rows, one per application. Each row has:

- the candidate's name and email;
- a status derived from the session: `JOINED` (before start), `IN_PROGRESS`, `COMPLETED` (`PROCESSING` or `REPORT_READY`) or `DID_NOT_FINISH` (cancelled, expired or failed; also an application whose interview is missing);
- the latest score revision (reviews included), with one column per pinned-blueprint dimension;
- the review flag.

Filters are `status`, `minOverall` and `dimension=key:min` (a key outside the pinned blueprint matches nothing). `sort` is `overall_desc` (the default: best first), `overall_asc`, `joined_asc` or `joined_desc`; in both score orders unscored rows come last, and ties keep the order candidates joined. `page` and `pageSize` (1–200, default 50) select the page, and the response carries `total`, the number of matching rows across pages.

**Everything runs in MongoDB.** A single aggregation over `campaignApplications` (index `{campaignId, joinedAt}`) joins each application with its interview (`$lookup` by `_id`) and its latest score (`$lookup` on `{sessionId, revision}`, sorted by revision, limit 1), derives the status with a `$switch` that mirrors `applicationStatus`, then filters, sorts and pages. A `$facet` returns the page and the total together; candidate names and emails are looked up only for the rows on the page. No request loads a whole campaign into memory. The pipeline builder is a pure function with unit tests ([`campaign-results.test.ts`](../../packages/db/src/campaign-results.test.ts)); the API and the worker share it.

### Exports

Exports need `campaigns.manage`, because they carry personal data. Every export is audited (`campaign.results_exported`) with its format and row count.

- **CSV** (`GET /admin/campaigns/:id/results.csv`). The same filters and order as the grid, without paging. It is **streamed**: rows are read from an aggregation cursor and written to the response in batches as they arrive, so memory stays flat for any campaign size. If the connection fails part-way, the response is cut rather than ended cleanly. UTF-8 with a BOM, so spreadsheets read Hindi and Telugu names correctly. Cells that a spreadsheet would run as formulas (`= + - @`, tab, CR) are prefixed with `'`.
- **Package** (`.zip`). It holds `results.csv`, `campaign.json`, and each candidate's latest report as JSON, plus the PDF when it is ready. Packages are built by the worker, not the API:

  1. `POST /admin/campaigns/:id/exports` creates a `campaignExports` record (`QUEUED`) and enqueues `campaign.package` on the `exports` queue; it answers `202` with the export. While an export for the campaign is queued or running, the same one is returned. Campaigns over 5,000 candidates are refused (use the CSV). If the job cannot be queued, the record is marked `FAILED` and the request answers `503`.
  2. The worker marks it `RUNNING` and writes the ZIP entry by entry with a streaming ZIP writer ([`zip-writer.ts`](../../apps/worker/src/exports/zip-writer.ts): deflate, UTF-8 names, data descriptors, no ZIP64). The CSV comes from a cursor; reports are loaded 100 candidates at a time and PDFs are streamed from storage one by one. The archive is spooled to a temporary file (never held in memory), then streamed to object storage at `exports/campaigns/<campaignId>/<exportId>.zip` (`putFile`), and the spool file is deleted. `progress.done`/`progress.total` are saved after each batch. A failed build is retried once from scratch; after the last attempt the record is `FAILED` with a short reason.
  3. `GET /admin/campaigns/:id/exports/:exportId` returns the status and progress. When `READY`, it carries `sizeBytes`, `expiresAt` and a `downloadPath`.
  4. `GET /admin/campaigns/:id/exports/:exportId/download` streams the file from storage (`campaigns.manage`; each download is audited as `campaign.export_downloaded`). The storage providers have no signed URLs for private objects, so downloads go through the API with the admin's bearer token; it answers `409` when the export is not ready or has expired.

  The admin console starts an export, polls it every 2 seconds while it is queued or running (with a progress bar), and then shows a download button.

  **Retention.** A finished package can be downloaded for `CAMPAIGN_EXPORT_RETENTION_HOURS` (default 24). The worker's `export-sweep` job (every `WORKER_EXPORT_SWEEP_INTERVAL_MS`, default 1 hour) deletes files past retention and marks their records `EXPIRED`, and fails exports still queued or running after 6 hours (a lost job, a dead worker). A TTL index removes export records a week after `expiresAt`. Package builds run `WORKER_EXPORT_CONCURRENCY` at a time (default 1) and need free disk space in `EXPORT_SPOOL_DIR` (default: the OS temporary directory; in production the `export-spool` volume) for the largest package.

## Manual review

`/admin/interviews` lists interviews. Filters are state, campaign, flag, and q (an interview id, a user id or an exact email).

The detail view shows:

- the transcript;
- the evidence of the latest run;
- every score and report revision;
- the AI cost.

**Every detail view is audited** (`interview.review_viewed`), because it shows a candidate's answers.

- **Flag** (`interviews.review`): sets `session.review` to flagged, with the reason, the reviewer and the time, and writes an audit entry.
- **Revise scores** (`interviews.review`, only for `REPORT_READY`). The reviewer sends changed dimensions, each with a score (or null) and a note, plus a reason. In one transaction:
  - **score revision n+1.**
    - Changed dimensions carry `reviewNote`.
    - The overall score is the weighted mean over the stored dimension weights, using the same `aggregate` from scoring-core and the same 50% assessed-weight rule.
    - The band comes from `readinessBand`.
    - Confidence is carried over, because it describes the evidence, which a review doesn't change.
  - **report revision m+1.** It copies the latest content with the new scores and overall, adds `review: {revision, reviewedAt, note}`, and keeps the same candidate visibility. Its PDF is `PENDING`.
  - a `reviewRevisions` record with the from/to revisions and the per-dimension changes.
  - an audit entry with the before and after values.

  After the transaction, the worker renders the new revision's PDF (`reports/<user>/<session>/r<n>.pdf`), using the `evaluation.report_pdf` job. Candidates always see the latest visible revision.

  A concurrent revision loses on the unique `(sessionId, revision)` index and gets `409`.

## Permissions

| Permission          | Roles                    | Grants                                                       |
| ------------------- | ------------------------ | ------------------------------------------------------------ |
| `campaigns.read`    | OPERATIONS, SUPPORT, ALL | List and view campaigns, results grid                        |
| `campaigns.manage`  | OPERATIONS, ALL          | Create, update, status, rotate the link, CSV/package exports |
| `interviews.read`   | OPERATIONS, SUPPORT, ALL | Interview list and review detail (audited)                   |
| `interviews.review` | OPERATIONS, ALL          | Flag, revise scores                                          |
| `orgs.read`         | OPERATIONS, SUPPORT, ALL | Organisations, their members and wallets                     |
| `orgs.manage`       | ALL                      | Create organisations, invite owners, seats, quotas, wallets  |

`ALL` = SUPER_ADMIN. CONTENT and FINANCE admins have no campaign or review access. Candidate tokens never open admin routes.

## Tests (exit criterion)

`campaigns.integration.test.ts` covers the following:

- permissions per role;
- draft invisibility and the invite shown once, with only its hash stored;
- status transitions, with closed as final;
- unknown and malformed tokens;
- every closed reason, with joins refused;
- rotation invalidating the old link;
- idempotent and parallel joins;
- the candidate limit under a parallel race;
- isolation between candidates;
- setup limited to the campaign's modes and languages;
- the campaign consent and proctoring;
- the sponsored budget, then falling back to the candidate's own credits;
- a paused campaign blocking starts;
- the paginated campaign list;
- the results grid: filters, order, pages and totals, and hidden reports;
- CSV streaming, formula neutralisation and export auditing;
- package exports: start (idempotent while running), status, download while ready, expiry, queue failure and auditing;
- flagging, score revision, candidate visibility of the revision, and review-view auditing.

The worker's [`campaign-export.integration.test.ts`](../../apps/worker/src/processors/campaign-export.integration.test.ts) builds a real package from MongoDB into storage and checks the sweep; unit tests cover the ZIP writer, the processor and the results pipeline.

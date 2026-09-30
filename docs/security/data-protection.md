# Data protection and candidate data rights (DPDP Act 2023)

How CareerPilot Interview meets the data-principal rights of India's Digital Personal Data Protection Act, 2023 (and the DPDP Rules, 2025), and where each piece lives in the code. Legal wording is in the public pages; this document is the technical side.

## Rights and where they are implemented

| Right (DPDP Act)            | How                                                                                                                                  |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Information / access (s.11) | `GET /users/me/export` — a JSON download from **Privacy & data** (`/app/privacy`).                                                   |
| Correction (s.12)           | Profile page (name, experience, role, language); sign-in methods can be added.                                                       |
| Erasure (s.12)              | `DELETE /users/me` — lock now, erase after a grace period (below).                                                                   |
| Withdraw consent (s.6(4))   | Recording and observation consents are per interview; recordings can be deleted from the report; the history is on the privacy page. |
| Grievance redressal (s.13)  | `/grievance` page and the Grievance Officer card; contact details from configuration (below). Response within 90 days (DPDP Rules).  |
| Nominate (s.14)             | Described in the Privacy Notice; handled by the Grievance Officer by email (no self-service yet).                                    |

## Data export

`GET /users/me/export` (candidate token; 5 per hour per user; audited as `privacy.data_exported`) returns one document (`DataExportBundle` in `packages/shared-types/src/privacy.ts`):

- account, profile, sign-in identities (the person's own emails/numbers, never secrets), consent records;
- resumes and job descriptions with their extracted text and structured data (not the storage keys);
- interviews, transcripts (question and answer per turn), reports (all revisions), coding attempts and feedback;
- recordings as metadata plus a **signed playback link** (the normal short-lived media link, `MEDIA_LIMITS.playbackTtlSec`), not the media itself;
- proof share links (hint and expiry only; tokens are stored as hashes), campaign applications (with the organisation name), purchases, the credit ledger and balance.

Removed at every depth: password, MFA, token, OTP and IP hashes, storage keys and version keys (`exportable()` in `apps/api/src/modules/users/privacy.service.ts`).

## Account deletion

1. **Request** — `DELETE /users/me` needs fresh proof of the person: a code sent to their own verified email or mobile (`POST /users/me/reauth/otp`, purpose `REAUTH`, bound to the signed-in user) or typing `DELETE` when no code can be delivered. Staff accounts are refused (remove admin roles first).
2. **Lock** — status becomes `DELETION_PENDING` with `deletion.scheduledFor = now + ACCOUNT_DELETION_GRACE_DAYS` (default 7). Every refresh family is revoked and `tokenVersion` bumped, so every device is signed out at once. Audited as `privacy.deletion_requested`.
3. **Cancel** — signing in again on the candidate app before `scheduledFor` restores the account (`privacy.deletion_cancelled`). Admin sign-in never cancels it.
4. **Erase** — the worker's `account-erasure` job (every `WORKER_ACCOUNT_ERASURE_INTERVAL_MS`, default hourly) calls `eraseAccount()` in `packages/db/src/erasure.ts` for each account past its date:
   - storage objects first (resume and JD files, report PDFs, recording segments and manifests); a storage failure aborts that account and it is retried on the next run;
   - then records: resumes, job targets, interview sessions, turns (transcripts), evidence, scores, reports, feedback, coding attempts, integrity observations, media assets, review revisions, campaign applications, identity captures (photos first), organisations' notes and scorecards about the person, the campaign invites they joined through, proof share links, readiness certificates (and their PDFs), plan checklist ticks, goals and nudge state, badges, auth identities, refresh tokens, OTP challenges and the profile. Immutable evaluation collections are deleted through the driver, the one lawful exception to their append-only rule;
   - analytics events lose their user id;
   - the user document becomes a **tombstone** (status `DELETED`, no email, mobile, password, MFA or roles) so retained records keep a valid reference;
   - audited as `privacy.account_erased` (ids and counts only).

### Retained after erasure

| Data                                            | Why                                                   | Form                                                       |
| ----------------------------------------------- | ----------------------------------------------------- | ---------------------------------------------------------- |
| Purchases, payments, coupon redemptions, ledger | Income-tax and GST record keeping (typically 8 years) | Pseudonymised: reference only the tombstone id; no contact |
| Consent records                                 | Proof of consent (DPDP Act s.6(10))                   | Pseudonymised as above                                     |
| Audit log                                       | Security and accountability; append-only              | Actor ids and keyed IP hashes only; no contact details     |

## Campaign data shared with an employer or college

A candidate who applies through a campaign link agrees (per campaign, `CAMPAIGN_SHARING` consent) that the organisation's reviewers see that campaign's interviews and reports. For campaigns run by CodeBegun admins this happens inside the admin console. Organisations on the org portal see it themselves (below).

- On erasure, the campaign application, its sessions and reports are deleted, so they disappear from the organisation's results.
- Anything the organisation copied out of the platform before that (notes, screenshots, CSV exports, its own ATS through webhooks or the API) is held by the organisation as its own Data Fiduciary under its own policies; the Privacy Notice and Grievance page say so. Contracts with campaign organisations should require them to honour erasure requests the Grievance Officer forwards.

### Organisations (org portal)

Employers and colleges with their own portal accounts ([org portal](../architecture/org-portal.md)) act on candidates' data directly. The platform limits what they get:

- **Consent gate.** Results, candidate pages, CSV exports, cohort analytics, webhooks and API-key reads include **only applications whose interview has an accepted `CAMPAIGN_SHARING` consent**. A candidate who has joined but not agreed yet is invisible to the organisation (the organisation sees only the invite it sent itself).
- **Employer view.** Each campaign states what reviewers see: scores only, or the report and transcript as well. Candidates are told on the landing page before joining (en, hi, te) and the API enforces it.
- **Tenant isolation.** Every org query is filtered by the member's organisation; other organisations' ids answer 404. Integration tests cover each endpoint.
- **Accountability.** Viewing a candidate, viewing identity photos, exports (with row counts), API reads, stage changes, notes and scorecards are audited with the organisation id. Note texts are not copied into the audit log.
- **Exports** are CSV only (UTF-8, formula-neutralised), streamed; organisations cannot build report packages.
- **Identity capture** (optional per campaign) needs its own required `IDENTITY_CAPTURE` consent. Photos are kept for the recording retention, deleted by the worker after it, and never matched automatically ([why](../architecture/org-portal.md#identity-check)). Candidates are asked to cover numbers they need not show (Aadhaar).
- **Invites** hold the email address, name and cohort tags the organisation supplied; the invite token is stored encrypted (for reminders) and hashed (for lookups).
- **Webhook delivery logs** keep the event body for 30 days (TTL index) for retries and the log; they contain the candidate's name, email and scores for `campaign.candidate_completed`, which the candidate agreed to share with that organisation.

On erasure (below), the person's identity photos and records, the organisation's notes and scorecards about them, and the invites they joined through are deleted too.

## Retention

| Data                        | Default                                         | Setting                        |
| --------------------------- | ----------------------------------------------- | ------------------------------ |
| Video/audio recordings      | 90 days, then deleted by the media sweep        | `MEDIA_RETENTION_DAYS_DEFAULT` |
| Identity-capture photos     | as recordings (90 days), deleted by the sweep   | `MEDIA_RETENTION_DAYS_DEFAULT` |
| Webhook delivery log        | 30 days (TTL index)                             | —                              |
| Account data and interviews | until the candidate deletes them or the account | —                              |
| Deleted account (grace)     | 7 days, then erased                             | `ACCOUNT_DELETION_GRACE_DAYS`  |
| OTP challenges              | a day after expiry (TTL index)                  | —                              |
| Refresh tokens              | until expiry (TTL index), sessions ≤ 90 d / 7 d | `SESSION_MAX_AGE_*_DAYS`       |

## Legal pages

Public routes on the candidate site: `/terms`, `/privacy-policy`, `/grievance`, `/how-scoring-works`. The texts live in `apps/candidate-web/src/i18n/locales/<lng>/legal.json` (en, hi, te; the locale test checks the three have the same structure and placeholders). They are **drafts pending legal review**.

The pages read `GET /legal` for everything that must not be hard-coded:

| Variable                    | Effect                                                                            |
| --------------------------- | --------------------------------------------------------------------------------- |
| `GRIEVANCE_OFFICER_NAME`    | Grievance Officer's name (Privacy Notice, Grievance page, privacy page)           |
| `GRIEVANCE_OFFICER_EMAIL`   | Their email (validated)                                                           |
| `GRIEVANCE_OFFICER_ADDRESS` | Their postal address                                                              |
| `LEGAL_DRAFT_BANNER`        | `true` (default) shows "Draft — pending legal review"; set `false` after sign-off |
| `LEGAL_LAST_UPDATED`        | `YYYY-MM-DD` shown as "Last updated"                                              |

Retention and grace periods quoted in the texts come from the same endpoint (`MEDIA_RETENTION_DAYS_DEFAULT`, `ACCOUNT_DELETION_GRACE_DAYS`). Until the officer is configured the pages say the details will be published soon; they never show a placeholder person.

## Logs

`packages/config/src/logger.ts` masks `email`, `primaryEmail` (to `a***@domain`), `mobile`, `phone`, `primaryMobile` (to the last 4 digits) and OTP `destination`, and removes `displayName`, `fullName`, `firstName`, `lastName` and `candidateName`, at the top level and one level deep. Request logs contain method, URL, status and request id only.

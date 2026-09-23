# Authentication, sessions and admin access

This describes how sign-in works in CareerPilot Interview (Phase 1) and the security choices behind it. Code references are relative to the repository root.

## Sign-in methods

| Method               | Candidate app                      | Admin app                          | Provider                                      |
| -------------------- | ---------------------------------- | ---------------------------------- | --------------------------------------------- |
| Email one-time code  | ✔                                  | ✔ (existing admins only)           | AWS SES in production; SMTP (Mailpit) locally |
| Mobile one-time code | ✔ when `SMS_PROVIDER` ≠ `disabled` | ✔ if the admin has a linked mobile | MSG91 Flow API (DLT template required)        |
| Google               | ✔ when `GOOGLE_CLIENT_ID` is set   | ✔ (existing admins only)           | Google Identity Services ID token             |

There are no passwords. Signing in with a new email/mobile/Google account on the candidate app creates the account. **Admin accounts are never created by signing in**: a super admin invites them, and the first super admin is created with the seed CLI (see [local development](../deployment/local-development.md#admin-access)).

## One-time codes (OTP)

- 6 digits from `crypto.randomInt`. Stored only as `HMAC-SHA256(OTP_HMAC_SECRET, challengeId:code)`; the code never touches the database or logs.
- Expires after `OTP_TTL_SEC` (default 5 min); at most `OTP_MAX_ATTEMPTS` (default 5) guesses per code, counted atomically _before_ the comparison; single use.
- Per destination: `OTP_RESEND_COOLDOWN_SEC` (30 s) between sends and `OTP_MAX_PER_DESTINATION_PER_HOUR` (5). Keys are HMACs of the destination, not the address itself.
- Per IP (Redis-backed, shared across API replicas): 10 requests / 15 min and 15 verifications / min.
- **No account enumeration on the admin app:** a code request for an address that is not an active admin returns the same response and creates a challenge that can never verify, and no message is sent.
- If the email/SMS provider fails, the API returns `503 PROVIDER_UNAVAILABLE`, voids the challenge and releases the cooldown so the person can retry at once. It never claims a code was sent when it was not.

## Sessions

|                   | Access token                                   | Refresh token                                                                                                                     |
| ----------------- | ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Format            | HS256 JWT (`sub`, `aud`, `sid`, `tv`, `roles`) | 256-bit random, opaque                                                                                                            |
| Lifetime          | `JWT_ACCESS_TTL_SEC` (10 min)                  | candidate `REFRESH_TTL_CANDIDATE_DAYS` (30 d), admin `REFRESH_TTL_ADMIN_HOURS` (12 h), sliding                                    |
| Stored by browser | JavaScript memory only (never `localStorage`)  | httpOnly cookie, `SameSite=Lax`, `Secure` + `__Secure-` prefix outside dev, path-scoped to `/api/v1/auth` or `/api/v1/admin/auth` |
| Stored by server  | not stored                                     | SHA-256 hash in `refreshTokens` (TTL-indexed)                                                                                     |

- **Audience separation:** candidate and admin sessions use different JWT audiences, cookie names and cookie paths. A candidate token is rejected by admin endpoints and vice versa.
- **Rotation:** every refresh atomically marks the presented token used and issues a new one in the same _family_ (one family per signed-in device).
- **Replay detection:** presenting an already-used refresh token more than 10 s after it was rotated revokes the whole family and is audited (`auth.refresh_token_reuse_detected`). Within the 10 s grace window (two tabs, a lost response) the request is rejected without revoking. The web apps also serialize refreshes across tabs with the Web Locks API.
- **Logout** revokes the device's family. **Logout-all** revokes every family and increments the user's `tokenVersion`, which invalidates live access tokens immediately.
- **Live checks:** every authenticated request checks the user's current `tokenVersion`, status and (for admins) roles through a 60 s Redis read-through cache that is invalidated on every change. Role changes, revocations and suspensions therefore apply to live sessions immediately. If Redis is down the check falls back to MongoDB.

## CSRF and CORS

- The only cookie-authenticated endpoints are `refresh`, `logout` (and `logout-all`, which also needs a Bearer token). They require the header `X-CB-CSRF: 1`. Browsers only send custom headers from JavaScript, which triggers a CORS preflight.
- The API rejects any request whose `Origin` is not in `CORS_ALLOWED_ORIGINS` with `403 ORIGIN_NOT_ALLOWED` (not merely omitting CORS headers). Staging/production refuse non-HTTPS origins.
- All other endpoints authenticate with the `Authorization: Bearer` header, which cross-site requests cannot set.

## Account linking and duplicates

- An identity (`EMAIL`, `MOBILE`, `GOOGLE` + normalized subject) is unique and belongs to exactly one user.
- Email is lower-cased; mobile numbers are normalized to E.164 (Indian numbers without `+91` are accepted).
- Google sign-in with a verified email that matches an existing account **links** to that account instead of creating a duplicate. Google tokens are verified against Google's JWKS, issuer, audience (our client id), expiry and `email_verified`.
- Signed-in candidates can add another email/mobile (via OTP) or Google account. Adding one that belongs to someone else fails with `409 IDENTITY_IN_USE`; accounts are never merged silently.
- Account creation and linking run in MongoDB transactions with a retry on unique-index races.

## Admin roles and permissions

Endpoints check **permissions**, never role names. The matrix lives in [`packages/shared-types/src/permissions.ts`](../../packages/shared-types/src/permissions.ts) and is used by both the API and the admin UI.

| Permission           | Super | Operations | Content | Support | Finance |
| -------------------- | ----- | ---------- | ------- | ------- | ------- |
| `admin_users.read`   | ✔     | ✔          |         |         |         |
| `admin_users.manage` | ✔     |            |         |         |         |
| `audit.read`         | ✔     | ✔          |         |         | ✔       |
| `candidates.read`    | ✔     | ✔          |         | ✔       |         |
| `ai.read`            | ✔     | ✔          |         |         |         |
| `ai.manage`          | ✔     |            |         |         |         |
| `ai_usage.read`      | ✔     | ✔          |         |         | ✔       |
| `prompts.read`       | ✔     | ✔          | ✔       |         |         |
| `prompts.manage`     | ✔     |            | ✔       |         |         |

The AI permissions (Phase 2) are described in [the AI provider layer](../ai/provider-layer.md#admin-console-and-permissions). Only super admins can see or change provider keys and routing.

Safeguards: admins cannot demote or revoke themselves; the platform keeps at least one active super admin; revoking admin access ends admin sessions but leaves the person's candidate account intact. The admin UI hides sections without permission, and the API enforces it independently.

## Audit log

`auditLogs` is append-only. The Mongoose model rejects every update and delete operation. Entries record the actor, action, target, outcome, request id and a keyed hash of the IP (never the raw IP), plus minimal details (never codes, tokens or full contact details). Admin mutations write their audit entry inside the same transaction, so a change cannot happen unaudited. Security events outside a transaction (login, OTP failures) log an error and continue if the audit write fails, so an audit outage cannot lock everyone out.

Recorded actions so far: `auth.otp_requested`, `auth.otp_verify_failed`, `auth.account_created`, `auth.login_succeeded`, `auth.logout`, `auth.logout_all`, `auth.identity_linked`, `auth.refresh_token_reuse_detected`, `admin.user_invited`, `admin.user_roles_changed`, `admin.user_access_revoked`, `admin.super_admin_seeded`.

## Secrets

| Secret                       | Purpose                                        | Rules                                                                                        |
| ---------------------------- | ---------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `JWT_ACCESS_SECRET`          | Signs access tokens                            | ≥ 32 chars; must differ from `OTP_HMAC_SECRET`; example values refused in staging/production |
| `OTP_HMAC_SECRET`            | OTP hashes, pseudonymous IP/destination hashes | same                                                                                         |
| `SES_*`, `SMTP_*`, `MSG91_*` | Delivery providers                             | only in server env; never logged                                                             |

Rotating `JWT_ACCESS_SECRET` signs everyone out of their current access token (they silently refresh). Rotating `OTP_HMAC_SECRET` invalidates outstanding codes only.

## Known limitations / follow-ups

- Legal/consent text (terms, privacy) acceptance is not captured yet; it arrives with the consent module and needs legal review (DPDP Act).
- Transactional emails are English-only; localized templates come with the notifications module.
- Account suspension is possible at the data layer (and enforced everywhere) but has no admin UI yet; it belongs to the Candidates module.
- Unlinking a sign-in method is not offered yet.

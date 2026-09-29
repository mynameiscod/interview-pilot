# Authentication, sessions and admin access

This describes how sign-in works in CareerPilot Interview (Phase 1) and the security choices behind it. Code references are relative to the repository root.

## Sign-in methods

| Method               | Candidate app                      | Admin app                          | Provider                                      |
| -------------------- | ---------------------------------- | ---------------------------------- | --------------------------------------------- |
| Email one-time code  | ✔                                  | ✔ (existing admins only)           | AWS SES in production; SMTP (Mailpit) locally |
| Mobile one-time code | ✔ when `SMS_PROVIDER` ≠ `disabled` | ✔ if the admin has a linked mobile | MSG91 Flow API (DLT template required)        |
| Google               | ✔ when `GOOGLE_CLIENT_ID` is set   | ✔ (existing admins only)           | Google Identity Services ID token             |

Candidates have no passwords (admins may also set one on their account page). Signing in with a new email/mobile/Google account on the candidate app creates the account. **Admin accounts are never created by signing in**: a super admin invites them, and the first super admin is created with the seed CLI (see [local development](../deployment/local-development.md#admin-access)).

## One-time codes (OTP)

- 6 digits from `crypto.randomInt`. Stored only as `HMAC-SHA256(OTP_HMAC_SECRET, challengeId:code)`; the code never touches the database or logs.
- Expires after `OTP_TTL_SEC` (default 5 min); at most `OTP_MAX_ATTEMPTS` (default 5) guesses per code, counted atomically _before_ the comparison; single use.
- The code email (and dev-mailbox SMS) is sent in English, Hindi or Telugu: the request's optional `lang` (the web apps send the current UI locale), else the first supported `Accept-Language` entry, else English. Production SMS via MSG91 uses the fixed DLT template, so its wording is set in that template.
- Per destination: `OTP_RESEND_COOLDOWN_SEC` (30 s) between sends and `OTP_MAX_PER_DESTINATION_PER_HOUR` (5). Keys are HMACs of the destination, not the address itself.
- Per IP (Redis-backed, shared across API replicas): 10 requests / 15 min and 15 verifications / min.
- **No account enumeration on the admin app:** a code request for an address that is not an active admin returns the same response and creates a challenge that can never verify, and no message is sent.
- If the email/SMS provider fails, the API returns `503 PROVIDER_UNAVAILABLE`, voids the challenge and releases the cooldown so the person can retry at once. It never claims a code was sent when it was not.

## Sessions

|                   | Access token                                   | Refresh token                                                                                                                     |
| ----------------- | ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Format            | HS256 JWT (`sub`, `aud`, `sid`, `tv`, `roles`) | 256-bit random, opaque                                                                                                            |
| Lifetime          | `JWT_ACCESS_TTL_SEC` (10 min)                  | candidate `REFRESH_TTL_CANDIDATE_DAYS` (30 d), admin `REFRESH_TTL_ADMIN_HOURS` (12 h), sliding, capped by the absolute lifetime   |
| Stored by browser | JavaScript memory only (never `localStorage`)  | httpOnly cookie, `SameSite=Lax`, `Secure` + `__Secure-` prefix outside dev, path-scoped to `/api/v1/auth` or `/api/v1/admin/auth` |
| Stored by server  | not stored                                     | SHA-256 hash in `refreshTokens` (TTL-indexed)                                                                                     |

- **Audience separation:** candidate and admin sessions use different JWT audiences, cookie names and cookie paths. A candidate token is rejected by admin endpoints and vice versa.
- **Rotation:** every refresh atomically marks the presented token used and issues a new one in the same _family_ (one family per signed-in device).
- **Replay detection:** presenting an already-used refresh token more than 10 s after it was rotated revokes the whole family and is audited (`auth.refresh_token_reuse_detected`). Within the 10 s grace window (two tabs, a lost response) the request is rejected without revoking. The web apps also serialize refreshes across tabs with the Web Locks API.
- **Absolute lifetime:** every token in a family carries `familyCreatedAt` (the sign-in). Rotation slides the expiry by the refresh TTL but never past `familyCreatedAt + SESSION_MAX_AGE_CANDIDATE_DAYS` (90 d) or `SESSION_MAX_AGE_ADMIN_DAYS` (7 d), so an active refresh chain (stolen or not) still ends. Families created before this change start their cap at their next refresh.
- **Signed-in devices:** `GET /auth/sessions` and `/admin/auth/sessions` list the person's families (browser, sign-in time, last refresh, end); `DELETE …/sessions/:id` revokes one (`auth.session_revoked`). The revoked device can no longer refresh, and its current access token is refused at once (revoked-session check, below). Shown on the candidate profile page and the admin account page.
- **Cross-tab sign-out:** the web apps' session manager posts sign-out and sign-in on a `BroadcastChannel` per app. Signing out in one tab signs every tab out at once (instead of each keeping its in-memory access token for up to 10 minutes); a signed-out tab picks up a sign-in made in another. The candidate app also clears the interview wizard's `sessionStorage` (it can hold pasted job descriptions) and its query cache on sign-out.
- **Refresh rate limits:** `/refresh` has its own limits, separate from the sign-in limit: 600/min per IP (campus and office NATs put hundreds of students behind one address) and 20/min per session (keyed by a hash of the refresh cookie), so one runaway tab cannot starve its neighbours. Google and password sign-in keep the stricter 30/min per IP.
- **Logout** revokes the device's family. **Logout-all** revokes every family and increments the user's `tokenVersion`, which invalidates live access tokens immediately.
- **Revoked-session check:** every family revocation (device sign-out, logout, reuse detection, suspension, logout-all, audience-wide revocations) also writes `cbi:revoked-session:<familyId>` to Redis with a TTL of `JWT_ACCESS_TTL_SEC` + 60 s. `authenticate` and the Socket.IO handshake refuse an access token whose session id (`sid`, the family id) is listed, so a signed-out device loses access immediately rather than when its token expires. After the TTL the token has expired anyway. If Redis is unreachable the check is skipped (logged) and the previous behaviour applies: the token lapses within `JWT_ACCESS_TTL_SEC`.
- **Live checks:** every authenticated request checks the user's current `tokenVersion`, status and (for admins) roles through a 60 s Redis read-through cache that is invalidated on every change. Role changes, revocations and suspensions therefore apply to live sessions immediately. If Redis is down the check falls back to MongoDB.

## Admin two-factor authentication (TOTP)

- Authenticator apps (RFC 6238: HMAC-SHA1, 30 s steps, 6 digits), implemented on `node:crypto` in [`packages/auth-core/src/totp.ts`](../../packages/auth-core/src/totp.ts) and tested against the RFC vectors.
- **Required** for `SUPER_ADMIN` by default; `ADMIN_MFA_REQUIRED=all` requires it for every admin. Others can turn it on from **Your account**.
- **Enforced after every first factor** (password, email/SMS code, Google): instead of a session the API answers `{ mfaRequired: true, mfaToken, mode }`. The token is random, single-use, lives 5 minutes in Redis (keyed by its SHA-256) and allows 5 wrong codes. `POST /admin/auth/mfa/verify` exchanges it for the session. No refresh cookie is set before the second factor.
- **Enrolment at sign-in:** when 2FA is required but not set up, the challenge is `ENROLL` and carries a fresh secret and `otpauth://` URI (shown as a QR code drawn client-side as SVG with the `qrcode` package, so the secret never leaves the browser, plus the copyable setup key and the URI as fallbacks). The first valid code turns it on. Admins can also set it up, replace recovery codes or (when not required) turn it off on the account page, each confirmed with a current code.
- **Storage:** the secret is encrypted with the platform secret box (AES-256-GCM under `AI_SECRETS_MASTER_KEY`, bound to `adminMfa:<userId>`) in `users.mfa`, which is never selected by default. Ten recovery codes are shown once and stored as HMACs (`OTP_HMAC_SECRET`); each is removed when used.
- **Replay:** the last accepted time step is stored and a code for the same or an earlier step is refused (a conditional update makes concurrent replays lose). ±1 step of clock drift is accepted.
- Audited: `auth.mfa_challenged`, `auth.mfa_failed`, `auth.mfa_enabled`, `auth.mfa_recovery_code_used`, `auth.mfa_recovery_codes_regenerated`, `auth.mfa_disabled`.
- Lost phone and recovery codes: an operator removes the admin's `mfa` field on the server (there is no self-service bypass); the next sign-in asks them to enrol again.

## Account suspension

Admins with `candidates.manage` suspend or reinstate candidate accounts from **Candidates** (`POST /admin/candidates/:id/suspend|reinstate`, reason required). Suspension sets `status: SUSPENDED`, records who and why, and revokes every refresh family and bumps `tokenVersion` in one transaction, so the candidate is signed out everywhere at once and sign-in is refused (`ACCOUNT_SUSPENDED`). Both actions, every search (`candidate.searched`) and every opened profile (`candidate.viewed`) are audited.

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
| `candidates.manage`  | ✔     | ✔          |         |         |         |
| `ai.read`            | ✔     | ✔          |         |         |         |
| `ai.manage`          | ✔     |            |         |         |         |
| `ai_usage.read`      | ✔     | ✔          |         |         | ✔       |
| `prompts.read`       | ✔     | ✔          | ✔       |         |         |
| `prompts.manage`     | ✔     |            | ✔       |         |         |
| `library.read`       | ✔     | ✔          | ✔       |         |         |
| `library.manage`     | ✔     | ✔          | ✔       |         |         |
| `interviews.manage`  | ✔     | ✔          |         |         |         |

The AI permissions (Phase 2) are described in [the AI provider layer](../ai/provider-layer.md#admin-console-and-permissions). The library permissions (Phase 3: roles, blueprints, companies, templates) are described in [inputs and role analysis](../architecture/inputs-and-role-analysis.md#admin-permissions). Only super admins can see or change provider keys and routing.

Safeguards: admins cannot demote or revoke themselves; the platform keeps at least one active super admin; revoking admin access ends admin sessions but leaves the person's candidate account intact. The admin UI hides sections without permission, and the API enforces it independently.

## Audit log

`auditLogs` is append-only. The Mongoose model rejects every update and delete operation. Entries record the actor, action, target, outcome, request id and a keyed hash of the IP (never the raw IP), plus minimal details (never codes, tokens or full contact details). Admin mutations write their audit entry inside the same transaction, so a change cannot happen unaudited. Security events outside a transaction (login, OTP failures) log an error and continue if the audit write fails, so an audit outage cannot lock everyone out.

Recorded actions so far: `auth.otp_requested`, `auth.otp_verify_failed`, `auth.account_created`, `auth.login_succeeded`, `auth.logout`, `auth.logout_all`, `auth.session_revoked`, `auth.identity_linked`, `auth.refresh_token_reuse_detected`, the `auth.mfa_*` actions above, `admin.user_invited`, `admin.user_roles_changed`, `admin.user_access_revoked`, `admin.super_admin_seeded`, `candidate.searched`, `candidate.viewed`, `candidate.suspended`, `candidate.reinstated`, and the data-rights actions in [data protection](data-protection.md). Sign-outs from the admin app are recorded with actor type `ADMIN`.

## Secrets

| Secret                       | Purpose                                        | Rules                                                                                        |
| ---------------------------- | ---------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `JWT_ACCESS_SECRET`          | Signs access tokens                            | ≥ 32 chars; must differ from `OTP_HMAC_SECRET`; example values refused in staging/production |
| `OTP_HMAC_SECRET`            | OTP hashes, pseudonymous IP/destination hashes | same; also keys admin recovery-code hashes                                                   |
| `AI_SECRETS_MASTER_KEY`      | Also encrypts admin TOTP secrets               | rotate as in the key-rotation runbook (old keys stay for decryption)                         |
| `SES_*`, `SMTP_*`, `MSG91_*` | Delivery providers                             | only in server env; never logged                                                             |

Rotating `JWT_ACCESS_SECRET` signs everyone out of their current access token (they silently refresh). Rotating `OTP_HMAC_SECRET` invalidates outstanding codes only.

## Known limitations / follow-ups

- The Terms of Use and Privacy Notice are drafts pending legal review (the banner shows until `LEGAL_DRAFT_BANNER=false`). Agreement is by the "By continuing, you agree…" notice on the sign-in page, not a recorded consent.
- Transactional emails are English-only; localized templates come with the notifications module.
- Signing out a single device invalidates its current access token through the Redis revoked-session list; while Redis is down that check is skipped and the token lapses within `JWT_ACCESS_TTL_SEC`. Suspension and logout-all also bump `tokenVersion` (checked against MongoDB).
- Admins have TOTP as a second factor; WebAuthn/passkeys are not offered yet.
- Unlinking a sign-in method is not offered yet.

# Security review (Phase 12, pre-launch)

- **Scope:** API, worker, candidate and admin sites, deployment configuration.
- **Date:** 2026-09-24.
- **Method:** code and configuration review against the design's security requirements; dependency audit; the automated tests (unit, integration, e2e with axe); the load test; and the local deployment rehearsal (NGINX, TLS, headers, blue/green, backups).

Each finding is marked **fixed**, **accepted** (with the reason) or **open** (must be done before launch or in a named phase).

## Findings from this phase

| #   | Area              | Finding                                                                                                                                                                              | Status                                                                                                                                                                                                                                                                                                           |
| --- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S1  | Dependencies      | `pnpm audit --prod`: DOMPurify ≤ 3.4.12 (2 moderate, 2 low sanitizer bypasses), pulled in by Monaco.                                                                                 | **Fixed.** A pnpm override pins `dompurify >=3.4.13 <4` (3.4.16 installed). The audit now reports no known vulnerabilities.                                                                                                                                                                                      |
| S2  | Rate limiting     | Behind NGINX, `TRUST_PROXY_HOPS=0` makes every client share the proxy's address, so per-IP limits (sign-in codes included) apply to everyone at once. The load test reproduced this. | **Fixed.** Environment validation refuses `TRUST_PROXY_HOPS=0` in staging and production. NGINX overwrites `X-Forwarded-For` rather than appending to it, so clients can't spoof the address the API trusts.                                                                                                     |
| S3  | Rate limiting     | Many candidates on one campus or office NAT share an address. They share the API's broad public limit (300 requests per minute per IP) and the sign-in code limits.                  | **Accepted for launch**, with monitoring. NGINX's level-1 limits are deliberately generous. Before a large on-site campaign, raise the public limit or key it by user after authentication (planned follow-up). 429s are visible in the logs, and the maintenance and settings tools don't depend on this limit. |
| S4  | CI                | `ci.yml` ran on pushes to `main`, but the default branch is `master`, so pushes to master were not checked.                                                                          | **Fixed.** CI runs on `master`, on release tags (`v*.*.*`, used by the deploy gate) and manually.                                                                                                                                                                                                                |
| S5  | Sign-in redirect  | Sign-in and onboarding dropped `?next=`: a race between the "already signed in" guard and navigation. The e2e suite found it.                                                        | **Fixed** in both sites. The guard continues to `next`, which `safeNextPath` limits to same-site relative paths, so it can't be used as an open redirect.                                                                                                                                                        |
| S6  | Accessibility     | axe found two serious issues: outline and secondary buttons at 3.29:1 contrast, and scrollable tables that couldn't be reached by keyboard.                                          | **Fixed.** A derived accent shade (5.3:1) is used for secondary buttons, and the scroll regions are focusable and labelled. axe runs in e2e on the landing, sign-in, pricing, report and admin dashboard pages.                                                                                                  |
| S7  | CSP               | The Monaco code editor was not exercised under the production CSP (`script-src 'self'`, `worker-src 'self' blob:`). The e2e suite runs the sites without NGINX.                      | **Open (staging).** Open a coding round on staging with the production headers and check the browser console for CSP violations before launch.                                                                                                                                                                   |
| S8  | TLS               | Let's Encrypt stopped publishing OCSP URLs in 2025, so `ssl_stapling` is ignored.                                                                                                    | **Accepted.** This is expected; the other TLS settings are modern (see `infrastructure/nginx/snippets/tls.conf`).                                                                                                                                                                                                |
| S9  | Admin sign-in     | Admins sign in with an email OTP (short access tokens, 12-hour refresh, audited). There is no second factor or hardware key.                                                         | **Accepted for launch.** The admin site is noindex and has a strict CSP, and the admin audience can't be used with candidate tokens. Add TOTP or WebAuthn for SUPER_ADMIN as a post-launch hardening item, or restrict the admin host by IP at NGINX (the staging pattern already does this).                    |
| S10 | Consent and legal | Consent texts are placeholders pending legal review (DPDP Act 2023).                                                                                                                 | **Open (launch blocker)** in the launch checklist.                                                                                                                                                                                                                                                               |

## Controls confirmed

### Authentication and sessions

- HS256 access tokens that last 10 minutes by default. Candidate and admin tokens use separate audiences.
- Refresh tokens are httpOnly `__Secure-` cookies with `SameSite=Lax`, scoped to the auth paths. They rotate on every use with replay detection.
- Logout-all and suspension take effect through `tokenVersion`, using a user-state cache that is invalidated on change.
- Every call to a cookie endpoint needs the CSRF header.
- OTP codes are HMAC-hashed and limited per destination, per IP and per attempt.

### Authorisation

- Endpoints check fine-grained permissions (never role names).
- Candidates' resources are scoped by `userId`: foreign ids return 404, with no enumeration.
- Campaign, review and ops authorisation are covered by integration tests (Phases 10 and 11).

### Input handling

- Every body, query and parameter is validated with Zod, and JSON bodies are limited to 1 MB.
- Uploads are sniffed by content (not extension), with size, page and zip-bomb limits.
- JD URL fetching is guarded against SSRF (private ranges, redirects, DNS rebinding).
- CSV exports neutralise formula cells.
- Analytics accept only allow-listed events: route patterns, no personal data, no IP.

### Secrets

- Environment validation refuses development secrets and every mock provider (AI, payments, judge, SMS mailbox) in staging and production. It also refuses Swagger in production and non-HTTPS CORS origins.
- AI provider keys are encrypted with AES-256-GCM under a master key and rotatable.
- The judge is called with HMAC signatures, and candidate code never runs on the API or worker hosts.
- The Razorpay webhook signature is checked against the raw body, and processing is idempotent.

### Data protection

- Audit logs are append-only, and every admin mutation is audited.
- Admin views of recordings, interview reviews and exports are audited.
- Recording playback URLs are signed and short-lived.
- Retention sweeps delete old recordings, and analytics events expire through a TTL.
- Campaign invite, proof link and media tokens are stored only as hashes.

### Transport and headers

The NGINX layer provides:

- HTTPS only, with HSTS (2 years on production, 1 day on staging);
- a CSP per site, `frame-ancestors 'none'`, a Permissions-Policy, nosniff and a strict referrer policy;
- noindex on admin, API, staging and `/proof/`;
- staging protected by basic auth and an IP allowlist.

The API adds helmet headers and an origin guard.

### Infrastructure

- MongoDB and Redis have no host ports and no egress. MongoDB uses authentication and a keyfile; Redis uses a password.
- Containers run as non-root with read-only root filesystems, `cap_drop: ALL` and `no-new-privileges`.
- The host has ufw (22, 80 and 443 only), fail2ban, SSH keys only and unattended upgrades.
- Backups are encrypted with `age`, kept off the host, and the restore drill verifies them against a manifest. See [docs/deployment/](../deployment/production.md).

## Re-run before each release

- `corepack pnpm audit --prod` must be clean, or every finding has a documented acceptance.
- CI must be green: unit, integration, e2e (desktop Chrome, mobile Chrome, WebKit, including axe), build and the Docker images.
- The monthly restore drill must have passed within the last 30 days.
- The staging load test must meet its targets ([docs/performance/load-test.md](../performance/load-test.md)).

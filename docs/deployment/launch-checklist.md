# Launch checklist (staging → production gate)

Every item needs an owner and evidence (a link, screenshot or command output) before the first production deploy is approved in GitHub. Items marked **BLOCKER** stop the launch.

## Engineering quality

- [ ] **BLOCKER** CI is green on the release commit: format, lint, typecheck, unit, integration (Mongo replica set + Redis), boot smoke, and the Docker builds for all 4 images. The Deploy workflow's `ci-gate` enforces this.
- [ ] **BLOCKER** Playwright end-to-end suite passes (mock providers) on the release commit.
- [ ] **BLOCKER** Load test (`tests/load/`, k6) has been run against staging at the target of 200 concurrent interviews. p95 latencies, error rate and resource use are recorded and within targets. VPS sizing is confirmed or adjusted (compose limits, `WORKER_REPLICAS`, `MONGODB_MAX_POOL_SIZE`).
- [ ] **BLOCKER** Security review signed off: auth/OTP, admin RBAC, uploads and URL fetching, payment verification, CSP and headers (`curl -sI` on all three hosts), dependency audit, container hardening (non-root, read-only filesystem, no Mongo/Redis ports).
- [ ] Staging has run the release candidate for at least 48 hours with no unresolved errors in the logs.

## Data safety

- [ ] **BLOCKER** Nightly backups are enabled on production (`systemctl list-timers cbi-backup.timer`). One manual run succeeded, and the archive and manifest are visible in the Bunny backup zone.
- [ ] **BLOCKER** A restore drill has passed against a real backup (staging, then production once live), and the evidence is recorded ([runbook-backup-restore.md](runbook-backup-restore.md)).
- [ ] The age identity is stored in the password manager, plus an offline copy that two people can reach. It is not on the production server.
- [ ] Backup failure alerts reach a person (`BACKUP_ALERT_URL`), and so do restore-drill failures.

## Legal and content

- [ ] **BLOCKER** Legal review of all consent texts (terms, privacy, recording/media consent, marketing), the DPDP Act notices, retention periods (`MEDIA_RETENTION_DAYS_DEFAULT`) and the refund policy. Approved versions are published in Admin → Consent texts.
- [ ] **BLOCKER** Brand assets: every item in [docs/product/brand-assets-required.md](../product/brand-assets-required.md) is supplied and `pnpm brand:check` passes. This is a known release blocker: no official logo files are in the repository yet.
- [ ] Support contact, grievance officer and company details are shown where the law requires them.

## Providers and keys (production values, never staging ones)

- [ ] **BLOCKER** No `REPLACE_WITH_*` values remain (`deploy.sh` refuses otherwise). Every secret was generated for production: nothing reused from staging, and no example values.
- [ ] **BLOCKER** Real AI provider keys are entered in Admin → AI providers. Every route has a fallback on a different provider. Provider health shows `HEALTHY` after a test interview. `AI_MOCK_MODE=false` (enforced).
- [ ] **BLOCKER** Razorpay **live** keys (`rzp_live_…`) are set. The live webhook points at `https://api.interview.codebegun.com/api/v1/payments/webhooks/razorpay` with the events `payment.captured`, `order.paid`, `payment.failed`, `refund.processed` and `refund.failed`, and the secret matches. Auto-capture is on. A ₹1 live purchase has been made and refunded end to end.
- [ ] Email: SES production access (out of the sandbox), SPF/DKIM/DMARC for the sending domain, and a sign-in code received at Gmail and Outlook addresses.
- [ ] SMS: MSG91 DLT template approved and a mobile OTP received, or `SMS_PROVIDER=disabled` as a conscious decision.
- [ ] Bunny: the private uploads zone (not publicly readable) and a separate backup zone in another region.
- [ ] Judge: separate judge host with the HMAC-verifying proxy, reachable from the API; a coding round passes a sample problem.
- [ ] Google sign-in: production OAuth client with the authorized origins `https://interview.codebegun.com` and `https://admin.interview.codebegun.com`, if enabled.

## Infrastructure

- [ ] **BLOCKER** DNS for all three hostnames points at production. TLS is valid (Let's Encrypt production CA, not `--test-cert`), HSTS is present, and HTTP redirects to HTTPS.
- [ ] Host provisioned with `provision.sh`: SSH keys only, root login off, ufw 22/80/443, fail2ban active (`fail2ban-client status`), unattended-upgrades on, swap present, and a disk alert test (`sudo cbi-disk-alert --threshold 1` logs a warning).
- [ ] GitHub environment **production** has required reviewers and environment-scoped secrets, and `SSH_KNOWN_HOSTS` was verified out of band.
- [ ] A rollback was rehearsed on staging (`rollback.sh --yes`, then roll forward again) with no failed requests.
- [ ] Monitoring and alerts:
  - an external uptime check on `https://api.interview.codebegun.com/healthz` and both sites
  - an alert on `status.sh --json` degraded (cron or monitoring agent)
  - disk alerts routed to a person
  - certificate expiry monitored
  - the Razorpay webhook failure email goes to ops

## Application readiness

- [ ] **BLOCKER** The first SUPER_ADMIN is seeded ([production.md §3.7](production.md#37-seed-the-first-super-admin)) and can sign in. The other admins are invited with least-privilege roles.
- [ ] Plans and prices, coupons, the interview library, the problem bank and feature flags are reviewed in Admin (the seeded defaults are placeholders). Analytics targets are set in System → Settings.
- [ ] `API_DOCS_ENABLED=false` in production (enforced).
- [ ] **BLOCKER** Maintenance mode is **off** (Admin → System → Settings), and `GET /api/v1/system/status` reports no maintenance.
- [ ] The smoke checks from [production.md §3.8](production.md#38-smoke-checks) pass on production.
- [ ] The on-call rota and the runbooks ([deploy/rollback](runbook-deploy-rollback.md), [incidents](runbook-incidents.md), [backup/restore](runbook-backup-restore.md), [key rotation](runbook-key-rotation.md)) have been read by everyone on call.

**Sign-off:** engineering lead ☐ · security ☐ · product ☐ · legal ☐ · date: \_\_\_\_\_\_

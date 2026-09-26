# Production deployment

How CareerPilot Interview runs on a VPS, and how to set up a new staging or production host from scratch. Day-2 operations are in the runbooks:

- [Deploy and rollback](runbook-deploy-rollback.md)
- [Backup and restore](runbook-backup-restore.md) (including the restore drill)
- [Incidents](runbook-incidents.md)
- [Key rotation](runbook-key-rotation.md)
- [Launch checklist](launch-checklist.md) (the staging → production gate)

Design background: [design proposal §14](../architecture/00-mvp-design-proposal.md#14-deployment-architecture), decision D3 (self-hosted single-node MongoDB replica set) and §19 (secrets).

## 1. Architecture

One environment per VPS: staging and production are separate hosts with separate databases.

```text
                 Internet (80/443 only; ufw + fail2ban)
                               │
                ┌──────────────▼───────────────┐  edge network
                │ nginx (nginx-unprivileged)    │  TLS, HTTP/2, HSTS, CSP, gzip,
                │  - candidate SPA (static)     │  rate limit L1, request ids,
                │  - admin SPA (static)         │  staging access control
                │  - api.* → upstream cbi_api   │
                └──────┬────────────────┬──────┘
          upstream-api.conf (blue/green switch)
                ┌──────▼─────┐   ┌──────▼─────┐        certbot (renewals, webroot)
                │ api-blue   │   │ api-green  │ ◄── only one colour takes traffic
                └──────┬─────┘   └──────┬─────┘
                       │  worker ×N (BullMQ)  │   edge network also gives api/worker
                ───────┴───────────┬──────────┴── outbound internet (AI, Razorpay,
                                   │                Bunny, SES, MSG91, judge)
                ┌──────────────────▼──────────────────┐  internal network
                │ mongo 8 (rs0, auth + keyfile)  redis 8 (password, AOF, noeviction) │
                └─────────────────────────────────────┘  internal: true — no egress,
                                                          no host ports
```

| Service                  | Image                                     | Notes                                                                                                                                    |
| ------------------------ | ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `nginx`                  | `nginxinc/nginx-unprivileged:1.29-alpine` | Only service with host ports (80→8080, 443→8443). Serves both SPAs from `/srv/cbi/www`, proxies the API. Config: `infrastructure/nginx`. |
| `api-blue` / `api-green` | `ghcr.io/<org>/<repo>/api:<tag>`          | Express + Socket.IO. `SHUTDOWN_GRACE_MS=60000`; Docker stop timeout 75 s.                                                                |
| `worker` (×2 by default) | `ghcr.io/<org>/<repo>/worker:<tag>`       | BullMQ processors. `SHUTDOWN_GRACE_MS=120000` (finishes the active job); stop timeout 135 s.                                             |
| `mongo`                  | `mongo:8.0`                               | Single-node replica set `rs0` (transactions), `--auth` + keyfile. No host port.                                                          |
| `mongo-init`             | `mongo:8.0`                               | One-shot, idempotent: initiates `rs0`, creates/updates the app and backup users (`infrastructure/mongo/init-replica-set.js`).            |
| `redis`                  | `redis:8-alpine`                          | Password, AOF `everysec` + RDB, `maxmemory 2gb`, `maxmemory-policy noeviction` (BullMQ). No host port.                                   |
| `certbot`                | `certbot/certbot`                         | `certbot renew --webroot` every 12 h; NGINX reloads itself every 6 h to pick up new certificates.                                        |

The web images (`candidate-web`, `admin-web`) are not run as containers. On each deploy `deploy.sh` copies their static files into `/srv/cbi/www/<app>/releases/<tag>` and switches the `current` symlink. The previous release stays as `previous`, and NGINX falls back to it for hashed assets, so a browser still running the old `index.html` can lazy-load its chunks after a deploy. Web images are built once per environment because `VITE_API_URL` is baked into the bundle: `candidate-web:<tag>` is for production and `candidate-web:<tag>-staging` is for staging.

**Hardening in the compose file:** every service has `no-new-privileges` and `cap_drop: ALL` (mongo and certbot add back only the capabilities they need). The api, worker, nginx and redis containers run as non-root users; mongod drops to uid 999 after installing the keyfile, and certbot runs as root. Every service except certbot has a read-only root filesystem, with tmpfs for `/tmp`. All services have healthchecks, `restart: unless-stopped` and json-file log rotation (20 MB × 5), plus CPU/memory limits and raised `nofile` ulimits.

**Hostnames** (change them in `infrastructure/nginx/sites/*.conf`, `hostnames_for` in `infrastructure/scripts/lib/common.sh`, `.github/workflows/deploy.yml` and the env file if the domains differ):

| Environment | Candidate                         | Admin                                   | API                                   |
| ----------- | --------------------------------- | --------------------------------------- | ------------------------------------- |
| production  | `interview.codebegun.com`         | `admin.interview.codebegun.com`         | `api.interview.codebegun.com`         |
| staging     | `interview-staging.codebegun.com` | `admin.interview-staging.codebegun.com` | `api.interview-staging.codebegun.com` |

### NGINX behaviour

- **TLS:** one Let's Encrypt SAN certificate (`/etc/letsencrypt/live/cbi`) per host, TLS 1.2/1.3 with Mozilla "intermediate" ECDHE ciphers and HTTP/2. HSTS is 2 years on production (`includeSubDomains`) and 1 day on staging. Unknown hostnames get `444` on port 80 and a rejected TLS handshake on 443. OCSP stapling is configured, but Let's Encrypt stopped publishing OCSP URLs in 2025, so NGINX logs `"ssl_stapling" ignored` for LE certificates. This is expected (`deploy.sh` filters the warning).
- **SPAs:** `/assets/*` gets `Cache-Control: public, max-age=31536000, immutable`, `index.html` and client routes get `no-cache`, and `/brand/*` returns 404 when a file is missing. Dotfiles and `.map` files are never served.
- **API:** `/socket.io/` supports WebSocket upgrade (120 s read timeout; long-polling fallback made sticky with `ip_hash`). Body limits: 2 MB by default and 12 MB on the upload routes (resumes 8 MB, media segments 8 MB, voice clips 10 MB, plus multipart overhead). The app enforces the exact limits. `/healthz` is public and `/readyz` is internal only. The Razorpay webhook route has its own location.
- **Request ids:** a well-formed incoming `X-Request-Id` is kept (else NGINX generates one), forwarded to the API, returned on static responses and written to NGINX's JSON access log. The API logs and returns the same id.
- **Security headers:** each site gets its own CSP. The candidate site allows Razorpay Checkout (script `checkout.razorpay.com`, frames `api.razorpay.com` + `checkout.razorpay.com`), Google Identity Services, `connect-src` to the API origin including `wss://`, and `blob:` media for recordings. The admin site gets a stricter one (`default-src 'none'`, no payment frames, camera/microphone denied). All sites also send `X-Frame-Options: DENY`, `nosniff`, `Referrer-Policy` and `Permissions-Policy`. `X-Robots-Tag: noindex, nofollow` goes on the admin host, the API host, every staging host and `/proof/` pages.
- **Staging access:** the SPAs require an IP from `/srv/cbi/nginx/staging-allowlist.conf` or HTTP basic auth (`/srv/cbi/nginx/htpasswd`). The API allows allowlisted IPs only, because browsers don't send basic-auth credentials on cross-origin calls. `/healthz` and the Razorpay webhook are exempt.
- **Level-1 rate limits:** 30 r/s per IP (burst 60) on the API, and 5 r/s (burst 20) on upload routes. The limits are generous because many candidates can share one campus NAT; the API applies finer limits in Redis.

### Sizing (Hostinger KVM 8: 8 vCPU / 32 GB)

| Service     | CPU limit | Memory limit | Notes                                               |
| ----------- | --------- | ------------ | --------------------------------------------------- |
| api (×1)    | 3         | 4 GB         | both colours run for about a minute during a deploy |
| worker (×2) | 2 each    | 3 GB each    | `WORKER_REPLICAS` in the state file                 |
| mongo       | 3         | 10 GB        | WiredTiger cache 6 GB (`MONGO_WT_CACHE_GB`)         |
| redis       | 1         | 3 GB         | `maxmemory 2gb`                                     |
| nginx       | 2         | 1 GB         | 16k connections per worker process                  |

Steady-state limits add up to about 24 GB, which leaves headroom for the page cache and a second API colour during deploys. The design assumes 200 concurrent interviews, which is I/O-bound because AI runs externally. Confirm the numbers with the k6 results in `tests/load/` before launch.

## 2. Host layout (`/srv/cbi`)

```text
/srv/cbi/
  app/                         docker-compose.production.yml + infrastructure/ (rsynced by CI)
  .env.production|.env.staging API + worker env    (root:deploy 0640; template infrastructure/env/production.env.example)
  .env.datastores              Mongo/Redis secrets (root:deploy 0640; template datastores.env.example)
  .env.backup                  backup settings     (root:deploy 0640; template backup.env.example)
  secrets/mongo-keyfile        replica-set keyfile (0400)
  state/                       deploy.state (tags, colour), compose.env, history.log, deploy.lock
  nginx/                       upstream-api.conf (blue/green), staging-allowlist.conf, htpasswd
  www/<app>/releases/<tag>/    SPA files; current -> releases/<tag>, previous -> releases/<old>
  letsencrypt/  certbot-www/   certificates, ACME webroot
  backup/age-recipients.txt    age public key(s) for backups
```

The env files are root-owned but readable by the `deploy` group, because `docker compose` reads `env_file` client-side and CI deploys as `deploy`. Members of the `docker` group are effectively root on the host, so only the CI key and operators get that account.

## 3. First-time setup

### 3.1 Provision the VPS (Ubuntu 24.04)

From your machine, with a fresh root SSH login:

```bash
scp -r docker-compose.production.yml infrastructure root@VPS:/root/cbi/
ssh root@VPS 'bash /root/cbi/infrastructure/scripts/provision.sh --env production \
  --ssh-key-file /root/.ssh/authorized_keys --admin-user ops --alert-email ops@codebegun.com'
```

`provision.sh` is idempotent. It does the following:

- upgrades packages and sets the time zone to UTC with chrony
- creates `deploy` (docker group) and optionally `ops` (sudo), both key-only
- sets sshd to no passwords and no root login
- sets ufw to allow only 22 (rate-limited), 80 and 443
- configures fail2ban: an sshd jail, plus an NGINX rate-limit jail that bans in the `DOCKER-USER` chain, because ports published by Docker bypass ufw
- turns on unattended security upgrades, with Docker packages held and no automatic reboot
- installs Docker Engine and the compose plugin from Docker's apt repository, with `daemon.json` set for log rotation, `live-restore` and `no-new-privileges`
- adds swap, and sysctl/ulimit tuning for many sockets (`somaxconn` 65535, `nofile` 1M, `vm.overcommit_memory=1` for Redis)
- creates the `/srv/cbi` layout, generates the Mongo keyfile and copies the env templates
- installs the disk alert (every 15 min, 80 % threshold) and the backup/drill systemd units

Open a **new** SSH session as `ops` before closing the root session, to confirm key login works.

### 3.2 DNS

Create A (and AAAA if used) records for the three hostnames pointing at the VPS. Keep the TTL low (300 s) until launch.

### 3.3 Secrets and configuration

As `ops` (`sudo -e`):

1. `/srv/cbi/.env.datastores`: generate every password with `openssl rand -hex 32`.
2. `/srv/cbi/.env.production`: fill in every `REPLACE_WITH_*` value. `deploy.sh` refuses to run while any remain. What's left in the file:
   - `MONGODB_URI` and `REDIS_URL`, using the passwords from step 1;
   - `JWT_ACCESS_SECRET` and `OTP_HMAC_SECRET` (`openssl rand -base64 48`, different values);
   - a new `AI_SECRETS_MASTER_KEY` (`openssl rand -base64 32`);
   - the Google client id (optional).

   **Provider credentials are set in the admin site, not in this file.** Email (SES or SMTP), SMS (MSG91), storage (Bunny), payments (Razorpay) and the code judge are configured after the first deploy in **System → Integrations** (SUPER_ADMIN). There they are encrypted with `AI_SECRETS_MASTER_KEY`, applied to every process without a restart, and can be tested and rotated. The template leaves these providers as `disabled`/`none`, and until they're set up the features they power answer "not set up yet". You can still configure a provider in this file; an admin configuration overrides it.

   Razorpay webhook URL: `https://api.interview.codebegun.com/api/v1/payments/webhooks/razorpay`.

   **Order matters for the first super admin:** they sign in with an email code, so configure **Email** before anyone can sign in, using the bootstrap script in §3.7. Everything else is configured in the admin site.

3. `/srv/cbi/.env.backup` and `/srv/cbi/backup/age-recipients.txt`. See [runbook-backup-restore.md](runbook-backup-restore.md#1-one-time-setup).
4. Staging only: `sudo htpasswd -cB /srv/cbi/nginx/htpasswd <user>`, then add office/VPN networks to `/srv/cbi/nginx/staging-allowlist.conf`, one `<cidr> 1;` per line.

### 3.4 TLS certificate

Before the first deploy, NGINX isn't running yet, so certbot uses its standalone server on port 80:

```bash
sudo -iu deploy
/srv/cbi/app/infrastructure/scripts/certs.sh issue --env production --email ops@codebegun.com
# rehearsal first? add --test-cert (Let's Encrypt staging CA), then re-issue without it
```

After that, renewals run automatically (certbot service every 12 h, NGINX reload every 6 h).

### 3.5 GitHub Actions

1. Create the environments **staging** and **production** (Settings → Environments). Give production **required reviewers** and restrict it to tags `v*`.
2. Add these secrets to each environment:
   - `SSH_HOST`
   - `SSH_USER` (`deploy`)
   - `SSH_PRIVATE_KEY`: a dedicated ed25519 key whose public half is in `deploy`'s `authorized_keys`
   - `SSH_KNOWN_HOSTS`: `ssh-keyscan -t ed25519 <host>`, verified out of band
   - optionally `GHCR_PULL_TOKEN`, a PAT with `read:packages`. Without it the workflow token is used, and it expires after the job, so later manual pulls fall back to images already on the host.
   - staging only: `STAGING_BASIC_AUTH` (`user:password`)
3. Optional repository variables: `VITE_GOOGLE_CLIENT_ID_STAGING` and `VITE_GOOGLE_CLIENT_ID`.
4. Protect the default branch (`master`) so the CI workflow must pass. The deploy workflow's `ci-gate` job also refuses a commit without a successful CI run. **Note:** `ci.yml` currently runs on pushes to `main` only, so it must also trigger on `master`. Otherwise tagged `master` commits have no CI run and the gate fails.

### 3.6 First deploy

Normally you push a tag: `git tag v1.0.0 && git push origin v1.0.0`. The workflow builds the images, deploys to staging and runs health checks, waits for approval, then deploys to production. To deploy by hand on the server:

```bash
sudo -iu deploy
echo "$GHCR_PAT" | docker login ghcr.io -u <github-user> --password-stdin
/srv/cbi/app/infrastructure/scripts/deploy.sh v1.0.0 --env production --registry ghcr.io/<org>/<repo>
/srv/cbi/app/infrastructure/scripts/status.sh
```

On first start the API creates indexes and seeds the catalogues (interview library, plans, consent texts, problem bank, feature flags and settings). Every step is idempotent, so no separate migration job exists.

### 3.7 Seed the first super admin

Admins can't self-register. Use the seed script compiled into the API image, which is idempotent:

```bash
cd /srv/cbi/app && ACTIVE=$(grep ^ACTIVE_COLOR= /srv/cbi/state/deploy.state | cut -d= -f2)
docker compose -f docker-compose.production.yml --env-file /srv/cbi/state/compose.env \
  exec "api-$ACTIVE" node dist/scripts/seed-super-admin.js --email ops@codebegun.com
```

Then configure **email** from the server shell, so the sign-in code can be delivered. The script reads JSON on stdin, so secrets never land in shell history. It stores the configuration exactly as the admin site does (encrypted, audited, applied at once):

```bash
cat > /tmp/email.json   # paste, then Ctrl+D:
{ "provider": "smtp",
  "settings": { "from": "CareerPilot Interview <no-reply@codebegun.com>",
                "smtpHost": "smtp.example.com", "smtpPort": 587, "smtpUser": "apikey" },
  "secrets":  { "smtpPass": "…" } }
docker compose -f docker-compose.production.yml --env-file /srv/cbi/state/compose.env \
  exec -T "api-$ACTIVE" node dist/scripts/configure-integration.js email < /tmp/email.json
shred -u /tmp/email.json
```

For Amazon SES use `"provider": "ses"` with `sesRegion` in settings, and `sesAccessKeyId` and `sesSecretAccessKey` in secrets.

That person signs in at `https://admin.interview.codebegun.com` with an email OTP and invites the other admins from **Admins**. In **System → Integrations** they test email, then set up storage, payments, SMS and the judge. The seed is audited as `admin.super_admin_seeded`.

### 3.8 Smoke checks

```bash
curl -fsS https://api.interview.codebegun.com/healthz          # {"status":"ok",...,"version":"v1.0.0"}
curl -sI https://interview.codebegun.com/ | grep -iE 'strict-transport|content-security'
curl -s -o /dev/null -w '%{http_code}\n' https://api.interview.codebegun.com/readyz   # 404 (internal only)
/srv/cbi/app/infrastructure/scripts/status.sh                  # STATUS: OK
```

Then, in a browser:

1. Sign in on both sites.
2. Run the device check and one practice interview.
3. Make a ₹1 test purchase on staging (Razorpay test keys), and confirm the webhook arrives (Admin → Purchases).
4. Check Admin → System → Health, Queues and AI provider health.
5. Enable backups: `sudo systemctl enable --now cbi-backup.timer`, run one backup by hand, and run a restore drill ([runbook](runbook-backup-restore.md)).

Finish with the [launch checklist](launch-checklist.md).

## 4. Local rehearsal (no VPS needed)

Everything above was rehearsed on Docker Desktop during Phase 12. The rehearsal used a Linux harness container (bash, docker CLI, age), the production compose file with a small override for local ports, self-signed certificates and locally built images. It covered:

- `deploy.sh` first deploy
- a blue→green swap, with 380 requests during the swap and none failed
- `rollback.sh`, with 185 SPA+API request pairs and none failed
- NGINX headers, caching, gzip, staging gating, body limits, and the WebSocket upgrade (101) through NGINX
- `status.sh` and the seed script
- the backup → restore drill

To repeat it, point `CBI_HOME` at a scratch directory, set `COMPOSE_OVERRIDE_FILE` to an override that publishes `127.0.0.1:18080/18443`, and run the scripts with `--registry <local name> --skip-pull`.

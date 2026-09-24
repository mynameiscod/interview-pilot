# Runbook: incidents

First steps for any incident:

```bash
ssh ops@<host>
/srv/cbi/app/infrastructure/scripts/status.sh
cd /srv/cbi/app && DC="sudo -u deploy docker compose -f docker-compose.production.yml --env-file /srv/cbi/state/compose.env"
$DC ps
$DC logs --since 15m api-blue api-green worker nginx | tail -300
```

Every API log line and NGINX access-log line carries the `X-Request-Id`. Ask users for the id shown on error screens, or search for it: `$DC logs --since 1h api-green | grep <id>`. **Admin → System → Health** shows Mongo/Redis status, queue counts, worker heartbeats and the maintenance flag.

**Maintenance mode** (Admin → System → Settings → Maintenance, `system.manage`) makes new interview starts and campaign joins answer `503 MAINTENANCE` with your message. Running interviews continue. It reaches every API process within 15 seconds, and the web apps show the banner within 30 seconds. Use it whenever an incident would ruin interviews that are starting.

---

## API down or erroring

**Signals:** `https://api…/healthz` fails; NGINX returns 502/504; the sites load but every call fails.

1. Run `status.sh` and check the active colour's health.
2. If the container is restarting, run `$DC logs --tail 100 api-<colour>`:
   - **`Invalid environment configuration`** means a bad `.env` edit. Fix it and redeploy the current tag.
   - A **Mongo/Redis connection error** points to the data stores: see the Mongo and Redis sections below.
   - An **out-of-memory kill** shows `OOMKilled: true` in `docker inspect api-<colour>`. Check the memory limit and any traffic spike. Scale out by deploying again, or raise the limit in the compose file.
3. **After a deploy:** roll back (`rollback.sh --yes`). It takes about a minute and has no downtime.
4. **Upstream error only** (the container is healthy but NGINX shows 502): check that `nginx/upstream-api.conf` names the running colour. Fix it, then `$DC exec nginx nginx -s reload`.
5. **NGINX itself is down:** `$DC up -d --no-deps nginx`. If it fails `nginx -t`, the error names the file.

## Worker stuck or queues backing up

**Signals:** reports stay "evaluating"; documents stay "parsing"; Admin → System → Health shows waiting counts growing; worker heartbeats are stale.

1. Admin → System → **Queues** shows the failed jobs per queue with the first 500 characters of each error.
   - If the jobs failed on a transient cause (AI outage, network), fix the cause and press **Retry** for each job (`queues.manage`; every retry is audited).
   - For a code bug, fix it, deploy, then retry.
2. Check the worker containers: `$DC ps worker` and `$DC logs --tail 200 worker`.
   - If the workers are unhealthy or restarting, see the API section above: same causes.
   - If they are healthy but not consuming, check Redis (next section).
   - If they are stuck on a job (the log shows a long-running job), restart with `$DC restart worker`. SIGTERM gives each job up to 120 s to finish; BullMQ marks stalled jobs and retries them.
3. **Backlog but healthy:** add capacity with `$DC up -d --no-deps --scale worker=4 worker`. Watch the Redis memory and the AI provider rate limits. Set `WORKER_REPLICAS` in `state/deploy.state` so the next deploy keeps the new count.
4. **Analytics are stale:** the rollup runs every 15 minutes. Admin → Analytics can recompute a date range.

## MongoDB down

**Signals:** `/readyz` shows `mongo: down`; APIs return 503/500; `status.sh` shows mongo unhealthy.

1. Run `$DC logs --tail 200 mongo`. Common causes:
   - **Disk full:** see the disk section.
   - **Keyfile permission error:** the `mongo-keyfile` must exist at `/srv/cbi/secrets/`. The container copies it with the correct owner.
   - **WiredTiger cache or OOM:** lower `MONGO_WT_CACHE_GB` or raise the container limit.
2. Restart with `$DC up -d --no-deps mongo`, then `$DC run --rm --no-deps -T mongo-init`, which is idempotent. It also re-initiates the replica set if its config was lost.
3. **Replica set has no primary** (`NotWritablePrimary` in the API logs): run `$DC exec mongo mongosh -u root -p --authenticationDatabase admin --eval 'rs.status()'`. The member host must be `mongo:27017`.
4. **Data corrupted or lost:** go to [runbook-backup-restore.md §4](runbook-backup-restore.md#4-disaster-recovery-restore-into-the-live-stack).

While Mongo is down, the API can't take new interviews. Turn on maintenance mode once it is back, if you need time to verify.

## Redis down

**Signals:** `/readyz` shows `redis: down`; realtime is broken; queues stop.

What still works: sign-in and access checks fall back to MongoDB, and AI coordination fails open (see [provider-layer.md](../ai/provider-layer.md)). What stops: queues (no new evaluations or parses), Socket.IO fan-out across processes, rate limits (the payment limiter fails closed) and OTP issuance, because codes live in Redis.

1. Run `$DC logs --tail 200 redis`.
   - `OOM command not allowed` means `maxmemory` was reached with `noeviction`, which is on purpose so BullMQ loses nothing. Find the big keys (`$DC exec redis sh -c 'REDISCLI_AUTH=$REDIS_PASSWORD redis-cli --bigkeys'`). Usually a queue has built up because workers are down, so fix the workers. If needed, raise `maxmemory` in `infrastructure/redis/redis.conf` and the container limit.
   - If the AOF is corrupted after a crash: `$DC run --rm --no-deps --entrypoint redis-check-aof redis --fix /data/appendonlydir/appendonly.aof.*.incr.aof`.
2. Restart with `$DC up -d --no-deps redis`. BullMQ and Socket.IO reconnect on their own. Clients rejoin live interviews and state rehydrates from Mongo.

## Disk full

**Signals:** the disk alert (journald `cbi-disk-alert`, webhook or email at 80 %); Mongo/Redis write errors.

```bash
df -h / /var/lib/docker; sudo du -xh --max-depth=2 /var/lib/docker | sort -h | tail
docker system df
```

1. Old images: `docker image prune -a --filter until=720h` (keeps recent ones, including the rollback tag).
2. Old SPA releases: `deploy.sh` keeps 5, and older ones can go from `/srv/cbi/www/*/releases`.
3. Logs are capped (20 MB × 5 per container). Check `journalctl --disk-usage`, and `sudo journalctl --vacuum-size=500M`.
4. Temporary files from backups live in `/tmp` and are removed on exit. Check `ls /tmp/cbi-*`.
5. If the database is the problem, it needs a bigger disk. Resize the VPS disk, then check TTL-based cleanup (media retention, analytics events).

## AI provider outage

**Signals:** interviews stall on "thinking"; evaluations fail; Admin → AI → **Provider health** shows `DEGRADED` or `DOWN` (5-minute windows, updated every minute).

1. Each feature has a **fallback chain** (Admin → AI → Routes). The router skips models whose circuit is open (5 failures in 60 s open it for 30 s), then tries the next model. Check that every route has at least one model from a **different provider**. If not, add one (for example Anthropic ↔ OpenAI ↔ Gemini) and save; the change reaches all processes within `AI_CONFIG_CACHE_TTL_SEC` or immediately via Redis.
2. If a provider is fully down, disable its models (Admin → AI → Models) so calls stop waiting on its timeouts.
3. If failures are auth errors after a key change, re-enter the key (Admin → AI providers → Providers & keys, `ai.manage`).
4. Failed evaluation jobs can be retried from **System → Queues** once a provider works again.
5. If there is no working fallback, turn on maintenance mode so new interviews don't start.

Voice STT/TTS (Deepgram/ElevenLabs) outages degrade to text mode per [voice.md](../architecture/voice.md). Tell candidates.

## Payment webhook failures

**Signals:** "I paid but have no credits"; Razorpay dashboard → Webhooks shows failures; purchases stuck in `CREATED`.

1. Nothing is lost: the worker's **reconciliation job** (`WORKER_PAYMENT_RECONCILE_INTERVAL_MS`, hourly) asks Razorpay about unconfirmed purchases and pending refunds and applies the result exactly once.
2. **Single user:** Admin → Purchases, search by email, order id or payment id, then **Reconcile**. It is audited and idempotent.
3. **All webhooks failing:**
   - `Invalid webhook signature` in the API logs means `RAZORPAY_WEBHOOK_SECRET` doesn't match the dashboard. See [key rotation](runbook-key-rotation.md#razorpay).
   - 403/404 from NGINX means the webhook URL is wrong. It must be `https://api…/api/v1/payments/webhooks/razorpay`. On staging it is exempt from the IP allowlist.
   - 5xx means the API is unhealthy: see the API section.
4. Razorpay retries failed webhooks for 24 hours. Once fixed, check Admin → Purchases for `CREATED` purchases older than one hour.

## TLS certificate problems

**Signals:** browser certificate errors; expiry emails from Let's Encrypt.

Run `certs.sh show` and `$DC logs --tail 50 certbot`. Force a renewal with `certs.sh renew`. Renewal needs port 80 open (ufw) and `/.well-known/acme-challenge/` served, which the HTTP server block does.

## Security incident (suspected compromise)

1. Contain: turn on maintenance mode. If the host is compromised, take it off the network through the provider console.
2. Rotate everything in [runbook-key-rotation.md](runbook-key-rotation.md), starting with `JWT_ACCESS_SECRET`, which signs everyone out of their access tokens.
3. Revoke admin sessions: Admin → Admins → revoke access, which bumps `tokenVersion`.
4. Preserve evidence: `auditLogs` in Mongo, NGINX/API logs (`docker logs`) and `journalctl`.
5. Follow the DPDP Act breach-notification obligations with legal.

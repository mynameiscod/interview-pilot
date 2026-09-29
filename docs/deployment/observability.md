# Observability: errors, metrics, alerts

What CareerPilot Interview reports about itself in staging and production, how to collect it and which alerts to set up. Logs are covered in [runbook-incidents.md](runbook-incidents.md) (JSON lines from NGINX, the API and the workers, with shared request ids).

| Signal                   | Source                                                                              | Off by default?                       |
| ------------------------ | ----------------------------------------------------------------------------------- | ------------------------------------- |
| Server errors            | Sentry SDK in the API and the worker → Sentry or GlitchTip                          | yes (`SENTRY_DSN`)                    |
| Browser errors           | Sentry SDK in both SPAs, loaded on demand                                           | yes (`VITE_SENTRY_DSN` at build time) |
| Application metrics      | Prometheus `/metrics` on the API (`:4000`) and each worker (`:4100`)                | no (`METRICS_ENABLED=true`)           |
| Backup freshness         | `backup.sh` textfile metrics in `/srv/cbi/state/metrics/`                           | no                                    |
| Host (disk, CPU, memory) | node_exporter (not shipped; install from the distribution) + `cbi-disk-alert` timer | —                                     |
| Public availability, TLS | Uptime Kuma (`uptime-kuma` compose profile) or blackbox_exporter                    | yes                                   |

## Error tracking (Sentry / GlitchTip)

Both SDKs speak the Sentry protocol, so either a Sentry project or a self-hosted [GlitchTip](https://glitchtip.com) instance works. Create one project for the backend and one for the web apps (or one per app) and copy the DSNs.

**API and worker** (`packages/config/src/error-tracking.ts`), set in `/srv/cbi/.env.<env>`:

| Variable             | Meaning                                                                                                              |
| -------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `SENTRY_DSN`         | Project DSN. Empty = off; nothing else changes.                                                                      |
| `SENTRY_ENVIRONMENT` | Defaults to `APP_ENV` (`staging` / `production`).                                                                    |
| `SENTRY_RELEASE`     | Set by the image: the git sha of the commit (`GIT_SHA` build argument in `deploy.yml`). Falls back to `APP_VERSION`. |

What is reported:

- **API:** every response that ends as an unexpected `500 INTERNAL_ERROR`, tagged with the method and the route pattern (never the concrete URL) and the request id, so the event can be matched to logs. Expected outcomes are not reported: 4xx, `AI_UNAVAILABLE`, `JUDGE_UNAVAILABLE`, `NOT_CONFIGURED` (metrics cover those).
- **Worker:** a BullMQ job whose **last** attempt fails, tagged with the queue and job name, with the job id and attempt count. Earlier attempts are retried and only counted (`cbi_queue_jobs_failed_total`).
- **Both:** unhandled promise rejections (`kind=unhandledRejection`), start-up failures (`kind=startup`) and uncaught exceptions. Queued events are flushed on graceful shutdown.

**Web apps** (`packages/web-core/src/error-tracking.ts`): set the repository variables `VITE_SENTRY_DSN_STAGING` / `VITE_SENTRY_DSN` (GitHub → Settings → Variables); `deploy.yml` passes them to the web image build together with the commit sha as `VITE_SENTRY_RELEASE`. Without a DSN the SDK is not even downloaded (it is a lazily loaded chunk). Uncaught errors and unhandled rejections are reported, tagged `app=candidate|admin`. A DSN is public by design; it only allows sending events.

### Personal data

Error events leave our infrastructure, so they are cleaned on the way out (`packages/shared-types/src/pii.ts`, used by all four processes):

- The SDK's automatic collection is off (`dataCollection`, the SDK 10+ successor of `sendDefaultPii: false`): no IP addresses, cookies, headers, request/response bodies, query strings, user details, local variables, queue payloads or AI prompts.
- `beforeSend` / `beforeBreadcrumb` scrub every remaining string: email addresses, phone numbers (10–15 digits), `Bearer`/`Basic` credentials, JWTs and credential query parameters (`token`, `code`, `otp`, `key`, `signature`, …) become `[Filtered]`. Values under sensitive keys (`authorization`, `cookie`, `password`, `token`, `otp`, `apiKey`, `email`, `phone`, …) are replaced whole. The user is reduced to its opaque id.
- Session replay, tracing and profiling are not enabled.

If an event still shows personal data, add the pattern or key to `pii.ts` (with a test) rather than filtering in the Sentry UI.

### Browser errors and the CSP

The SPAs' Content-Security-Policy only allows `connect-src` to known origins, so the browser SDK needs the DSN host added. `deploy.sh` writes `/srv/cbi/nginx/csp-connect.conf` on every deploy:

- from `CSP_CONNECT_SRC_EXTRA` in `/srv/cbi/.env.<env>` (space-separated `https://host[:port]` origins), or, when that is empty,
- from the origin of `SENTRY_DSN` (e.g. `https://abc@o123.ingest.de.sentry.io/4` → `https://o123.ingest.de.sentry.io`).

Set `CSP_CONNECT_SRC_EXTRA` when the browser DSN is on a different host from the server DSN. The value is validated (https origins only) and appended to `connect-src` of both sites (`$cbi_csp_connect_extra` in `infrastructure/nginx/nginx.conf`). Check after a deploy: `curl -sI https://interview.codebegun.com/ | grep -i content-security` must list the host.

## Metrics (Prometheus)

`GET /metrics` in the Prometheus text format, on:

- the API: `http://api-blue:4000/metrics` and `http://api-green:4000/metrics` (scrape both; only the active colour answers between deploys),
- each worker: `http://<worker container>:4100/metrics`.

These are reachable on the Docker networks only. NGINX answers `404` for `/metrics` on the public API host, and the deploy workflow checks that after every deploy. Set `METRICS_TOKEN` (at least 16 characters, `openssl rand -hex 24`) to also require `Authorization: Bearer <token>`; `METRICS_ENABLED=false` removes the endpoints.

| Metric                                      | Type      | Labels                               | Notes                                                                                                                                                        |
| ------------------------------------------- | --------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `cbi_http_request_duration_seconds`         | histogram | `method`, `route`, `status_code`     | API. `route` is the Express pattern (`/api/v1/interviews/:id`); ids are never labels.                                                                        |
| `cbi_socketio_connections`                  | gauge     |                                      | API. Open Socket.IO connections on this process.                                                                                                             |
| `cbi_queue_jobs`                            | gauge     | `queue`, `state`                     | Worker. `waiting`/`active`/`delayed`/`failed`/`paused`, read from Redis at scrape time. Every replica reports the same numbers: use `max by (queue, state)`. |
| `cbi_queue_jobs_failed_total`               | counter   | `queue`, `job_name`                  | Worker. Every failed attempt (retries included).                                                                                                             |
| `cbi_queue_jobs_completed_total`            | counter   | `queue`, `job_name`                  | Worker.                                                                                                                                                      |
| `cbi_worker_heartbeat_timestamp_seconds`    | gauge     |                                      | Worker. Unix time of the last heartbeat job (every `WORKER_HEARTBEAT_INTERVAL_MS`, 15 s).                                                                    |
| `cbi_ai_call_duration_seconds`              | histogram | `provider`, `feature`, `outcome`     | API + worker. One observation per provider attempt, fed by the AI router's metering sink (`withUsageObserver`).                                              |
| `cbi_ai_call_errors_total`                  | counter   | `provider`, `feature`, `outcome`     | Attempts with an outcome other than `SUCCESS` (`TIMEOUT`, `RATE_LIMITED`, `PROVIDER_ERROR`, …).                                                              |
| `cbi_judge_failures_total`                  | counter   | `provider`, `source`                 | Judge unavailable during `code-run`, `code-submit` or `evaluation`.                                                                                          |
| `cbi_process_*`, `cbi_nodejs_*`             | various   |                                      | Node defaults: CPU, memory, event-loop lag, GC, handles.                                                                                                     |
| `cbi_backup_last_success_timestamp_seconds` | gauge     | `mode` (`full`/`incremental`), `env` | Written by `backup.sh` for node_exporter's textfile collector.                                                                                               |

Every series also carries `service="api"` or `service="worker"`.

### Collecting them

Nothing in the stack stores metrics; run a collector that can reach the Docker network, for example Prometheus (or Grafana Alloy / VictoriaMetrics agent remote-writing to a hosted service) as an extra container attached to `cbi-<env>_edge`:

```yaml
# prometheus.yml (container on the cbi-production_edge network)
global: { scrape_interval: 15s }
rule_files: [/etc/prometheus/prometheus-alerts.yml] # infrastructure/monitoring/prometheus-alerts.yml
scrape_configs:
  - job_name: cbi-api
    authorization: { credentials_file: /etc/prometheus/metrics-token } # when METRICS_TOKEN is set
    static_configs: [{ targets: ['api-blue:4000', 'api-green:4000'] }]
  - job_name: cbi-worker
    authorization: { credentials_file: /etc/prometheus/metrics-token }
    dns_sd_configs: [{ names: ['worker'], type: A, port: 4100 }] # every worker replica
  - job_name: node # node_exporter on the host, with --collector.textfile.directory=/srv/cbi/state/metrics
    static_configs: [{ targets: ['host.docker.internal:9100'] }]
  - job_name: blackbox-tls # blackbox_exporter, module http_2xx, for certificate expiry
    metrics_path: /probe
    params: { module: [http_2xx] }
    static_configs:
      targets:
        [
          'https://interview.codebegun.com/',
          'https://admin.interview.codebegun.com/',
          'https://api.interview.codebegun.com/healthz',
        ]
    relabel_configs:
      - { source_labels: [__address__], target_label: __param_target }
      - { source_labels: [__param_target], target_label: instance }
      - { target_label: __address__, replacement: 'blackbox:9115' }
```

Keep the collector's memory small on a single VPS (a few hundred MB with 15 s scrapes and 15 days retention), or remote-write to a hosted Prometheus/Grafana Cloud free tier.

## Alert rules

Loadable rules: [`infrastructure/monitoring/prometheus-alerts.yml`](../../infrastructure/monitoring/prometheus-alerts.yml). Thresholds are starting points for the MVP load; tune them after a few weeks of real traffic. `page` = wake someone up; `warn` = look during working hours.

| Alert                        | Condition (summary)                                                                     | Severity | First step                                                                      |
| ---------------------------- | --------------------------------------------------------------------------------------- | -------- | ------------------------------------------------------------------------------- |
| `CbiApi5xxRateHigh`          | 5xx responses > 2 % of API traffic for 5 min (and > 0.2 req/s)                          | page     | New issues in error tracking; [incidents runbook](runbook-incidents.md)         |
| `CbiApiLatencyP95High`       | p95 of `cbi_http_request_duration_seconds` > 1.5 s for 10 min (health/metrics excluded) | warn     | Break down by `route`; check Mongo, AI latency                                  |
| `CbiApiDown`                 | no API target up for 2 min                                                              | page     | `status.sh`; failed swap?                                                       |
| `CbiWorkerHeartbeatMissing`  | newest `cbi_worker_heartbeat_timestamp_seconds` older than 90 s, or absent              | page     | `dc ps worker`, worker logs, Redis                                              |
| `CbiQueueStuck`              | a queue has waiting jobs and completed none in 15 min                                   | page     | Admin → System → Queues; worker logs                                            |
| `CbiQueueBacklog`            | > 100 waiting jobs for 15 min                                                           | warn     | Scale `WORKER_REPLICAS` / concurrency                                           |
| `CbiQueueFailuresRising`     | > 10 failed attempts in 15 min on a queue                                               | warn     | Error tracking (final failures), Admin → Queues → failed jobs                   |
| `CbiAiErrorRateHigh`         | > 20 % of a provider/feature's AI calls failing for 10 min                              | warn     | Provider status page; fallback models in Admin → AI                             |
| `CbiAiLatencyHigh`           | p95 of successful AI calls > 30 s for 15 min                                            | warn     | Provider status; switch the feature's primary model                             |
| `CbiJudgeFailing`            | > 3 judge failures in 15 min                                                            | warn     | Judge host health                                                               |
| `CbiDiskFilling`             | < 20 % free on `/`, `/var/lib/docker` or `/srv*` for 10 min                             | warn     | Docker logs/images (`docker system df`), Mongo growth                           |
| `CbiDiskAlmostFull`          | free space predicted to reach 0 within 24 h                                             | page     | As above, now                                                                   |
| `CbiBackupFullStale`         | no successful full backup for 26 h                                                      | page     | `journalctl -u cbi-backup.service`; [backup runbook](runbook-backup-restore.md) |
| `CbiBackupIncrementalStale`  | no successful incremental backup for 2 h (RPO at risk)                                  | page     | `journalctl -u cbi-backup-incremental.service`                                  |
| `CbiCertificateExpiring`     | a public certificate expires in < 14 days (certbot renews at 30)                        | warn     | certbot container logs, `certs.sh`                                              |
| `CbiCertificateExpiringSoon` | < 3 days                                                                                | page     | Renew by hand now                                                               |

Independently of Prometheus, the host keeps its own safety nets: `cbi-disk-alert.timer` (80 % threshold, email/webhook), `BACKUP_ALERT_URL` on every backup or drill failure, and the monthly restore drill.

## Uptime Kuma

A small status monitor that needs no Prometheus. Enable it with the `uptime-kuma` compose profile (it is never started by `deploy.sh`):

```bash
cd /srv/cbi/app && DC="docker compose -f docker-compose.production.yml --env-file /srv/cbi/state/compose.env"
$DC --profile uptime-kuma up -d uptime-kuma
ssh -L 3001:127.0.0.1:3001 ops@<host>    # then open http://localhost:3001 and create the admin user
```

It listens on `127.0.0.1:3001` only; reach it through an SSH tunnel. Suggested monitors (notifications to the on-call channel):

| Monitor                  | Type                | Target                                                                                                                       | Interval / alert |
| ------------------------ | ------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| API liveness             | HTTP(s) keyword     | `https://api.interview.codebegun.com/healthz`, keyword `"status":"ok"`                                                       | 60 s, 2 failures |
| API readiness (internal) | HTTP(s)             | `http://api-blue:4000/readyz` and `http://api-green:4000/readyz` (one is expected down between deploys; use a monitor group) | 60 s             |
| Candidate site           | HTTP(s) keyword     | `https://interview.codebegun.com/`, keyword `/assets/`                                                                       | 60 s             |
| Admin site               | HTTP(s) keyword     | `https://admin.interview.codebegun.com/`, keyword `/assets/`                                                                 | 60 s             |
| Certificate expiry       | (any HTTPS monitor) | enable "Certificate Expiry Notification", 14 and 3 days                                                                      | daily            |

Backup freshness is not an Uptime Kuma check: failures are POSTed to `BACKUP_ALERT_URL`, missed runs show up in the `CbiBackup*Stale` alerts and the monthly drill fails on stale backups.

An instance on the same VPS cannot report that the VPS itself is down: add one external check (Uptime Kuma elsewhere, or a free external monitor) for `https://api.interview.codebegun.com/healthz`.

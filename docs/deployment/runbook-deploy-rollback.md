# Runbook: deploy and rollback

Scripts: `infrastructure/scripts/deploy.sh`, `rollback.sh` and `status.sh`, run on the host as `deploy`. Architecture is in [production.md](production.md).

## Normal release

1. Merge to the default branch (`master`) and wait for **CI** to go green on that commit.
2. Tag the release: `git tag v1.4.0 && git push origin v1.4.0`.
3. The **Deploy** workflow runs these jobs:
   - `ci-gate`: CI must have succeeded on this commit.
   - `build`: pushes to GHCR `api:v1.4.0`, `worker:v1.4.0`, `candidate-web:v1.4.0` and `admin-web:v1.4.0` (production bundles), the `-staging` web bundles, and every image again under `sha-<short>`.
   - `deploy-staging`: rsyncs `docker-compose.production.yml` and `infrastructure/` to `/srv/cbi/app`, runs `deploy.sh v1.4.0 --env staging`, and checks that `/healthz` reports `v1.4.0` and that both sites serve the SPA.
   - `deploy-production`: waits for a reviewer to approve the **production** environment, then runs the same steps.
4. Watch Admin → System → Health and the error rate for 15 minutes.

Other ways to run it:

- Deploy an untagged commit: Actions → Deploy → Run workflow on that branch. The tag defaults to `sha-<short>`.
- By hand on the host: `deploy.sh <tag> --env production --registry ghcr.io/<org>/<repo>`.

## What `deploy.sh` does

| Step          | Detail                                                                                                                                                                                                                   |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Lock + checks | `flock` on `state/deploy.lock`. The state file's environment must match `--env`. Env files must exist with no `REPLACE_WITH_*` left, and a TLS certificate must be present.                                              |
| Pull          | api, worker and both web images. If a pull fails and the image is already on the host, it is used with a warning.                                                                                                        |
| Data stores   | `up --wait mongo redis`, then the `mongo-init` job (replica set + users, idempotent).                                                                                                                                    |
| SPA releases  | Copies `/usr/share/nginx/html` out of the web images into `www/<app>/releases/<tag>`.                                                                                                                                    |
| Idle colour   | `up --force-recreate api-<idle>` with the new tag. On boot the API runs `ensureIndexes` and the catalogue seeds.                                                                                                         |
| Readiness     | `wget http://api-<idle>:4000/readyz` from the NGINX container, plus Docker health = healthy, for up to 240 s. On failure the idle colour is stopped and traffic never moves.                                             |
| Swap          | Rewrites `nginx/upstream-api.conf`, runs `nginx -t` (restoring the old file if it fails), then `nginx -s reload`. In-flight requests finish on the old workers.                                                          |
| SPA switch    | `current` → the new release and `previous` → the old one (atomic `mv -T`). Old hashed assets keep loading.                                                                                                               |
| Drain         | `docker stop -t 75 api-<old>`. The old API stops accepting sockets and closes Socket.IO, so clients reconnect to the new colour and rehydrate from Mongo. It finishes in-flight turns within `SHUTDOWN_GRACE_MS` (60 s). |
| Workers       | `up worker` on the new tag. Each worker gets SIGTERM and finishes its current job (up to 120 s). Queued jobs wait in Redis.                                                                                              |
| State         | `state/deploy.state` gets `CURRENT_TAG`, `PREVIOUS_TAG` and `ACTIVE_COLOR`, and `state/history.log` gets a new line. The newest 5 SPA releases are kept.                                                                 |

**Compatibility rule:** during a deploy the old and new API run side by side for about a minute against the same database, and the old SPA talks to the new API. Database changes must be additive: new fields optional, new indexes, no renames or drops in the same release. Rollback relies on this too.

## Rollback

The previous tag's images are still on the host, so a rollback works even when GHCR is down.

- **From GitHub:** Actions → Deploy → Run workflow with `action=rollback` and the environment (production still needs approval). Leave `tag` empty to use `PREVIOUS_TAG`, or give a tag.
- **On the host:**

  ```bash
  /srv/cbi/app/infrastructure/scripts/rollback.sh --yes              # to PREVIOUS_TAG
  /srv/cbi/app/infrastructure/scripts/rollback.sh --yes --to v1.3.2  # to a specific tag
  ```

`rollback.sh` runs the same blue/green flow, so it has no downtime. A second rollback flips back again, because the tags swap roles. **Database changes are not rolled back.** If a release corrupted data, see [runbook-backup-restore.md](runbook-backup-restore.md#4-disaster-recovery-restore-into-the-live-stack).

## Status and troubleshooting

```bash
/srv/cbi/app/infrastructure/scripts/status.sh         # human-readable; exit 1 when degraded
/srv/cbi/app/infrastructure/scripts/status.sh --json  # for monitoring
cd /srv/cbi/app && DC="docker compose -f docker-compose.production.yml --env-file /srv/cbi/state/compose.env"
$DC ps; $DC logs --tail 200 api-green; $DC logs --tail 200 worker; $DC logs --tail 100 nginx
```

| Symptom                                 | Action                                                                                                                                                                                     |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `did not become ready` (deploy aborted) | Traffic never moved. Read the printed logs. The usual cause is env validation (`Invalid environment configuration: <VAR>: <rule>`) or Mongo/Redis auth. Fix the env file and deploy again. |
| `nginx -t failed`                       | The upstream file was restored and the idle colour stopped. Run `$DC exec nginx nginx -t` to see the error.                                                                                |
| `another deploy is running`             | Wait, or check for a stuck run (`ps aux \| grep deploy.sh`). The lock is released when the process exits.                                                                                  |
| `workers not healthy after 240s`        | The API is already on the new tag. Check `$DC logs worker`. If the worker can't start, roll back.                                                                                          |
| `this host is a staging host`           | You passed the wrong `--env`, which is intended. One environment per host.                                                                                                                 |
| Deploy stuck at pull                    | Check `docker login ghcr.io` on the host, and that the tag was pushed (`sha-…` and `v…` exist in GHCR).                                                                                    |

## Maintenance tasks

- **Scale workers:** set `WORKER_REPLICAS=3` in `state/deploy.state`, then run `deploy.sh <CURRENT_TAG>`. Or run `$DC up -d --no-deps --scale worker=3 worker` (the next deploy returns to the state file value).
- **Restart one service** (config change in `.env.production`): redeploy the current tag, `deploy.sh $(grep ^CURRENT_TAG= /srv/cbi/state/deploy.state | cut -d= -f2)`. This gives the API a zero-downtime restart. Containers read env files only when they are created.
- **Staging allowlist or htpasswd change:** edit the file in `/srv/cbi/nginx/`, then `$DC exec nginx nginx -t && $DC exec nginx nginx -s reload`.
- **Docker or OS upgrades:** do them in a maintenance window. `live-restore` keeps containers running across a Docker daemon restart. Reboot with `sudo reboot`; every service has `restart: unless-stopped` except a colour that was deliberately stopped.
- **Disk:** `docker image prune -a --filter until=720h` removes images older than 30 days. Keep the current and previous tags.

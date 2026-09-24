# Runbook: backup and restore

Scripts: `infrastructure/scripts/backup.sh`, `restore.sh` and `restore-drill.sh`. Units: `infrastructure/systemd/cbi-backup.*` and `cbi-restore-drill.*` (a cron alternative is in `crontab.example`).

| What         | How                                                                                                                                                                               |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Dump         | `mongodump --archive --gzip --oplog` (a point-in-time consistent dump of the whole instance), run inside the `mongo` container as the `cbi_backup` user (built-in `backup` role). |
| Encryption   | `age` to the public key(s) in `/srv/cbi/backup/age-recipients.txt`. The private identity is **not** kept on the production server.                                                |
| Manifest     | Per-collection document and index counts at backup time, encrypted alongside (`*.manifest.json.age`). Restores are checked against it.                                            |
| Off-box copy | Bunny Storage HTTP API (`PUT` with `AccessKey` and a `Checksum` header) to a **separate** zone from app uploads, under `<prefix>/daily/` and `<prefix>/weekly/`.                  |
| Schedule     | Nightly at 20:30 UTC (02:00 IST). The Sunday run also writes a weekly copy.                                                                                                       |
| Retention    | Keeps the 7 newest daily and 4 newest weekly archives (older ones are deleted remotely).                                                                                          |
| Restore test | Monthly (`cbi-restore-drill.timer`, on the 3rd). Downloads the newest archive, restores it into a scratch container with no network, verifies it and removes the container.       |
| Failure      | Any failure exits non-zero, is logged to journald (`journalctl -u cbi-backup`) and is POSTed to `BACKUP_ALERT_URL` when set.                                                      |

Redis is not backed up. It holds queues, caches and locks, and everything important is written to Mongo first (design §2). Its AOF lets queued jobs survive restarts.

## 1. One-time setup

1. **Create the age key pair on an ops machine**, not on the server:

   ```bash
   age-keygen -o cbi-backup-identity.txt      # prints "Public key: age1..."
   ```

   Store `cbi-backup-identity.txt` in the password manager, with an offline copy (two people must be able to reach it). Put the public key (`age1…`) on the server:

   ```bash
   echo 'age1...' | sudo tee /srv/cbi/backup/age-recipients.txt
   ```

   You can list more than one recipient, for example a second, offline break-glass key.

2. **Create a Bunny Storage zone for backups only** (for example `cbi-backups`). Put it in a different region from the uploads zone and never attach a pull zone to it. Note the zone's password and its **read-only** password (Storage → FTP & API access).
3. **Fill in `/srv/cbi/.env.backup`** from `infrastructure/env/backup.env.example`: `BUNNY_BACKUP_ZONE`, `BUNNY_BACKUP_REGION_HOST`, `BUNNY_BACKUP_ACCESS_KEY`, `BUNNY_BACKUP_PREFIX=production`, and optionally `BACKUP_ALERT_URL` (for example a healthchecks.io `/fail` URL).
4. **Enable and test the timer:**

   ```bash
   sudo systemctl enable --now cbi-backup.timer
   sudo systemctl start cbi-backup.service && journalctl -u cbi-backup.service -n 20
   systemctl list-timers 'cbi-*'
   ```

## 2. Restore drill (monthly, automated)

Run the drill on a host that is allowed to hold the age identity: the staging VPS, or an ops machine with Docker, bash and age. Do not run it on production. Give it its own config file with the **read-only** zone password:

```bash
# /srv/cbi/.env.backup-drill-production  (on the staging VPS)
BACKUP_TARGET=bunny
BUNNY_BACKUP_ZONE=cbi-backups
BUNNY_BACKUP_REGION_HOST=storage.bunnycdn.com
BUNNY_BACKUP_READONLY_KEY=<read-only password>
BUNNY_BACKUP_PREFIX=production
BACKUP_AGE_IDENTITY_FILE=/srv/cbi/backup/drill-identity.txt   # mode 0400, owner deploy
BACKUP_MAX_AGE_HOURS=30
BACKUP_ALERT_URL=<alert webhook>
```

Point `cbi-restore-drill.service` at that file (`sudo systemctl edit cbi-restore-drill.service`, then override `ExecStart`) and run `sudo systemctl enable --now cbi-restore-drill.timer`. To run it now:

```bash
/srv/cbi/app/infrastructure/scripts/restore-drill.sh --config /srv/cbi/.env.backup-drill-production
```

The drill fails (non-zero exit, plus an alert) when any of these happens:

- the newest backup is older than `BACKUP_MAX_AGE_HOURS`
- decryption fails: wrong key, or a corrupted or truncated file (age authenticates every 64 KiB chunk)
- `mongorestore` fails
- a collection's document count differs from the manifest by more than 1 % (minimum 10 documents), an index count differs, or a collection is missing
- `users`, `auditLogs` or `interviewSessions` is empty
- the `users.primaryEmail` index is missing

Record each drill (date, archive, duration, result) in the ops log. The launch checklist requires one passing drill against real staging or production data.

### Drill evidence (Phase 12, local)

Run on Docker Desktop against `mongo` from `docker-compose.production.yml` (auth + keyfile + `rs0`, read-only root filesystem, separate compose project `cbi-drill`). Sample data was a read-only dump of the `cbi_interview_e2e11` test database plus 5,000 synthetic audit entries (46 collections, 5,114 documents). The scripts ran in a Linux container with bash, the docker CLI and age, using `BACKUP_TARGET=local:/srv/cbi/offsite`.

| Check                                                                 | Result                                                                                                                 |
| --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `mongo-init` run twice                                                | first run creates the RS and users, second updates them (idempotent); unauthenticated `listDatabases` → `Unauthorized` |
| `backup.sh` ×3 with `BACKUP_KEEP_DAILY=2`                             | 3 encrypted archives (~52 KB) and manifests written; the oldest pair pruned; no plaintext in the archives              |
| `restore-drill.sh`                                                    | **PASSED**: 5,114 documents restored; 46/46 collections match the manifest (counts and indexes); sanity checks OK      |
| corrupted archive (4 bytes changed)                                   | **exit 1**: `age: failed to decrypt and authenticate payload chunk`; nothing restored                                  |
| truncated archive                                                     | **exit 1** (same age error)                                                                                            |
| wrong identity                                                        | **exit 1**: `no identity matched any of the recipients`                                                                |
| intact archive, manifest says auditLogs had 9,000                     | **exit 1**: `FAIL auditLogs: 5008 documents (manifest 9000, allowed ±90)`                                              |
| `--into-compose` after dropping `users` and deleting 5,000 audit rows | restored and verified live (auditLogs 5,008, users 2); admin users and the app login still work                        |
| scratch containers left behind                                        | 0                                                                                                                      |

## 3. Restore a backup for inspection

```bash
# download (or use restore-drill.sh --archive FILE)
curl -fsS -H "AccessKey: $READ_ONLY_KEY" -o a.age  https://storage.bunnycdn.com/cbi-backups/production/daily/<name>.archive.gz.age
curl -fsS -H "AccessKey: $READ_ONLY_KEY" -o m.age  https://storage.bunnycdn.com/cbi-backups/production/daily/<name>.manifest.json.age
infrastructure/scripts/restore.sh a.age --manifest m.age --identity cbi-backup-identity.txt --keep
docker exec -it <printed scratch name> mongosh cbi_interview   # inspect; then: docker rm -f -v <name>
```

The scratch container has no network. Restored data includes personal data, so delete it once you are done.

## 4. Disaster recovery: restore into the live stack

Use this when production data is lost or corrupted and the server itself is healthy. **This overwrites the app database.**

1. Turn on **maintenance mode** (Admin → System → Settings → Maintenance) if the admin app still works, and post a status message.
2. Stop the writers and keep Mongo/Redis running:

   ```bash
   cd /srv/cbi/app && DC="docker compose -f docker-compose.production.yml --env-file /srv/cbi/state/compose.env"
   $DC stop api-blue api-green worker
   ```

3. Take a safety backup of the current state (even if it is broken): `backup.sh --kind daily`.
4. Bring the identity file onto the server temporarily (`/dev/shm/id.txt`, mode 0400), then restore:

   ```bash
   /srv/cbi/app/infrastructure/scripts/restore.sh <archive.age> --identity /dev/shm/id.txt \
     --into-compose --i-understand-this-overwrites-data
   shred -u /dev/shm/id.txt
   ```

   The archive is first restored into a scratch container and verified. Only then is the app database copied into the live `mongo` (`mongorestore --drop --nsInclude cbi_interview.*`), and it is verified again. Users in the admin database are untouched.

5. Redeploy the current tag, which re-runs `mongo-init` and starts the API colour and workers: `deploy.sh <CURRENT_TAG>`.
6. Check `status.sh` and Admin → System → Health, then turn off maintenance mode.
7. Everything written after the backup's timestamp is gone. Reconcile payments from that window with Razorpay: the worker's hourly reconciliation handles purchases whose orders are still in the database; purchases made after the backup need manual handling from the Razorpay dashboard. Record the incident.

**Whole-server loss:** provision a new VPS ([production.md §3](production.md#3-first-time-setup)) and copy the saved env files and Mongo keyfile. If they were lost, generate new ones and rotate every external credential. Deploy the last good tag, which starts an empty database, then run step 4 onwards. Finally, point DNS at the new host.

## 5. Point-in-time and RPO/RTO

- **RPO** is 24 hours (nightly dump). If that is too long, increase the timer frequency: backups are cheap at MVP data sizes.
- **RTO** is about 30–60 minutes for a live restore on an existing host, and 2–3 hours on a new host (provisioning, DNS and certificates).

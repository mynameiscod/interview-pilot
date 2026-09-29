# Runbook: backup and restore

Scripts: `infrastructure/scripts/backup.sh`, `restore.sh` and `restore-drill.sh`. Units: `infrastructure/systemd/cbi-backup.*` (nightly full), `cbi-backup-incremental.*` (hourly) and `cbi-restore-drill.*` (a cron alternative is in `crontab.example`).

| What         | How                                                                                                                                                                                                                                                                   |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Full dump    | `backup.sh --mode full`: `mongodump --archive --gzip --oplog` (a point-in-time consistent dump of the whole instance), run inside the `mongo` container as the `cbi_backup` user (built-in `backup` role). Starts a new incremental chain.                            |
| Incremental  | `backup.sh --mode incremental`: the `local.oplog.rs` entries written since the previous run of the chain (`config.*`/`local.*` excluded), `mongodump --out -` → gzip. Chain position in `/srv/cbi/state/backup-chain.state`.                                          |
| Chain safety | An incremental with no chain yet, or whose oplog no longer reaches back to the chain position (oplog rolled over), takes a **full** backup instead and alerts. Full and incremental runs share a lock, so they never overlap.                                         |
| Encryption   | `age` to the public key(s) in `/srv/cbi/backup/age-recipients.txt`. The private identity is **not** kept on the production server.                                                                                                                                    |
| Manifest     | Per-collection document and index counts, encrypted alongside every full and incremental (`*.manifest.json.age`). Restores are checked against the last one applied.                                                                                                  |
| Off-box copy | Bunny Storage HTTP API (`PUT` with `AccessKey` and a `Checksum` header) to a **separate** zone from app uploads, under `<prefix>/daily/`, `<prefix>/weekly/` and `<prefix>/incremental/` (incrementals are named `<full name>.inc-<stamp>.oplog.bson.gz.age`).        |
| Schedule     | Full: nightly at 20:30 UTC (02:00 IST); the Sunday run also writes a weekly copy. Incremental: every hour at :15.                                                                                                                                                     |
| Retention    | Keeps the 7 newest daily and 4 newest weekly full archives (older ones are deleted remotely). Incrementals are kept exactly as long as the daily full they extend.                                                                                                    |
| Restore test | Monthly (`cbi-restore-drill.timer`, on the 3rd). Downloads the newest full archive **and its incrementals**, restores the full dump into a scratch container with no network, replays the incrementals, verifies against the last manifest and removes the container. |
| Monitoring   | Every success writes `cbi_backup_last_success_timestamp_seconds{mode="full"\|"incremental"}` to `/srv/cbi/state/metrics/` (node_exporter textfile collector); alert rules in [observability.md](observability.md#alert-rules).                                        |
| Failure      | Any failure exits non-zero, is logged to journald (`journalctl -u cbi-backup -u cbi-backup-incremental`) and is POSTed to `BACKUP_ALERT_URL` when set.                                                                                                                |

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
4. **Enable and test the timers** (installed by `provision.sh`; re-run it, or copy the two `cbi-backup-incremental.*` units to `/etc/systemd/system/`, on hosts provisioned before hourly backups existed):

   ```bash
   sudo systemctl daemon-reload
   sudo systemctl enable --now cbi-backup.timer cbi-backup-incremental.timer
   sudo systemctl start cbi-backup.service && journalctl -u cbi-backup.service -n 20
   sudo systemctl start cbi-backup-incremental.service && journalctl -u cbi-backup-incremental.service -n 20
   systemctl list-timers 'cbi-*'
   ```

   | Timer                          | Schedule (UTC)                            | Runs                                                   |
   | ------------------------------ | ----------------------------------------- | ------------------------------------------------------ |
   | `cbi-backup.timer`             | daily 20:30 (±15 min), `Persistent=true`  | `backup.sh --mode full` (Sunday: also the weekly copy) |
   | `cbi-backup-incremental.timer` | hourly at :15 (±2 min), `Persistent=true` | `backup.sh --mode incremental`                         |
   | `cbi-restore-drill.timer`      | monthly, the 3rd at 05:00 (±30 min)       | `restore-drill.sh` (drill host only)                   |
   | `cbi-disk-alert.timer`         | every 15 min                              | `cbi-disk-alert` (80 % threshold)                      |

   Without systemd, use the equivalent lines in `infrastructure/systemd/crontab.example`.

5. **Oplog window.** An incremental needs every oplog entry since the previous run, so the oplog must hold comfortably more than the gap between runs (hours, plus any outage you want to ride out). Check it with `rs.printReplicationInfo()` in `mongosh` ("log length start to end"). The default oplog (5 % of the disk, at least 990 MB) is days at MVP write rates; if it drops below 24 h, grow it with `db.adminCommand({ replSetResizeOplog: 1, minRetentionHours: 48 })`. When the window is too short, the next incremental falls back to a full backup and alerts, so no gap is silently created.

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
BACKUP_MAX_INCREMENTAL_AGE_HOURS=3
BACKUP_ALERT_URL=<alert webhook>
```

Point `cbi-restore-drill.service` at that file (`sudo systemctl edit cbi-restore-drill.service`, then override `ExecStart`) and run `sudo systemctl enable --now cbi-restore-drill.timer`. To run it now:

```bash
/srv/cbi/app/infrastructure/scripts/restore-drill.sh --config /srv/cbi/.env.backup-drill-production
```

The drill fails (non-zero exit, plus an alert) when any of these happens:

- the newest full backup is older than `BACKUP_MAX_AGE_HOURS`, or the newest restore point (last incremental) is older than `BACKUP_MAX_INCREMENTAL_AGE_HOURS`
- an incremental fails to decrypt or its oplog replay fails (a broken chain)
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

### Drill evidence (hourly incrementals, local)

Run on Docker Desktop against a single-node `mongo:8.0` replica set, scripts in an Alpine container (bash, docker CLI, age), `BACKUP_TARGET=local:`:

| Check                                                                                | Result                                                                                                      |
| ------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| full → writes (inserts, deletes, update, a multi-document transaction) → incremental | slice uploaded with its manifest; chain position advanced                                                   |
| incremental with nothing new                                                         | "no new operations"; metric updated, nothing uploaded                                                       |
| `restore-drill.sh` (full + 2 incrementals)                                           | **PASSED**: 265 documents, 4/4 collections match the last slice's manifest (incl. the transaction's writes) |
| `BACKUP_DRILL_INCREMENTALS=0`                                                        | **PASSED** against the full backup's own manifest (251 documents)                                           |
| chain position older than the oplog window                                           | warning + alert, full backup taken instead, new chain started                                               |

## 3. Restore a backup for inspection

Keep the original object names: `restore.sh` checks that each incremental belongs to the full archive by name, and picks the matching manifest next to the last file.

```bash
Z=https://storage.bunnycdn.com/cbi-backups/production
curl -fsS -H "AccessKey: $READ_ONLY_KEY" -O "$Z/daily/<name>.archive.gz.age"
curl -fsS -H "AccessKey: $READ_ONLY_KEY" -O "$Z/daily/<name>.manifest.json.age"
# list the full backup's incrementals, then download all of them (and the last one's manifest)
curl -fsS -H "AccessKey: $READ_ONLY_KEY" -H 'Accept: application/json' "$Z/incremental/" |
  jq -r '.[].ObjectName' | grep "^<name>\.inc-" | sort
infrastructure/scripts/restore.sh <name>.archive.gz.age \
  --incremental <name>.inc-<stamp1>.oplog.bson.gz.age --incremental <name>.inc-<stamp2>.oplog.bson.gz.age \
  --identity cbi-backup-identity.txt --keep
docker exec -it <printed scratch name> mongosh cbi_interview   # inspect; then: docker rm -f -v <name>
```

Without `--incremental` only the full dump is restored (state at the nightly backup). Give **every** incremental of the chain in name order up to the point you need; skipping one leaves a gap. For a point in time inside the last slice, add `--oplog-limit <unix seconds>` (for example `--oplog-limit $(date -u -d '2026-09-29 10:15' +%s)`): the replay stops just before that moment, and only the sanity checks run because no manifest matches it.

The scratch container has no network. Restored data includes personal data, so delete it once you are done.

## 4. Disaster recovery: restore into the live stack

Use this when production data is lost or corrupted and the server itself is healthy. **This overwrites the app database.**

1. Turn on **maintenance mode** (Admin → System → Settings → Maintenance) if the admin app still works, and post a status message.
2. Stop the writers and keep Mongo/Redis running:

   ```bash
   cd /srv/cbi/app && DC="docker compose -f docker-compose.production.yml --env-file /srv/cbi/state/compose.env"
   $DC stop api-blue api-green worker
   ```

3. Take a safety backup of the current state (even if it is broken): `backup.sh --mode full --kind daily`. Stop `cbi-backup-incremental.timer` until the restore is done, then take a fresh full backup (step 6) so the next chain starts from the restored data.
4. Bring the identity file onto the server temporarily (`/dev/shm/id.txt`, mode 0400), download the newest full archive and all of its incrementals (§3), then restore:

   ```bash
   /srv/cbi/app/infrastructure/scripts/restore.sh <name>.archive.gz.age \
     --incremental <name>.inc-<stamp1>.oplog.bson.gz.age ... --incremental <name>.inc-<stampN>.oplog.bson.gz.age \
     --identity /dev/shm/id.txt --into-compose --i-understand-this-overwrites-data
   shred -u /dev/shm/id.txt
   ```

   To undo a bad write (a mistaken bulk update or delete), restore to just before it with `--oplog-limit <unix seconds>` instead of replaying everything.

   The archive is first restored into a scratch container and verified. Only then is the app database copied into the live `mongo` (`mongorestore --drop --nsInclude cbi_interview.*`), and it is verified again. Users in the admin database are untouched.

5. Redeploy the current tag, which re-runs `mongo-init` and starts the API colour and workers: `deploy.sh <CURRENT_TAG>`.
6. Check `status.sh` and Admin → System → Health, then turn off maintenance mode. Run `backup.sh --mode full` and re-enable `cbi-backup-incremental.timer`.
7. Everything written after the last replayed incremental (or the `--oplog-limit` point) is gone. Reconcile payments from that window with Razorpay: the worker's hourly reconciliation handles purchases whose orders are still in the database; purchases made after the backup need manual handling from the Razorpay dashboard. Record the incident.

**Whole-server loss:** provision a new VPS ([production.md §3](production.md#3-first-time-setup)) and copy the saved env files and Mongo keyfile. If they were lost, generate new ones and rotate every external credential. Deploy the last good tag, which starts an empty database, then run step 4 onwards. Finally, point DNS at the new host.

## 5. Point-in-time, RPO and RTO

| Scenario                                               | RPO (data that can be lost)                                                     | RTO (time to service)                                                                                                          |
| ------------------------------------------------------ | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Process crash / container restart                      | 0 (Mongo journal, Redis AOF `everysec`: at most ~1 s of queue state)            | seconds to a minute (`restart: unless-stopped`)                                                                                |
| Mongo member failure with a HA profile (`mongo-3node`) | 0 for majority-acknowledged writes                                              | ~10–30 s (election; drivers retry)                                                                                             |
| Data loss or corruption, host healthy (§4)             | **≤ 1 hour**: the last hourly incremental (typically `:15` + upload time)       | **~30–60 min**: download + scratch restore + incremental replay + verify + copy into the live stack; ~5 min more per 24 slices |
| Bad write (operator error)                             | 0 up to the mistake: `--oplog-limit` stops the replay just before it            | as above                                                                                                                       |
| Whole-server loss                                      | ≤ 1 hour (off-site copies in the Bunny backup zone, another region)             | **~2–3 hours**: provision a new VPS, DNS, certificates, deploy, restore (§4)                                                   |
| Backup zone lost as well                               | up to 24 h plus: only what the drill host or an extra `local:` copy still holds | as whole-server loss                                                                                                           |

The RPO holds only while the incremental timer runs and the oplog window covers the gap between runs: the `CbiBackupIncrementalStale` alert fires at 2 h, and the monthly drill fails when the newest restore point is older than `BACKUP_MAX_INCREMENTAL_AGE_HOURS`. Redis is not restored from backups (see above); queued jobs lost with it are re-created by the worker's sweeps (evaluations are resumed from MongoDB state).

To shorten the RPO further, schedule the incremental timer more often (`OnCalendar=*:0/15`); every run is cheap because it only copies new oplog entries. To shorten the RTO, keep the drill host warm (images pulled, identity available to two people) and practise §4 during drills.

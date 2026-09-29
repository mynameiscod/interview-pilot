#!/usr/bin/env bash
# Encrypted MongoDB backup (design §14): a daily FULL dump plus hourly INCREMENTAL oplog
# slices, taken from the mongo container (backup user), encrypted with age, uploaded
# off-box and pruned.
#
# Usage:
#   backup.sh [--config /srv/cbi/.env.backup] [--mode full|incremental]
#             [--kind auto|daily|weekly]
#
#   --mode full         mongodump --archive --gzip --oplog (point-in-time consistent) and
#                       starts a new incremental chain. Default. Timer: cbi-backup.timer.
#   --mode incremental  dumps local.oplog.rs entries written since the previous run of the
#                       chain (full or incremental). Falls back to a full backup when there
#                       is no chain yet, or when the oplog no longer reaches back to it (the
#                       chain would have a gap). Timer: cbi-backup-incremental.timer.
#   --kind              full backups only: weekly copies are made on Sundays with auto.
#
# Settings (from --config, default $CBI_HOME/.env.backup; see infrastructure/env/backup.env.example):
#   BACKUP_TARGET               bunny | local:<dir>
#   BUNNY_BACKUP_ZONE, BUNNY_BACKUP_REGION_HOST, BUNNY_BACKUP_ACCESS_KEY, BUNNY_BACKUP_PREFIX
#   BACKUP_AGE_RECIPIENTS_FILE  age public key(s); the private identity stays OFF the server
#   BACKUP_KEEP_DAILY (7), BACKUP_KEEP_WEEKLY (4), BACKUP_ALERT_URL (optional)
#   BACKUP_METRICS_DIR          node_exporter textfile directory (default $CBI_HOME/state/metrics)
# Credentials: MONGO_BACKUP_USER / MONGO_BACKUP_PASSWORD from $CBI_HOME/.env.datastores
# (override the file with DATASTORES_ENV_FILE). The mongo container is found through
# docker compose (project cbi-<env>); set MONGO_CONTAINER to use another one.
#
# Output objects:
#   <prefix>/<daily|weekly>/cbi-<env>-<UTC stamp>.archive.gz.age           full dump
#   <prefix>/<daily|weekly>/cbi-<env>-<UTC stamp>.manifest.json.age        its manifest
#   <prefix>/incremental/<full name>.inc-<UTC stamp>.oplog.bson.gz.age     oplog slice
#   <prefix>/incremental/<full name>.inc-<UTC stamp>.manifest.json.age     counts after it
# Incrementals are named after the full backup they extend, so a restore takes one full
# archive plus its incrementals in name order (restore.sh --incremental, restore-drill.sh),
# and they are pruned together with their full backup. Manifests record per-collection
# document and index counts; restore.sh compares a restore against the last one applied.
#
# Chain state: $CBI_HOME/state/backup-chain.state (base name + last oplog timestamp).
# Exit code is non-zero on any failure; failures are logged and sent to BACKUP_ALERT_URL
# when set. The last success per mode is written as Prometheus textfile metrics.
set -euo pipefail

CBI_SCRIPT=backup
# shellcheck source=lib/common.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib/common.sh"

CONFIG="${BACKUP_ENV_FILE:-$CBI_HOME/.env.backup}"
MODE=full
KIND=auto
while [ $# -gt 0 ]; do
  case "$1" in
    --config)
      CONFIG="${2:-}"
      shift 2
      ;;
    --mode)
      MODE="${2:-}"
      shift 2
      ;;
    --kind)
      KIND="${2:-}"
      shift 2
      ;;
    -h | --help)
      sed -n '2,/^set -euo/p' "${BASH_SOURCE[0]}" | sed -e '$d' -e 's/^# \{0,1\}//'
      exit 0
      ;;
    *) die "unknown argument: $1 (see --help)" ;;
  esac
done
case "$MODE" in full | incremental) ;; *) die "--mode must be full or incremental" ;; esac
case "$KIND" in auto | daily | weekly) ;; *) die "--kind must be auto, daily or weekly" ;; esac

require_cmd docker age curl sha256sum flock gzip

read_env_keys "$CONFIG" BACKUP_TARGET BUNNY_BACKUP_ZONE BUNNY_BACKUP_REGION_HOST \
  BUNNY_BACKUP_ACCESS_KEY BUNNY_BACKUP_PREFIX BACKUP_AGE_RECIPIENTS_FILE \
  BACKUP_KEEP_DAILY BACKUP_KEEP_WEEKLY BACKUP_ALERT_URL BACKUP_METRICS_DIR
read_env_keys "${DATASTORES_ENV_FILE:-$CBI_HOME/.env.datastores}" \
  MONGO_BACKUP_USER MONGO_BACKUP_PASSWORD MONGO_APP_DB

BACKUP_TARGET="${BACKUP_TARGET:-bunny}"
BUNNY_BACKUP_REGION_HOST="${BUNNY_BACKUP_REGION_HOST:-storage.bunnycdn.com}"
BUNNY_BACKUP_PREFIX="${BUNNY_BACKUP_PREFIX:-default}"
BACKUP_KEEP_DAILY="${BACKUP_KEEP_DAILY:-7}"
BACKUP_KEEP_WEEKLY="${BACKUP_KEEP_WEEKLY:-4}"
BACKUP_ALERT_URL="${BACKUP_ALERT_URL:-}"
BACKUP_METRICS_DIR="${BACKUP_METRICS_DIR:-$STATE_DIR/metrics}"
MONGO_APP_DB="${MONGO_APP_DB:-cbi_interview}"
CHAIN_FILE="$STATE_DIR/backup-chain.state"
: "${MONGO_BACKUP_USER:?MONGO_BACKUP_USER missing}"
: "${MONGO_BACKUP_PASSWORD:?MONGO_BACKUP_PASSWORD missing}"
: "${BACKUP_AGE_RECIPIENTS_FILE:?BACKUP_AGE_RECIPIENTS_FILE missing}"
[ -s "$BACKUP_AGE_RECIPIENTS_FILE" ] || die "age recipients file is empty or missing: $BACKUP_AGE_RECIPIENTS_FILE"
case "$BACKUP_TARGET" in
  bunny)
    : "${BUNNY_BACKUP_ZONE:?BUNNY_BACKUP_ZONE missing}"
    : "${BUNNY_BACKUP_ACCESS_KEY:?BUNNY_BACKUP_ACCESS_KEY missing}"
    require_cmd jq
    ;;
  local:?*) LOCAL_DIR="${BACKUP_TARGET#local:}" ;;
  *) die "BACKUP_TARGET must be bunny or local:<dir>" ;;
esac

WORK_DIR=""
on_exit() {
  local rc=$?
  if [ -n "$WORK_DIR" ]; then rm -rf "$WORK_DIR"; fi
  if [ "$rc" -ne 0 ]; then
    warn "$MODE backup FAILED (exit $rc)"
    send_alert "$BACKUP_ALERT_URL" "CareerPilot $MODE backup FAILED on $(hostname) (${CBI_ENV_LABEL:-?}) exit $rc at $(_ts)"
  fi
}
trap on_exit EXIT

# One backup at a time: the hourly incremental waits for a running full backup (and the
# reverse), so the chain state is never read and written concurrently.
mkdir -p "$STATE_DIR"
exec 8>"$STATE_DIR/backup.lock"
flock -w 7200 8 || die "another backup has held the lock for 2 h"

# Locate the mongo container --------------------------------------------------------------
if [ -z "${MONGO_CONTAINER:-}" ]; then
  load_state
  CBI_ENV="${CBI_ENV_STATE:-production}"
  [ -f "$COMPOSE_ENV_FILE" ] || die "no $COMPOSE_ENV_FILE; set MONGO_CONTAINER"
  MONGO_CONTAINER="$(dc ps -q mongo | head -n 1)"
  [ -n "$MONGO_CONTAINER" ] || die "mongo container is not running"
fi
CBI_ENV_LABEL="${BACKUP_ENV_LABEL:-${CBI_ENV:-${BUNNY_BACKUP_PREFIX}}}"

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/cbi-backup.XXXXXX")"
chmod 700 "$WORK_DIR"

# mongodump reads the password from a YAML config on stdin, so it never appears on the
# host's process list; mongosh gets it through an environment variable of docker exec.
mongo_cfg() { printf 'password: "%s"\n' "$MONGO_BACKUP_PASSWORD"; }

# Runs a mongosh expression as the backup user and prints its output.
mongo_eval() {
  docker exec -i -e CBI_PW="$MONGO_BACKUP_PASSWORD" -e CBI_USER="$MONGO_BACKUP_USER" -e CBI_DB="$MONGO_APP_DB" \
    "$MONGO_CONTAINER" sh -c 'mongosh --quiet --host 127.0.0.1 -u "$CBI_USER" -p "$CBI_PW" --authenticationDatabase admin --eval "$1"' _ "$1"
}

# Newest ("last") or oldest ("first") oplog entry as <seconds>:<increment>.
oplog_ts() {
  local order=-1
  [ "$1" = first ] && order=1
  mongo_eval "const e = db.getSiblingDB('local').oplog.rs.find({}, { ts: 1 }).sort({ \$natural: $order }).limit(1).next(); print(e.ts.t + ':' + e.ts.i);" |
    tail -n 1 | tr -d '\r'
}

# a <= b for <seconds>:<increment> timestamps.
ts_le() {
  local at="${1%%:*}" ai="${1##*:}" bt="${2%%:*}" bi="${2##*:}"
  [ "$at" -lt "$bt" ] || { [ "$at" -eq "$bt" ] && [ "$ai" -le "$bi" ]; }
}

write_manifest() {
  mongo_eval "
    const d = db.getSiblingDB(process.env.CBI_DB);
    const out = { db: d.getName(), createdAt: new Date().toISOString(), collections: {} };
    for (const c of d.getCollectionInfos({ type: 'collection' })) {
      if (c.name.startsWith('system.')) continue;
      out.collections[c.name] = { count: d.getCollection(c.name).estimatedDocumentCount(), indexes: d.getCollection(c.name).getIndexes().length };
    }
    print(JSON.stringify(out));
  " | age -R "$BACKUP_AGE_RECIPIENTS_FILE" -o "$1"
}

# Chain state: written only here, KEY=value with no spaces, so sourcing it is safe.
CHAIN_BASE=""
CHAIN_LAST_TS=""
load_chain() {
  CHAIN_BASE=""
  CHAIN_LAST_TS=""
  # shellcheck disable=SC1090 # generated file
  if [ -f "$CHAIN_FILE" ]; then . "$CHAIN_FILE"; fi
}
save_chain() {
  local tmp="$CHAIN_FILE.tmp.$$"
  {
    echo "# Written by infrastructure/scripts/backup.sh — do not edit by hand."
    echo "CHAIN_BASE=$1"
    echo "CHAIN_LAST_TS=$2"
    echo "CHAIN_UPDATED_AT=$(_ts)"
  } >"$tmp"
  chmod 640 "$tmp"
  mv -f "$tmp" "$CHAIN_FILE"
}

# Prometheus textfile metric (node_exporter --collector.textfile.directory) per mode.
write_metric() {
  local mode="$1" file
  mkdir -p "$BACKUP_METRICS_DIR" 2>/dev/null || return 0
  file="$BACKUP_METRICS_DIR/cbi_backup_$mode.prom"
  {
    echo '# HELP cbi_backup_last_success_timestamp_seconds Unix time of the last successful backup.'
    echo '# TYPE cbi_backup_last_success_timestamp_seconds gauge'
    echo "cbi_backup_last_success_timestamp_seconds{mode=\"$mode\",env=\"$CBI_ENV_LABEL\"} $(date -u +%s)"
  } >"$file.tmp.$$" && mv -f "$file.tmp.$$" "$file" || warn "could not write $file"
}

# Upload + retention ------------------------------------------------------------------------
bunny_url() { echo "https://$BUNNY_BACKUP_REGION_HOST/$BUNNY_BACKUP_ZONE/$BUNNY_BACKUP_PREFIX/$1"; }

upload() {
  local kind="$1" file="$2" name checksum
  name="$(basename "$file")"
  case "$BACKUP_TARGET" in
    bunny)
      checksum="$(sha256sum "$file" | awk '{print toupper($1)}')"
      curl -fsS --retry 3 --retry-delay 5 -m 1800 -T "$file" \
        -H "AccessKey: $BUNNY_BACKUP_ACCESS_KEY" -H "Checksum: $checksum" \
        -H 'Content-Type: application/octet-stream' "$(bunny_url "$kind/$name")" >/dev/null
      ;;
    local:*)
      mkdir -p "$LOCAL_DIR/$BUNNY_BACKUP_PREFIX/$kind"
      cp "$file" "$LOCAL_DIR/$BUNNY_BACKUP_PREFIX/$kind/$name.tmp"
      mv -f "$LOCAL_DIR/$BUNNY_BACKUP_PREFIX/$kind/$name.tmp" "$LOCAL_DIR/$BUNNY_BACKUP_PREFIX/$kind/$name"
      ;;
  esac
  log "uploaded $kind/$name"
}

list_objects() {
  local kind="$1"
  case "$BACKUP_TARGET" in
    bunny)
      local listing
      if ! listing="$(curl -fsS -m 60 -H "AccessKey: $BUNNY_BACKUP_ACCESS_KEY" \
        -H 'Accept: application/json' "$(bunny_url "$kind/")")"; then
        warn "could not list $kind/ on Bunny; retention skipped this run"
        return 0
      fi
      jq -r '.[] | select(.IsDirectory | not) | .ObjectName' <<<"$listing"
      ;;
    local:*)
      ls -1 "$LOCAL_DIR/$BUNNY_BACKUP_PREFIX/$kind" 2>/dev/null || true
      ;;
  esac
}

delete_object() {
  local kind="$1" name="$2"
  case "$BACKUP_TARGET" in
    bunny) curl -fsS -m 60 -X DELETE -H "AccessKey: $BUNNY_BACKUP_ACCESS_KEY" "$(bunny_url "$kind/$name")" >/dev/null ;;
    local:*) rm -f "$LOCAL_DIR/$BUNNY_BACKUP_PREFIX/$kind/$name" ;;
  esac
}

prune() {
  local kind="$1" keep="$2" stamp
  # Archive names sort chronologically (UTC timestamp); keep the newest $keep runs.
  list_objects "$kind" | { grep -E '\.archive\.gz\.age$' || true; } | sort -r | tail -n +"$((keep + 1))" |
    while read -r old; do
      stamp="${old%.archive.gz.age}"
      delete_object "$kind" "$old"
      delete_object "$kind" "$stamp.manifest.json.age" || true
      log "pruned $kind/$old"
    done
}

# Incrementals are only useful on top of a daily full that still exists.
prune_incrementals() {
  local kept name base
  kept="$(list_objects daily | { grep -E '\.archive\.gz\.age$' || true; } | sed 's/\.archive\.gz\.age$//')"
  [ -n "$kept" ] || return 0
  list_objects incremental | { grep -E '\.inc-[0-9TZ]+\.' || true; } | while read -r name; do
    base="${name%%.inc-*}"
    if ! grep -qxF "$base" <<<"$kept"; then
      delete_object incremental "$name"
      log "pruned incremental/$name"
    fi
  done
}

# Full backup ------------------------------------------------------------------------------------
full_backup() {
  local name archive manifest size start_ts kinds k
  name="cbi-$CBI_ENV_LABEL-$STAMP"
  archive="$WORK_DIR/$name.archive.gz.age"
  manifest="$WORK_DIR/$name.manifest.json.age"

  # Incrementals continue from the newest oplog entry BEFORE the dump starts. The dump's
  # own oplog overlaps them a little; replaying an oplog entry twice is harmless.
  start_ts="$(oplog_ts last)"
  [[ "$start_ts" =~ ^[0-9]+:[0-9]+$ ]] || die "could not read the oplog position (got '$start_ts')"

  log "writing manifest for database $MONGO_APP_DB"
  write_manifest "$manifest"

  log "dumping (mongodump --archive --gzip --oplog) and encrypting with age"
  mongo_cfg | docker exec -i "$MONGO_CONTAINER" mongodump --quiet --host 127.0.0.1 \
    --username "$MONGO_BACKUP_USER" --config /dev/stdin --authenticationDatabase admin \
    --archive --gzip --oplog | age -R "$BACKUP_AGE_RECIPIENTS_FILE" -o "$archive"

  size="$(wc -c <"$archive" | tr -d ' ')"
  [ "$size" -gt 1024 ] || die "archive is suspiciously small ($size bytes)"
  head -c 21 "$archive" | grep -q 'age-encryption.org/v1' || die "archive is not an age file"
  log "archive ready: $name ($size bytes)"

  kinds=(daily)
  if [ "$KIND" = weekly ] || { [ "$KIND" = auto ] && [ "$(date -u +%u)" = 7 ]; }; then
    kinds+=(weekly)
  fi
  [ "$KIND" = weekly ] && kinds=(weekly)

  for k in "${kinds[@]}"; do
    upload "$k" "$manifest"
    upload "$k" "$archive"
  done
  # A new chain starts only from a daily full (weekly-only runs keep the current chain).
  if [[ " ${kinds[*]} " == *" daily "* ]]; then save_chain "$name" "$start_ts"; fi
  prune daily "$BACKUP_KEEP_DAILY"
  prune weekly "$BACKUP_KEEP_WEEKLY"
  prune_incrementals

  write_metric full
  log "full backup OK: $name (${kinds[*]}) -> $BACKUP_TARGET; incrementals continue from $start_ts"
}

# Incremental backup -----------------------------------------------------------------------------
incremental_backup() {
  local first_ts last_ts name slice manifest t i ut ui query
  load_chain
  if [ -z "$CHAIN_BASE" ] || ! [[ "$CHAIN_LAST_TS" =~ ^[0-9]+:[0-9]+$ ]]; then
    warn "no incremental chain yet; taking a full backup instead"
    MODE=full
    full_backup
    return
  fi
  first_ts="$(oplog_ts first)"
  last_ts="$(oplog_ts last)"
  [[ "$first_ts" =~ ^[0-9]+:[0-9]+$ && "$last_ts" =~ ^[0-9]+:[0-9]+$ ]] ||
    die "could not read the oplog window (got '$first_ts' .. '$last_ts')"
  # The oplog is a capped collection: if its oldest entry is newer than the chain's last
  # position, operations in between are gone and the chain cannot continue.
  if ! ts_le "$first_ts" "$CHAIN_LAST_TS"; then
    warn "oplog starts at $first_ts, after the chain position $CHAIN_LAST_TS (oplog too small or backups stopped); taking a full backup"
    send_alert "$BACKUP_ALERT_URL" "CareerPilot incremental chain broken on $(hostname) ($CBI_ENV_LABEL): oplog window too short; full backup taken"
    MODE=full
    full_backup
    return
  fi
  if [ "$last_ts" = "$CHAIN_LAST_TS" ]; then
    log "no new operations since $CHAIN_LAST_TS"
    write_metric incremental
    return
  fi

  name="$CHAIN_BASE.inc-$STAMP"
  slice="$WORK_DIR/$name.oplog.bson.gz.age"
  manifest="$WORK_DIR/$name.manifest.json.age"
  t="${CHAIN_LAST_TS%%:*}" i="${CHAIN_LAST_TS##*:}" ut="${last_ts%%:*}" ui="${last_ts##*:}"
  # (last position, now]; config.* and local.* are node-internal and never replayed.
  query="{\"ts\":{\"\$gt\":{\"\$timestamp\":{\"t\":$t,\"i\":$i}},\"\$lte\":{\"\$timestamp\":{\"t\":$ut,\"i\":$ui}}},\"ns\":{\"\$not\":{\"\$regularExpression\":{\"pattern\":\"^(config|local)\\\\.\",\"options\":\"\"}}}}"

  log "dumping oplog $CHAIN_LAST_TS .. $last_ts (chain $CHAIN_BASE) and encrypting with age"
  mongo_cfg | docker exec -i "$MONGO_CONTAINER" mongodump --quiet --host 127.0.0.1 \
    --username "$MONGO_BACKUP_USER" --config /dev/stdin --authenticationDatabase admin \
    --db local --collection oplog.rs --query "$query" --out - |
    gzip -c | age -R "$BACKUP_AGE_RECIPIENTS_FILE" -o "$slice"
  head -c 21 "$slice" | grep -q 'age-encryption.org/v1' || die "oplog slice is not an age file"
  write_manifest "$manifest"

  upload incremental "$manifest"
  upload incremental "$slice"
  save_chain "$CHAIN_BASE" "$last_ts"
  write_metric incremental
  log "incremental backup OK: $name ($(wc -c <"$slice" | tr -d ' ') bytes) -> $BACKUP_TARGET"
}

if [ "$MODE" = incremental ]; then incremental_backup; else full_backup; fi

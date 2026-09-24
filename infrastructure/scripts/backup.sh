#!/usr/bin/env bash
# Encrypted MongoDB backup (design §14): mongodump --archive --gzip --oplog from the
# mongo container (backup user), encrypted with age, uploaded off-box, pruned.
#
# Usage:
#   backup.sh [--config /srv/cbi/.env.backup] [--kind auto|daily|weekly]
#
# Settings (from --config, default $CBI_HOME/.env.backup; see infrastructure/env/backup.env.example):
#   BACKUP_TARGET               bunny | local:<dir>
#   BUNNY_BACKUP_ZONE, BUNNY_BACKUP_REGION_HOST, BUNNY_BACKUP_ACCESS_KEY, BUNNY_BACKUP_PREFIX
#   BACKUP_AGE_RECIPIENTS_FILE  age public key(s); the private identity stays OFF the server
#   BACKUP_KEEP_DAILY (7), BACKUP_KEEP_WEEKLY (4), BACKUP_ALERT_URL (optional)
# Credentials: MONGO_BACKUP_USER / MONGO_BACKUP_PASSWORD from $CBI_HOME/.env.datastores
# (override the file with DATASTORES_ENV_FILE). The mongo container is found through
# docker compose (project cbi-<env>); set MONGO_CONTAINER to use another one.
#
# Output objects (per run; weekly copies are made on Sundays with --kind auto):
#   <prefix>/<daily|weekly>/cbi-<env>-<UTC timestamp>.archive.gz.age
#   <prefix>/<daily|weekly>/cbi-<env>-<UTC timestamp>.manifest.json.age
# The manifest records per-collection document and index counts; restore.sh
# compares a restore against it.
#
# Exit code is non-zero on any failure; failures are logged and sent to
# BACKUP_ALERT_URL when set. Schedule: infrastructure/systemd/cbi-backup.timer.
set -euo pipefail

CBI_SCRIPT=backup
# shellcheck source=lib/common.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib/common.sh"

CONFIG="${BACKUP_ENV_FILE:-$CBI_HOME/.env.backup}"
KIND=auto
while [ $# -gt 0 ]; do
  case "$1" in
    --config)
      CONFIG="${2:-}"
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
case "$KIND" in auto | daily | weekly) ;; *) die "--kind must be auto, daily or weekly" ;; esac

require_cmd docker age curl sha256sum

read_env_keys "$CONFIG" BACKUP_TARGET BUNNY_BACKUP_ZONE BUNNY_BACKUP_REGION_HOST \
  BUNNY_BACKUP_ACCESS_KEY BUNNY_BACKUP_PREFIX BACKUP_AGE_RECIPIENTS_FILE \
  BACKUP_KEEP_DAILY BACKUP_KEEP_WEEKLY BACKUP_ALERT_URL
read_env_keys "${DATASTORES_ENV_FILE:-$CBI_HOME/.env.datastores}" \
  MONGO_BACKUP_USER MONGO_BACKUP_PASSWORD MONGO_APP_DB

BACKUP_TARGET="${BACKUP_TARGET:-bunny}"
BUNNY_BACKUP_REGION_HOST="${BUNNY_BACKUP_REGION_HOST:-storage.bunnycdn.com}"
BUNNY_BACKUP_PREFIX="${BUNNY_BACKUP_PREFIX:-default}"
BACKUP_KEEP_DAILY="${BACKUP_KEEP_DAILY:-7}"
BACKUP_KEEP_WEEKLY="${BACKUP_KEEP_WEEKLY:-4}"
BACKUP_ALERT_URL="${BACKUP_ALERT_URL:-}"
MONGO_APP_DB="${MONGO_APP_DB:-cbi_interview}"
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
    warn "backup FAILED (exit $rc)"
    send_alert "$BACKUP_ALERT_URL" "CareerPilot backup FAILED on $(hostname) (${CBI_ENV_LABEL:-?}) exit $rc at $(_ts)"
  fi
}
trap on_exit EXIT

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
NAME="cbi-$CBI_ENV_LABEL-$STAMP"
WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/cbi-backup.XXXXXX")"
chmod 700 "$WORK_DIR"
ARCHIVE="$WORK_DIR/$NAME.archive.gz.age"
MANIFEST="$WORK_DIR/$NAME.manifest.json.age"

# mongodump reads the password from a YAML config on stdin, so it never appears on the
# host's process list; mongosh gets it through an environment variable of docker exec.
mongo_cfg() { printf 'password: "%s"\n' "$MONGO_BACKUP_PASSWORD"; }

log "writing manifest for database $MONGO_APP_DB"
docker exec -i -e CBI_PW="$MONGO_BACKUP_PASSWORD" -e CBI_USER="$MONGO_BACKUP_USER" -e CBI_DB="$MONGO_APP_DB" \
  "$MONGO_CONTAINER" sh -c 'mongosh --quiet --host 127.0.0.1 -u "$CBI_USER" -p "$CBI_PW" --authenticationDatabase admin --eval "
    const d = db.getSiblingDB(process.env.CBI_DB);
    const out = { db: d.getName(), createdAt: new Date().toISOString(), collections: {} };
    for (const c of d.getCollectionInfos({ type: \"collection\" })) {
      if (c.name.startsWith(\"system.\")) continue;
      out.collections[c.name] = { count: d.getCollection(c.name).estimatedDocumentCount(), indexes: d.getCollection(c.name).getIndexes().length };
    }
    print(JSON.stringify(out));
  "' | age -R "$BACKUP_AGE_RECIPIENTS_FILE" -o "$MANIFEST"

log "dumping (mongodump --archive --gzip --oplog) and encrypting with age"
mongo_cfg | docker exec -i "$MONGO_CONTAINER" mongodump --quiet --host 127.0.0.1 \
  --username "$MONGO_BACKUP_USER" --config /dev/stdin --authenticationDatabase admin \
  --archive --gzip --oplog | age -R "$BACKUP_AGE_RECIPIENTS_FILE" -o "$ARCHIVE"

size="$(wc -c <"$ARCHIVE" | tr -d ' ')"
[ "$size" -gt 1024 ] || die "archive is suspiciously small ($size bytes)"
head -c 21 "$ARCHIVE" | grep -q 'age-encryption.org/v1' || die "archive is not an age file"
log "archive ready: $NAME ($size bytes)"

KINDS=(daily)
if [ "$KIND" = weekly ] || { [ "$KIND" = auto ] && [ "$(date -u +%u)" = 7 ]; }; then
  KINDS+=(weekly)
fi
[ "$KIND" = weekly ] && KINDS=(weekly)

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

list_archives() {
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
  list_archives "$kind" | { grep -E '\.archive\.gz\.age$' || true; } | sort -r | tail -n +"$((keep + 1))" |
    while read -r old; do
      stamp="${old%.archive.gz.age}"
      delete_object "$kind" "$old"
      delete_object "$kind" "$stamp.manifest.json.age" || true
      log "pruned $kind/$old"
    done
}

for k in "${KINDS[@]}"; do
  upload "$k" "$MANIFEST"
  upload "$k" "$ARCHIVE"
done
prune daily "$BACKUP_KEEP_DAILY"
prune weekly "$BACKUP_KEEP_WEEKLY"

log "backup OK: $NAME (${KINDS[*]}) -> $BACKUP_TARGET"

#!/usr/bin/env bash
# Decrypts a backup made by backup.sh and restores it, then verifies the result.
#
# Usage:
#   restore.sh <archive.gz.age> --identity <age-identity-file> [options]
#
# Always restores into a throwaway "scratch" mongo container with no network first. The
# archive is decrypted to a private temp dir (age authenticates every chunk, so a
# corrupted or truncated file fails before anything is restored), then
#   mongorestore --archive --gzip --oplogReplay --drop
# and infrastructure/mongo/verify-restore.js checks collection counts and indexes
# against the manifest, plus sanity queries (users / auditLogs / interviewSessions
# non-empty, users email index present). The scratch container is removed afterwards.
#
# Options:
#   --identity FILE        age identity (private key). Or BACKUP_AGE_IDENTITY_FILE.
#   --manifest FILE        encrypted manifest (default: <archive>.manifest.json.age next to it)
#   --db NAME              database to restore (default cbi_interview)
#   --keep                 leave the scratch container running for inspection (scratch only)
#   --tolerance-pct N      allowed count difference vs the manifest (default 1 %, min 10 docs)
#   --require-nonempty "a b c"   collections that must not be empty
#   --require-super-admin  also require at least one SUPER_ADMIN user
#   --mongo-image IMAGE    scratch image (default mongo:8.0)
#
# DISASTER RECOVERY into the live stack (overwrites the app database!):
#   --into-compose --i-understand-this-overwrites-data
#   After the scratch restore verifies, copies ONLY the app database into the compose
#   `mongo` service (mongodump --db | mongorestore --nsInclude --drop, as root from
#   $CBI_HOME/.env.datastores) and verifies it again. Users in the live admin database
#   are untouched. Stop api-blue/api-green/worker first; follow
#   docs/deployment/runbook-backup-restore.md.
#
# Exit: 0 when restore and verification pass; non-zero otherwise.
set -euo pipefail

CBI_SCRIPT=restore
# shellcheck source=lib/common.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib/common.sh"

ARCHIVE=""
IDENTITY="${BACKUP_AGE_IDENTITY_FILE:-}"
MANIFEST=""
DB_NAME="${MONGO_APP_DB:-cbi_interview}"
KEEP=0
TOL_PCT="${RESTORE_TOLERANCE_PCT:-1}"
TOL_MIN="${RESTORE_TOLERANCE_MIN:-10}"
REQUIRE_NONEMPTY="${RESTORE_REQUIRE_NONEMPTY:-users auditLogs interviewSessions}"
REQUIRE_SUPER_ADMIN=0
MONGO_IMAGE="${RESTORE_MONGO_IMAGE:-mongo:8.0}"
INTO_COMPOSE=0
CONFIRMED=0
VERIFY_JS="$APP_DIR/infrastructure/mongo/verify-restore.js"

while [ $# -gt 0 ]; do
  case "$1" in
    --identity)
      IDENTITY="${2:-}"
      shift 2
      ;;
    --manifest)
      MANIFEST="${2:-}"
      shift 2
      ;;
    --db)
      DB_NAME="${2:-}"
      shift 2
      ;;
    --keep)
      KEEP=1
      shift
      ;;
    --tolerance-pct)
      TOL_PCT="${2:-}"
      shift 2
      ;;
    --tolerance-min)
      TOL_MIN="${2:-}"
      shift 2
      ;;
    --require-nonempty)
      REQUIRE_NONEMPTY="${2:-}"
      shift 2
      ;;
    --require-super-admin)
      REQUIRE_SUPER_ADMIN=1
      shift
      ;;
    --mongo-image)
      MONGO_IMAGE="${2:-}"
      shift 2
      ;;
    --into-compose)
      INTO_COMPOSE=1
      shift
      ;;
    --i-understand-this-overwrites-data)
      CONFIRMED=1
      shift
      ;;
    -h | --help)
      sed -n '2,/^set -euo/p' "${BASH_SOURCE[0]}" | sed -e '$d' -e 's/^# \{0,1\}//'
      exit 0
      ;;
    -*) die "unknown option: $1 (see --help)" ;;
    *)
      [ -z "$ARCHIVE" ] || die "only one archive may be given"
      ARCHIVE="$1"
      shift
      ;;
  esac
done

[ -n "$ARCHIVE" ] || die "usage: restore.sh <archive.gz.age> --identity <file> (see --help)"
[ -f "$ARCHIVE" ] || die "archive not found: $ARCHIVE"
[ -n "$IDENTITY" ] || die "--identity (or BACKUP_AGE_IDENTITY_FILE) is required"
[ -r "$IDENTITY" ] || die "cannot read identity file: $IDENTITY"
[ -f "$VERIFY_JS" ] || die "missing $VERIFY_JS"
[[ "$DB_NAME" =~ ^[A-Za-z0-9_-]+$ ]] || die "invalid --db"
if [ "$INTO_COMPOSE" -eq 1 ] && [ "$CONFIRMED" -eq 0 ]; then
  die "--into-compose overwrites the live database; add --i-understand-this-overwrites-data"
fi
require_cmd docker age

if [ -z "$MANIFEST" ]; then
  candidate="${ARCHIVE%.archive.gz.age}.manifest.json.age"
  [ -f "$candidate" ] && MANIFEST="$candidate"
fi

WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/cbi-restore.XXXXXX")"
chmod 700 "$WORK_DIR"
SCRATCH=""
cleanup() {
  local rc=$?
  rm -rf "$WORK_DIR"
  if [ -n "$SCRATCH" ] && { [ "$KEEP" -eq 0 ] || [ "$rc" -ne 0 ]; }; then
    docker rm -f -v "$SCRATCH" >/dev/null 2>&1 || true
    log "scratch container $SCRATCH removed"
  elif [ -n "$SCRATCH" ]; then
    log "scratch container kept: $SCRATCH (docker rm -f -v $SCRATCH when done)"
  fi
  [ "$rc" -eq 0 ] || warn "restore FAILED (exit $rc)"
}
trap cleanup EXIT

# 1. Decrypt (integrity check happens here) ------------------------------------------------------
log "decrypting $(basename "$ARCHIVE")"
age -d -i "$IDENTITY" -o "$WORK_DIR/dump.archive.gz" "$ARCHIVE" ||
  die "decryption failed: wrong identity, or the archive is corrupted/truncated"
gzip -t <"$WORK_DIR/dump.archive.gz" || die "decrypted archive is not a valid gzip stream"
MANIFEST_JSON=""
if [ -n "$MANIFEST" ]; then
  MANIFEST_JSON="$(age -d -i "$IDENTITY" "$MANIFEST")" || die "manifest decryption failed: $MANIFEST"
  log "manifest: $(basename "$MANIFEST")"
else
  warn "no manifest found; only sanity checks will run"
fi

# 2. Scratch container ------------------------------------------------------------------------------
SCRATCH="cbi-restore-scratch-$(date -u +%Y%m%d%H%M%S)-$$"
log "starting scratch container $SCRATCH ($MONGO_IMAGE, no network)"
docker run -d --name "$SCRATCH" --network none --label cbi.restore-scratch=1 "$MONGO_IMAGE" \
  --quiet >/dev/null
deadline=$((SECONDS + 90))
until docker exec "$SCRATCH" mongosh --quiet --eval "db.adminCommand('ping').ok" >/dev/null 2>&1; do
  [ "$SECONDS" -lt "$deadline" ] || die "scratch mongo did not start"
  sleep 2
done

# 3. Full restore into scratch -------------------------------------------------------------------------
# Archives are taken with --oplog (point-in-time consistent), and mongorestore refuses
# --oplogReplay together with any namespace filter, so the whole archive is restored
# here; only the verified app database is ever copied onwards (step 5).
log "mongorestore --archive --gzip --oplogReplay --drop (scratch)"
docker cp "$WORK_DIR/dump.archive.gz" "$SCRATCH:/tmp/dump.archive.gz" >/dev/null
if ! docker exec "$SCRATCH" mongorestore --host 127.0.0.1 --archive=/tmp/dump.archive.gz --gzip \
  --oplogReplay --drop --stopOnError >"$WORK_DIR/mongorestore.log" 2>&1; then
  tail -n 20 "$WORK_DIR/mongorestore.log" >&2
  die "mongorestore failed"
fi
# The last line is mongorestore's summary: "N document(s) restored successfully. ..."
tail -n 1 "$WORK_DIR/mongorestore.log" | sed 's/^/    /'
docker exec "$SCRATCH" rm -f /tmp/dump.archive.gz

# 4. Verify -------------------------------------------------------------------------------------------------
# Streamed through `docker exec` rather than `docker cp`: the live mongo has a read-only
# root filesystem and only its /tmp tmpfs is writable (from inside the container).
put_verify_script() {
  docker exec -i "$1" sh -c 'cat >/tmp/verify-restore.js' <"$VERIFY_JS"
}
put_verify_script "$SCRATCH"
verify() {
  local container="$1"
  shift
  docker exec -e CBI_DB="$DB_NAME" -e CBI_MANIFEST="$MANIFEST_JSON" \
    -e CBI_TOLERANCE_PCT="$TOL_PCT" -e CBI_TOLERANCE_MIN="$TOL_MIN" \
    -e CBI_REQUIRE_NONEMPTY="$REQUIRE_NONEMPTY" -e CBI_REQUIRE_SUPER_ADMIN="$REQUIRE_SUPER_ADMIN" \
    "$container" mongosh --quiet --host 127.0.0.1 "$@" --file /tmp/verify-restore.js
}
log "verifying the scratch restore"
verify "$SCRATCH" || die "verification failed"

if [ "$INTO_COMPOSE" -eq 0 ]; then
  log "restore OK: $(basename "$ARCHIVE") verified in scratch container $SCRATCH"
  exit 0
fi

# 5. Disaster recovery: copy the verified app database into the live mongo --------------------------
load_state
CBI_ENV="${CBI_ENV_STATE:-production}"
LIVE="$(dc ps -q mongo | head -n 1)"
[ -n "$LIVE" ] || die "compose mongo is not running"
for svc in api-blue api-green worker; do
  if [ -n "$(dc ps -q --status running "$svc" 2>/dev/null)" ]; then
    die "$svc is running; stop the API colours and workers before a live restore"
  fi
done
read_env_keys "$CBI_HOME/.env.datastores" MONGO_INITDB_ROOT_USERNAME MONGO_INITDB_ROOT_PASSWORD
log "copying $DB_NAME from scratch INTO THE LIVE mongo ($CBI_ENV) with --drop"
printf 'password: "%s"\n' "$MONGO_INITDB_ROOT_PASSWORD" |
  docker exec -i "$LIVE" sh -c 'umask 077; cat >/tmp/restore.cfg'
live_rc=0
docker exec "$SCRATCH" mongodump --quiet --host 127.0.0.1 --db "$DB_NAME" --archive --gzip |
  docker exec -i "$LIVE" mongorestore --quiet --host 127.0.0.1 \
    --username "$MONGO_INITDB_ROOT_USERNAME" --config /tmp/restore.cfg --authenticationDatabase admin \
    --archive --gzip --nsInclude "$DB_NAME.*" --drop --stopOnError || live_rc=$?
docker exec "$LIVE" rm -f /tmp/restore.cfg >/dev/null 2>&1 || true
[ "$live_rc" -eq 0 ] || die "live restore failed (exit $live_rc); the database may be partially restored"
put_verify_script "$LIVE"
log "verifying the live database"
live_verify_rc=0
verify "$LIVE" -u "$MONGO_INITDB_ROOT_USERNAME" -p "$MONGO_INITDB_ROOT_PASSWORD" --authenticationDatabase admin ||
  live_verify_rc=$?
docker exec "$LIVE" rm -f /tmp/verify-restore.js >/dev/null 2>&1 || true
[ "$live_verify_rc" -eq 0 ] || die "live verification failed"
log "live restore OK: $(basename "$ARCHIVE") -> $DB_NAME ($CBI_ENV). Re-run mongo-init, then start the API and workers."

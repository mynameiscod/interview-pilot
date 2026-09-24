#!/usr/bin/env bash
# Automated restore test (design §14: monthly restore into a scratch container).
# Fetches the newest backup from the backup target, decrypts it, restores it into a
# throwaway mongo container, verifies counts/indexes/sanity queries, tears it down.
#
# Usage:
#   restore-drill.sh [--config /srv/cbi/.env.backup] [--kind daily|weekly] [--archive FILE]
#
# Needs, in addition to backup.env settings:
#   BACKUP_AGE_IDENTITY_FILE   the age identity (private key). Run the drill on a host
#                              that may hold it (recommended: the staging VPS or an ops
#                              machine, with the backup zone's READ-ONLY password),
#                              not the production VPS.
#   BACKUP_MAX_AGE_HOURS       fail if the newest backup is older than this (default 30)
# Optional: RESTORE_REQUIRE_NONEMPTY, RESTORE_TOLERANCE_PCT (see restore.sh).
#
# Exit: 0 on a passing drill; non-zero (and BACKUP_ALERT_URL notified) otherwise.
# Schedule: infrastructure/systemd/cbi-restore-drill.timer (monthly).
set -euo pipefail

CBI_SCRIPT=restore-drill
# shellcheck source=lib/common.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib/common.sh"

CONFIG="${BACKUP_ENV_FILE:-$CBI_HOME/.env.backup}"
KIND=daily
ARCHIVE=""
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
    --archive)
      ARCHIVE="${2:-}"
      shift 2
      ;;
    -h | --help)
      sed -n '2,/^set -euo/p' "${BASH_SOURCE[0]}" | sed -e '$d' -e 's/^# \{0,1\}//'
      exit 0
      ;;
    *) die "unknown argument: $1 (see --help)" ;;
  esac
done

read_env_keys "$CONFIG" BACKUP_TARGET BUNNY_BACKUP_ZONE BUNNY_BACKUP_REGION_HOST \
  BUNNY_BACKUP_ACCESS_KEY BUNNY_BACKUP_READONLY_KEY BUNNY_BACKUP_PREFIX \
  BACKUP_AGE_IDENTITY_FILE BACKUP_ALERT_URL BACKUP_MAX_AGE_HOURS
BACKUP_TARGET="${BACKUP_TARGET:-bunny}"
BUNNY_BACKUP_REGION_HOST="${BUNNY_BACKUP_REGION_HOST:-storage.bunnycdn.com}"
BUNNY_BACKUP_PREFIX="${BUNNY_BACKUP_PREFIX:-default}"
BACKUP_ALERT_URL="${BACKUP_ALERT_URL:-}"
BACKUP_MAX_AGE_HOURS="${BACKUP_MAX_AGE_HOURS:-30}"
: "${BACKUP_AGE_IDENTITY_FILE:?BACKUP_AGE_IDENTITY_FILE is required for the drill}"
READ_KEY="${BUNNY_BACKUP_READONLY_KEY:-${BUNNY_BACKUP_ACCESS_KEY:-}}"

WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/cbi-drill.XXXXXX")"
chmod 700 "$WORK_DIR"
on_exit() {
  local rc=$?
  rm -rf "$WORK_DIR"
  if [ "$rc" -ne 0 ]; then
    warn "restore drill FAILED (exit $rc)"
    send_alert "$BACKUP_ALERT_URL" "CareerPilot restore drill FAILED on $(hostname) exit $rc at $(_ts)"
  fi
}
trap on_exit EXIT

bunny_url() { echo "https://$BUNNY_BACKUP_REGION_HOST/$BUNNY_BACKUP_ZONE/$BUNNY_BACKUP_PREFIX/$1"; }

# 1. Pick the newest archive -------------------------------------------------------------------
if [ -z "$ARCHIVE" ]; then
  case "$BACKUP_TARGET" in
    bunny)
      require_cmd curl jq
      : "${BUNNY_BACKUP_ZONE:?}" "${READ_KEY:?BUNNY_BACKUP_READONLY_KEY or BUNNY_BACKUP_ACCESS_KEY required}"
      latest="$(curl -fsS -m 60 -H "AccessKey: $READ_KEY" -H 'Accept: application/json' "$(bunny_url "$KIND/")" |
        jq -r '.[] | select(.IsDirectory | not) | .ObjectName' | { grep -E '\.archive\.gz\.age$' || true; } | sort | tail -n 1)"
      [ -n "$latest" ] || die "no archives found in $BUNNY_BACKUP_PREFIX/$KIND/"
      stamp="${latest%.archive.gz.age}"
      log "downloading $KIND/$latest"
      curl -fsS -m 3600 -H "AccessKey: $READ_KEY" -o "$WORK_DIR/$latest" "$(bunny_url "$KIND/$latest")"
      curl -fsS -m 300 -H "AccessKey: $READ_KEY" -o "$WORK_DIR/$stamp.manifest.json.age" \
        "$(bunny_url "$KIND/$stamp.manifest.json.age")" || warn "manifest missing for $latest"
      ARCHIVE="$WORK_DIR/$latest"
      ;;
    local:?*)
      dir="${BACKUP_TARGET#local:}/$BUNNY_BACKUP_PREFIX/$KIND"
      latest=""
      # Globs expand in sorted order and names carry a UTC timestamp: the last is newest.
      for f in "$dir"/*.archive.gz.age; do
        if [ -e "$f" ]; then latest="$(basename "$f")"; fi
      done
      [ -n "$latest" ] || die "no archives found in $dir"
      ARCHIVE="$dir/$latest"
      ;;
    *) die "BACKUP_TARGET must be bunny or local:<dir>" ;;
  esac
fi
log "drill archive: $(basename "$ARCHIVE")"

# 2. Freshness: the archive name carries its UTC timestamp -------------------------------------------
stamp_part="$(basename "$ARCHIVE" | grep -Eo '[0-9]{8}T[0-9]{6}Z' | head -n 1 || true)"
if [ -n "$stamp_part" ]; then
  iso="${stamp_part:0:4}-${stamp_part:4:2}-${stamp_part:6:2}T${stamp_part:9:2}:${stamp_part:11:2}:${stamp_part:13:2}Z"
  if created="$(date -u -d "$iso" +%s 2>/dev/null)"; then
    age_h=$((($(date -u +%s) - created) / 3600))
    log "backup age: ${age_h}h (limit ${BACKUP_MAX_AGE_HOURS}h)"
    [ "$age_h" -le "$BACKUP_MAX_AGE_HOURS" ] || die "newest backup is ${age_h}h old: nightly backups are not running"
  fi
fi

# 3. Restore into scratch + verify --------------------------------------------------------------------
started=$SECONDS
bash "$(dirname "${BASH_SOURCE[0]}")/restore.sh" "$ARCHIVE" --identity "$BACKUP_AGE_IDENTITY_FILE"
log "restore drill PASSED in $((SECONDS - started))s: $(basename "$ARCHIVE")"

#!/usr/bin/env bash
# Rolls back to the previously deployed image tag (or a given one) using the same
# blue/green flow as deploy.sh: the idle colour starts on the old tag, /readyz,
# NGINX swap, the current colour drains, workers restart.
#
# Usage:
#   rollback.sh [--env staging|production] [--to <tag>] [--yes] [-- <extra deploy.sh options>]
#
# Images of the previous tag are normally still on the host, so a rollback works
# even while the registry is unreachable (deploy.sh falls back to local images).
#
# Database changes are never rolled back: the API only makes additive, backward
# compatible changes (indexes, seeded catalogue rows), so the previous release keeps
# working against the current database. If a release shipped a destructive data
# change, restore from backup instead (runbook-backup-restore.md).
set -euo pipefail

CBI_SCRIPT=rollback
# shellcheck source=lib/common.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib/common.sh"

TARGET=""
ENV_ARG=()
ASSUME_YES=0
EXTRA=()
while [ $# -gt 0 ]; do
  case "$1" in
    --env)
      ENV_ARG=(--env "${2:-}")
      shift 2
      ;;
    --to)
      TARGET="${2:-}"
      shift 2
      ;;
    --yes | -y)
      ASSUME_YES=1
      shift
      ;;
    --)
      shift
      EXTRA=("$@")
      break
      ;;
    -h | --help)
      sed -n '2,/^set -euo/p' "${BASH_SOURCE[0]}" | sed -e '$d' -e 's/^# \{0,1\}//'
      exit 0
      ;;
    *) die "unknown argument: $1 (see --help)" ;;
  esac
done

load_state
[ -n "$CURRENT_TAG" ] || die "nothing deployed yet (no $STATE_FILE)"
TARGET="${TARGET:-$PREVIOUS_TAG}"
[ -n "$TARGET" ] || die "no previous tag recorded; pass --to <tag>"
valid_tag "$TARGET" || die "invalid tag: $TARGET"
[ "$TARGET" != "$CURRENT_TAG" ] || die "$TARGET is already current"

log "rolling back ${CBI_ENV_STATE:-?}: $CURRENT_TAG -> $TARGET"
if [ "$ASSUME_YES" -eq 0 ]; then
  if [ -t 0 ]; then
    printf 'Proceed? [y/N] '
    read -r answer
    case "$answer" in y | Y | yes) ;; *) die "aborted" ;; esac
  else
    die "non-interactive: pass --yes"
  fi
fi

exec bash "$(dirname "${BASH_SOURCE[0]}")/deploy.sh" "$TARGET" "${ENV_ARG[@]}" "${EXTRA[@]}"

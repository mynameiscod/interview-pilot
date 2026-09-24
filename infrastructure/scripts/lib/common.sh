#!/usr/bin/env bash
# shellcheck disable=SC2034 # the variables below are used by the scripts that source this file
# Shared helpers for the deployment scripts. Source it; do not execute it.
#   # shellcheck source=lib/common.sh
#   . "$(dirname "$0")/lib/common.sh"
#
# Conventions (see docs/deployment/production.md):
#   CBI_HOME   /srv/cbi on the VPS: env files, secrets, state, nginx state, web releases
#   APP_DIR    the checkout holding docker-compose.production.yml (default: this repo)

# Directory layout -----------------------------------------------------------------
CBI_HOME="${CBI_HOME:-/srv/cbi}"
_CBI_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="${APP_DIR:-$(cd "$_CBI_LIB_DIR/../../.." && pwd)}"
COMPOSE_FILE_PATH="${COMPOSE_FILE_PATH:-$APP_DIR/docker-compose.production.yml}"
STATE_DIR="${STATE_DIR:-$CBI_HOME/state}"
STATE_FILE="$STATE_DIR/deploy.state"
COMPOSE_ENV_FILE="$STATE_DIR/compose.env"
HISTORY_FILE="$STATE_DIR/history.log"
NGINX_STATE_DIR="$CBI_HOME/nginx"
WWW_DIR="$CBI_HOME/www"
DEFAULT_IMAGE_REGISTRY="ghcr.io/codebegun/interview-pilot"

# Logging --------------------------------------------------------------------------
_ts() { date -u +%Y-%m-%dT%H:%M:%SZ; }
log() { printf '%s [%s] %s\n' "$(_ts)" "${CBI_SCRIPT:-cbi}" "$*"; }
warn() { printf '%s [%s] WARN %s\n' "$(_ts)" "${CBI_SCRIPT:-cbi}" "$*" >&2; }
die() {
  printf '%s [%s] ERROR %s\n' "$(_ts)" "${CBI_SCRIPT:-cbi}" "$*" >&2
  exit 1
}

require_cmd() {
  local c
  for c in "$@"; do
    command -v "$c" >/dev/null 2>&1 || die "required command not found: $c"
  done
}

# Reads KEY=VALUE lines from an env file without executing it (values may contain
# spaces, <, >, & ...). Only keys given as arguments are exported. Lines are taken
# literally: no quotes removal beyond one surrounding pair.
read_env_keys() {
  local file="$1"
  shift
  [ -r "$file" ] || die "cannot read $file"
  local key line value
  for key in "$@"; do
    line="$(grep -E "^${key}=" "$file" | tail -n 1 || true)"
    [ -n "$line" ] || continue
    value="${line#*=}"
    value="${value%$'\r'}"
    case "$value" in
      \"*\")
        value="${value#\"}"
        value="${value%\"}"
        ;;
      \'*\')
        value="${value#\'}"
        value="${value%\'}"
        ;;
    esac
    printf -v "$key" '%s' "$value"
    # shellcheck disable=SC2163 # exporting the variable named by $key is intended
    export "$key"
  done
}

# Deploy state ---------------------------------------------------------------------
# deploy.state is written only by write_state (KEY=value, no spaces), so sourcing it is safe.
load_state() {
  CBI_ENV_STATE=""
  ACTIVE_COLOR=""
  CURRENT_TAG=""
  PREVIOUS_TAG=""
  API_BLUE_TAG=""
  API_GREEN_TAG=""
  WORKER_TAG=""
  WEB_TAG=""
  PREVIOUS_WEB_TAG=""
  IMAGE_REGISTRY="${IMAGE_REGISTRY:-}"
  WORKER_REPLICAS="${WORKER_REPLICAS:-}"
  DEPLOYED_AT=""
  if [ -f "$STATE_FILE" ]; then
    # shellcheck disable=SC1090 # generated file
    . "$STATE_FILE"
  fi
  IMAGE_REGISTRY="${IMAGE_REGISTRY:-$DEFAULT_IMAGE_REGISTRY}"
  WORKER_REPLICAS="${WORKER_REPLICAS:-2}"
}

write_state() {
  mkdir -p "$STATE_DIR"
  local tmp="$STATE_FILE.tmp.$$"
  {
    echo "# Written by infrastructure/scripts/deploy.sh — do not edit by hand."
    echo "CBI_ENV_STATE=$CBI_ENV"
    echo "ACTIVE_COLOR=$ACTIVE_COLOR"
    echo "CURRENT_TAG=$CURRENT_TAG"
    echo "PREVIOUS_TAG=$PREVIOUS_TAG"
    echo "API_BLUE_TAG=$API_BLUE_TAG"
    echo "API_GREEN_TAG=$API_GREEN_TAG"
    echo "WORKER_TAG=$WORKER_TAG"
    echo "WEB_TAG=$WEB_TAG"
    echo "PREVIOUS_WEB_TAG=$PREVIOUS_WEB_TAG"
    echo "IMAGE_REGISTRY=$IMAGE_REGISTRY"
    echo "WORKER_REPLICAS=$WORKER_REPLICAS"
    echo "DEPLOYED_AT=$DEPLOYED_AT"
  } >"$tmp"
  chmod 640 "$tmp"
  mv -f "$tmp" "$STATE_FILE"
}

# Interpolation variables for docker compose (never secrets).
write_compose_env() {
  mkdir -p "$STATE_DIR"
  local tmp="$COMPOSE_ENV_FILE.tmp.$$"
  {
    echo "CBI_HOME=$CBI_HOME"
    echo "CBI_ENV=$CBI_ENV"
    echo "IMAGE_REGISTRY=$IMAGE_REGISTRY"
    echo "IMAGE_TAG=${CURRENT_TAG:-${1:-unset}}"
    echo "API_BLUE_TAG=$API_BLUE_TAG"
    echo "API_GREEN_TAG=$API_GREEN_TAG"
    echo "WORKER_TAG=$WORKER_TAG"
    echo "WORKER_REPLICAS=$WORKER_REPLICAS"
  } >"$tmp"
  mv -f "$tmp" "$COMPOSE_ENV_FILE"
}

# COMPOSE_OVERRIDE_FILE (optional) adds a second -f file, e.g. other host ports for a
# local rehearsal. Not used on the servers.
dc() {
  local files=(-f "$COMPOSE_FILE_PATH")
  if [ -n "${COMPOSE_OVERRIDE_FILE:-}" ]; then files+=(-f "$COMPOSE_OVERRIDE_FILE"); fi
  docker compose "${files[@]}" --env-file "$COMPOSE_ENV_FILE" "$@"
}

other_color() {
  case "$1" in
    blue) echo green ;;
    green) echo blue ;;
    *) echo blue ;;
  esac
}

valid_tag() {
  [[ "$1" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$ ]]
}

valid_env() {
  case "$1" in
    staging | production) return 0 ;;
    *) return 1 ;;
  esac
}

# Web images are built per environment (VITE_API_URL is baked in at build time).
web_tag_for() {
  local tag="$1" env="$2"
  if [ "$env" = production ]; then echo "$tag"; else echo "$tag-$env"; fi
}

# Public hostnames per environment (keep in sync with infrastructure/nginx/sites/*.conf).
hostnames_for() {
  case "$1" in
    production) echo "interview.codebegun.com admin.interview.codebegun.com api.interview.codebegun.com" ;;
    staging) echo "interview-staging.codebegun.com admin.interview-staging.codebegun.com api.interview-staging.codebegun.com" ;;
    *) die "unknown environment: $1" ;;
  esac
}

# Health of a container by compose service name: healthy|unhealthy|starting|missing
service_health() {
  local id
  id="$(dc ps -q "$1" 2>/dev/null | head -n 1)"
  [ -n "$id" ] || {
    echo missing
    return 0
  }
  docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$id" 2>/dev/null || echo missing
}

# Optional alert hook: POSTs a short message to $1 (URL) when set.
send_alert() {
  local url="$1" message="$2"
  [ -n "$url" ] || return 0
  curl -fsS -m 10 -X POST -H 'Content-Type: text/plain' --data "$message" "$url" >/dev/null 2>&1 ||
    warn "alert delivery to the configured URL failed"
}

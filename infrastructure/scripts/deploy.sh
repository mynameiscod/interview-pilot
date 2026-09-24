#!/usr/bin/env bash
# Blue/green deploy of CareerPilot Interview on one VPS.
#
# Usage:
#   deploy.sh <image-tag> [--env staging|production] [--registry ghcr.io/org/repo]
#             [--skip-pull] [--skip-workers] [--ready-timeout 240]
#
#   deploy.sh v1.4.0 --env production
#
# What it does (design §14 "zero-downtime deploy"):
#   1. pulls api/worker/web images for <image-tag> (web: <tag>-staging on staging)
#   2. starts MongoDB/Redis if needed and runs the idempotent mongo-init job
#   3. extracts both SPAs from their images into $CBI_HOME/www/<app>/releases/<tag>
#   4. starts the IDLE API colour with the new tag. The API itself creates indexes
#      and seeds catalogues on start (ensureIndexes/ensure*), so there is no separate
#      migration step; changes must stay backward compatible with the old colour.
#   5. waits until the idle colour's /readyz passes over the Docker network
#   6. rewrites $CBI_HOME/nginx/upstream-api.conf, `nginx -t`, `nginx -s reload`
#   7. switches the SPA `current` symlinks (the old release stays as `previous`)
#   8. SIGTERMs the old colour: it stops accepting sockets, emits server:draining and
#      finishes in-flight turns (SHUTDOWN_GRACE_MS=60 s, docker stop timeout 75 s)
#   9. recreates the workers on the new tag (each finishes its active job first)
#  10. records CURRENT_TAG/PREVIOUS_TAG in $CBI_HOME/state/deploy.state
#
# Rollback: rollback.sh (redeploys PREVIOUS_TAG the same way). Status: status.sh.
# Environment: CBI_HOME (default /srv/cbi), APP_DIR (default: this checkout).
set -euo pipefail

CBI_SCRIPT=deploy
# shellcheck source=lib/common.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib/common.sh"

usage() {
  sed -n '2,/^set -euo/p' "${BASH_SOURCE[0]}" | sed -e '$d' -e 's/^# \{0,1\}//'
  exit "${1:-0}"
}

TAG=""
CBI_ENV="${CBI_ENV:-}"
SKIP_PULL=0
SKIP_WORKERS=0
READY_TIMEOUT="${READY_TIMEOUT:-240}"
OLD_COLOR_STOP_TIMEOUT="${OLD_COLOR_STOP_TIMEOUT:-75}"
REGISTRY_ARG=""
KEEP_WEB_RELEASES="${KEEP_WEB_RELEASES:-5}"

while [ $# -gt 0 ]; do
  case "$1" in
    --env)
      CBI_ENV="${2:-}"
      shift 2
      ;;
    --registry)
      REGISTRY_ARG="${2:-}"
      shift 2
      ;;
    --skip-pull)
      SKIP_PULL=1
      shift
      ;;
    --skip-workers)
      SKIP_WORKERS=1
      shift
      ;;
    --ready-timeout)
      READY_TIMEOUT="${2:-}"
      shift 2
      ;;
    -h | --help) usage 0 ;;
    -*) die "unknown option: $1 (see --help)" ;;
    *)
      [ -z "$TAG" ] || die "only one image tag may be given"
      TAG="$1"
      shift
      ;;
  esac
done

[ -n "$TAG" ] || usage 2
valid_tag "$TAG" || die "invalid image tag: $TAG"
require_cmd docker flock

mkdir -p "$STATE_DIR"
exec 9>"$STATE_DIR/deploy.lock"
flock -n 9 || die "another deploy is running (lock: $STATE_DIR/deploy.lock)"

load_state
CBI_ENV="${CBI_ENV:-${CBI_ENV_STATE:-production}}"
valid_env "$CBI_ENV" || die "--env must be staging or production"
if [ -n "$CBI_ENV_STATE" ] && [ "$CBI_ENV_STATE" != "$CBI_ENV" ]; then
  die "this host is a $CBI_ENV_STATE host (state file); refusing to deploy --env $CBI_ENV"
fi
[ -n "$REGISTRY_ARG" ] && IMAGE_REGISTRY="$REGISTRY_ARG"

APP_ENV_FILE="$CBI_HOME/.env.$CBI_ENV"
[ -f "$APP_ENV_FILE" ] || die "missing $APP_ENV_FILE (template: infrastructure/env/production.env.example)"
[ -f "$CBI_HOME/.env.datastores" ] || die "missing $CBI_HOME/.env.datastores"
[ -f "$CBI_HOME/secrets/mongo-keyfile" ] || die "missing $CBI_HOME/secrets/mongo-keyfile"
grep -q '^APP_ENV='"$CBI_ENV"'$' "$APP_ENV_FILE" || die "$APP_ENV_FILE must set APP_ENV=$CBI_ENV"
# Template placeholders are long enough to pass the app's secret-length checks: refuse them here.
for f in "$APP_ENV_FILE" "$CBI_HOME/.env.datastores"; do
  if grep -Eq '^[^#]*REPLACE_WITH_' "$f"; then
    die "$f still contains REPLACE_WITH_* placeholders: $(grep -Eo '^[A-Z0-9_]+=[^#]*REPLACE_WITH_' "$f" | cut -d= -f1 | tr '\n' ' ')"
  fi
done
mkdir -p "$NGINX_STATE_DIR" "$WWW_DIR" "$CBI_HOME/letsencrypt" "$CBI_HOME/certbot-www"
[ -f "$NGINX_STATE_DIR/staging-allowlist.conf" ] || : >"$NGINX_STATE_DIR/staging-allowlist.conf"
[ -f "$NGINX_STATE_DIR/htpasswd" ] || : >"$NGINX_STATE_DIR/htpasswd"
[ -f "$CBI_HOME/letsencrypt/live/cbi/fullchain.pem" ] ||
  die "no TLS certificate yet: run infrastructure/scripts/certs.sh issue --env $CBI_ENV first"

OLD_COLOR="$ACTIVE_COLOR"
NEW_COLOR="$(other_color "$OLD_COLOR")"
OLD_TAG="$CURRENT_TAG"
NEW_WEB_TAG="$(web_tag_for "$TAG" "$CBI_ENV")"
FIRST_DEPLOY=0
[ -n "$OLD_COLOR" ] || FIRST_DEPLOY=1

log "deploying $TAG to $CBI_ENV: ${OLD_COLOR:-none} ($OLD_TAG) -> $NEW_COLOR"
if [ "$TAG" = "$OLD_TAG" ]; then
  warn "$TAG is already the current tag; redeploying it to the idle colour"
fi

# Tags for this run: the idle colour gets the new tag, everything else keeps its own.
if [ "$NEW_COLOR" = blue ]; then API_BLUE_TAG="$TAG"; else API_GREEN_TAG="$TAG"; fi
API_BLUE_TAG="${API_BLUE_TAG:-$TAG}"
API_GREEN_TAG="${API_GREEN_TAG:-$TAG}"
PREVIOUS_WORKER_TAG="$WORKER_TAG"
WORKER_TAG="${WORKER_TAG:-$TAG}"
write_compose_env "$TAG"

web_image() { echo "$IMAGE_REGISTRY/$1-web:$NEW_WEB_TAG"; }

# 1. Pull -------------------------------------------------------------------------------
# A failed pull is tolerated when the image is already on the host (e.g. rolling back
# to the previous tag while the registry is unavailable).
pull_image() {
  if docker pull -q "$1" >/dev/null 2>&1; then return 0; fi
  if docker image inspect "$1" >/dev/null 2>&1; then
    warn "pull failed for $1; using the copy already on this host"
    return 0
  fi
  die "cannot pull $1 and it is not present locally (docker login ghcr.io? tag pushed?)"
}
if [ "$SKIP_PULL" -eq 0 ]; then
  log "pulling images"
  pull_image "$IMAGE_REGISTRY/api:$TAG"
  pull_image "$IMAGE_REGISTRY/worker:$TAG"
  pull_image "$(web_image candidate)"
  pull_image "$(web_image admin)"
  dc pull -q mongo redis nginx certbot || warn "could not refresh infrastructure images; using local copies"
fi
for img in "$IMAGE_REGISTRY/api:$TAG" "$IMAGE_REGISTRY/worker:$TAG" "$(web_image candidate)" "$(web_image admin)"; do
  docker image inspect "$img" >/dev/null 2>&1 || die "image not found: $img"
done

# 2. Data stores -----------------------------------------------------------------------------
log "starting mongo and redis"
dc up -d --wait --wait-timeout 180 mongo redis
log "running mongo-init (replica set + users, idempotent)"
dc run --rm --no-deps -T mongo-init

# 3. SPA releases -------------------------------------------------------------------------------
extract_spa() {
  local app="$1" image dest tmp cid
  image="$(web_image "$app")"
  dest="$WWW_DIR/$app/releases/$TAG"
  if [ -f "$dest/index.html" ]; then
    log "$app release $TAG already extracted"
    return 0
  fi
  mkdir -p "$WWW_DIR/$app/releases"
  tmp="$(mktemp -d "$WWW_DIR/$app/releases/.tmp.XXXXXX")"
  cid="$(docker create "$image")"
  if ! docker cp "$cid:/usr/share/nginx/html/." "$tmp/"; then
    docker rm -f "$cid" >/dev/null
    rm -rf "$tmp"
    die "could not extract static files from $image"
  fi
  docker rm -f "$cid" >/dev/null
  [ -f "$tmp/index.html" ] || die "$image has no index.html"
  chmod -R a+rX "$tmp"
  rm -rf "$dest"
  mv "$tmp" "$dest"
  log "$app release $TAG extracted"
}
extract_spa candidate
extract_spa admin

# 4. Start the idle colour ----------------------------------------------------------------------
log "starting api-$NEW_COLOR on $TAG"
dc up -d --no-deps --force-recreate "api-$NEW_COLOR"

# 5. Wait for readiness over the Docker network --------------------------------------------------
nginx_running() { [ "$(service_health nginx)" = healthy ]; }

probe_ready() {
  local color="$1"
  if nginx_running; then
    dc exec -T nginx wget -q -T 3 -O /dev/null "http://api-$color:4000/readyz" 2>/dev/null
  else
    dc exec -T "api-$color" wget -q -T 3 -O /dev/null "http://127.0.0.1:4000/readyz" 2>/dev/null
  fi
}

log "waiting up to ${READY_TIMEOUT}s for api-$NEW_COLOR /readyz"
deadline=$((SECONDS + READY_TIMEOUT))
until probe_ready "$NEW_COLOR" && [ "$(service_health "api-$NEW_COLOR")" = healthy ]; do
  if [ "$SECONDS" -ge "$deadline" ]; then
    warn "api-$NEW_COLOR did not become ready; last log lines:"
    dc logs --no-color --tail 60 "api-$NEW_COLOR" >&2 || true
    dc stop -t 30 "api-$NEW_COLOR" >/dev/null 2>&1 || true
    die "deploy aborted; traffic is still on ${OLD_COLOR:-nothing} ($OLD_TAG)"
  fi
  sleep 3
done
log "api-$NEW_COLOR is ready"

# 6. Swap the NGINX upstream ---------------------------------------------------------------------------
UPSTREAM_FILE="$NGINX_STATE_DIR/upstream-api.conf"
write_upstream() {
  local color="$1" tmp="$UPSTREAM_FILE.tmp.$$"
  cat >"$tmp" <<EOF
# Managed by infrastructure/scripts/deploy.sh — active colour: $color ($(_ts))
upstream cbi_api {
  ip_hash;
  server api-$color:4000 max_fails=3 fail_timeout=10s;
  keepalive 64;
}
EOF
  chmod 644 "$tmp"
  mv -f "$tmp" "$UPSTREAM_FILE"
}

# Runs an nginx command in the container. Hides the expected "ssl_stapling ignored"
# warning (Let's Encrypt certificates carry no OCSP URL since 2025) and the reload notice.
nginx_exec() {
  local out rc=0
  out="$(dc exec -T nginx "$@" 2>&1)" || rc=$?
  printf '%s\n' "$out" | grep -v -e 'ssl_stapling' -e 'signal process started' -e '^$' >&2 || true
  return "$rc"
}

BACKUP_UPSTREAM=""
if [ -f "$UPSTREAM_FILE" ]; then
  BACKUP_UPSTREAM="$UPSTREAM_FILE.bak"
  cp -f "$UPSTREAM_FILE" "$BACKUP_UPSTREAM"
fi
write_upstream "$NEW_COLOR"

if nginx_running; then
  if ! nginx_exec nginx -t -q; then
    [ -n "$BACKUP_UPSTREAM" ] && mv -f "$BACKUP_UPSTREAM" "$UPSTREAM_FILE"
    dc stop -t 30 "api-$NEW_COLOR" >/dev/null 2>&1 || true
    die "nginx -t failed; upstream restored, traffic still on ${OLD_COLOR:-nothing}"
  fi
  nginx_exec nginx -s reload
  log "nginx reloaded: traffic -> api-$NEW_COLOR"
else
  log "starting nginx and certbot"
  dc up -d --no-deps nginx certbot
  deadline=$((SECONDS + 60))
  until nginx_running; do
    [ "$SECONDS" -lt "$deadline" ] || {
      dc logs --no-color --tail 40 nginx >&2 || true
      die "nginx did not become healthy"
    }
    sleep 2
  done
fi

# 7. Switch SPA releases -----------------------------------------------------------------------------
switch_spa() {
  local app="$1" base="$WWW_DIR/$1" old_target
  old_target="$(readlink "$base/current" 2>/dev/null || true)"
  if [ -n "$old_target" ] && [ "$old_target" != "releases/$TAG" ]; then
    ln -sfn "$old_target" "$base/previous.tmp" && mv -Tf "$base/previous.tmp" "$base/previous"
  fi
  ln -sfn "releases/$TAG" "$base/current.tmp" && mv -Tf "$base/current.tmp" "$base/current"
  [ -e "$base/previous" ] || ln -sfn "releases/$TAG" "$base/previous"
  log "$app: current -> releases/$TAG"
}
switch_spa candidate
switch_spa admin

# 8. Drain the old colour ------------------------------------------------------------------------------
if [ "$FIRST_DEPLOY" -eq 0 ] && [ "$(service_health "api-$OLD_COLOR")" != missing ]; then
  log "stopping api-$OLD_COLOR (SIGTERM, up to ${OLD_COLOR_STOP_TIMEOUT}s to drain)"
  dc stop -t "$OLD_COLOR_STOP_TIMEOUT" "api-$OLD_COLOR"
fi

# 9. Workers ----------------------------------------------------------------------------------------------
if [ "$SKIP_WORKERS" -eq 0 ]; then
  WORKER_TAG="$TAG"
  write_compose_env "$TAG"
  log "recreating workers on $TAG (x$WORKER_REPLICAS; each finishes its active job first)"
  dc up -d --no-deps --scale "worker=$WORKER_REPLICAS" worker
  deadline=$((SECONDS + 240))
  while :; do
    unhealthy=0
    for id in $(dc ps -q worker); do
      [ "$(docker inspect -f '{{.State.Health.Status}}' "$id")" = healthy ] || unhealthy=$((unhealthy + 1))
    done
    [ "$unhealthy" -eq 0 ] && break
    [ "$SECONDS" -lt "$deadline" ] || die "workers not healthy after 240s (API is already on $TAG; check: dc logs worker)"
    sleep 3
  done
  log "workers healthy"
else
  WORKER_TAG="${PREVIOUS_WORKER_TAG:-$TAG}"
fi

# 10. Record state ----------------------------------------------------------------------------------------
if [ -n "$OLD_TAG" ] && [ "$OLD_TAG" != "$TAG" ]; then
  PREVIOUS_TAG="$OLD_TAG"
  PREVIOUS_WEB_TAG="${WEB_TAG:-}"
fi
ACTIVE_COLOR="$NEW_COLOR"
CURRENT_TAG="$TAG"
WEB_TAG="$NEW_WEB_TAG"
DEPLOYED_AT="$(_ts)"
write_state
write_compose_env "$TAG"
printf '%s env=%s tag=%s color=%s previous=%s\n' "$DEPLOYED_AT" "$CBI_ENV" "$TAG" "$NEW_COLOR" "${PREVIOUS_TAG:-none}" >>"$HISTORY_FILE"
rm -f "$BACKUP_UPSTREAM"

# Housekeeping: keep the newest $KEEP_WEB_RELEASES SPA releases (never current/previous).
for app in candidate admin; do
  keep_current="$(readlink "$WWW_DIR/$app/current" || true)"
  keep_previous="$(readlink "$WWW_DIR/$app/previous" || true)"
  # shellcheck disable=SC2012 # release names are plain tags
  ls -1t "$WWW_DIR/$app/releases" 2>/dev/null | tail -n +"$((KEEP_WEB_RELEASES + 1))" | while read -r old; do
    [ "releases/$old" = "$keep_current" ] || [ "releases/$old" = "$keep_previous" ] || rm -rf "${WWW_DIR:?}/$app/releases/$old"
  done
done
docker image prune -f >/dev/null 2>&1 || true

log "deploy complete: $CBI_ENV is on $TAG (api-$NEW_COLOR); previous tag: ${PREVIOUS_TAG:-none}"

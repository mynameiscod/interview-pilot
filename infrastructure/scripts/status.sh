#!/usr/bin/env bash
# Shows what is deployed and whether it is healthy.
#
# Usage:
#   status.sh [--json]
#
# Prints: environment, active colour, current/previous tags, container health
# (nginx, api-blue, api-green, workers, mongo, redis), the live NGINX upstream,
# the active colour's /readyz body, SPA releases, disk usage and the last deploys.
# Exit code: 0 when the active colour, nginx, mongo, redis and all workers are
# healthy; 1 otherwise (usable from monitoring).
set -euo pipefail

CBI_SCRIPT=status
# shellcheck source=lib/common.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib/common.sh"

JSON=0
case "${1:-}" in
  --json) JSON=1 ;;
  -h | --help)
    sed -n '2,/^set -euo/p' "${BASH_SOURCE[0]}" | sed -e '$d' -e 's/^# \{0,1\}//'
    exit 0
    ;;
  "") ;;
  *) die "unknown argument: $1" ;;
esac

load_state
[ -f "$COMPOSE_ENV_FILE" ] || die "no $COMPOSE_ENV_FILE: nothing deployed on this host yet"
CBI_ENV="${CBI_ENV_STATE:-production}"

ok=1
health_of() {
  local h
  h="$(service_health "$1")"
  echo "$h"
}

nginx_h="$(health_of nginx)"
blue_h="$(health_of api-blue)"
green_h="$(health_of api-green)"
mongo_h="$(health_of mongo)"
redis_h="$(health_of redis)"
active_h="missing"
[ -n "$ACTIVE_COLOR" ] && active_h="$(health_of "api-$ACTIVE_COLOR")"

workers_total=0
workers_healthy=0
for id in $(dc ps -q worker 2>/dev/null); do
  workers_total=$((workers_total + 1))
  [ "$(docker inspect -f '{{.State.Health.Status}}' "$id" 2>/dev/null)" = healthy ] &&
    workers_healthy=$((workers_healthy + 1))
done

for h in "$nginx_h" "$active_h" "$mongo_h" "$redis_h"; do
  [ "$h" = healthy ] || ok=0
done
{ [ "$workers_total" -gt 0 ] && [ "$workers_healthy" -eq "$workers_total" ]; } || ok=0

readyz=""
if [ -n "$ACTIVE_COLOR" ] && [ "$nginx_h" = healthy ]; then
  readyz="$(dc exec -T nginx wget -q -T 3 -O - "http://api-$ACTIVE_COLOR:4000/readyz" 2>/dev/null || echo unavailable)"
fi
upstream="$(grep -Eo 'api-(blue|green)' "$NGINX_STATE_DIR/upstream-api.conf" 2>/dev/null | head -n 1 || true)"

if [ "$JSON" -eq 1 ]; then
  printf '{"env":"%s","activeColor":"%s","upstream":"%s","currentTag":"%s","previousTag":"%s","deployedAt":"%s",' \
    "$CBI_ENV" "$ACTIVE_COLOR" "$upstream" "$CURRENT_TAG" "$PREVIOUS_TAG" "$DEPLOYED_AT"
  printf '"health":{"nginx":"%s","api-blue":"%s","api-green":"%s","mongo":"%s","redis":"%s","workers":"%s/%s"},"ok":%s}\n' \
    "$nginx_h" "$blue_h" "$green_h" "$mongo_h" "$redis_h" "$workers_healthy" "$workers_total" \
    "$([ "$ok" -eq 1 ] && echo true || echo false)"
else
  echo "Environment : $CBI_ENV"
  echo "Current tag : ${CURRENT_TAG:-none}   (deployed ${DEPLOYED_AT:-never})"
  echo "Previous tag: ${PREVIOUS_TAG:-none}   (rollback target)"
  echo "Active      : api-${ACTIVE_COLOR:-none}   NGINX upstream -> ${upstream:-unknown}"
  echo
  printf '%-12s %-10s %s\n' SERVICE HEALTH TAG
  printf '%-12s %-10s %s\n' nginx "$nginx_h" -
  printf '%-12s %-10s %s\n' api-blue "$blue_h" "${API_BLUE_TAG:--}"
  printf '%-12s %-10s %s\n' api-green "$green_h" "${API_GREEN_TAG:--}"
  printf '%-12s %-10s %s\n' worker "$workers_healthy/$workers_total" "${WORKER_TAG:--}"
  printf '%-12s %-10s %s\n' mongo "$mongo_h" -
  printf '%-12s %-10s %s\n' redis "$redis_h" -
  echo
  echo "readyz (api-${ACTIVE_COLOR:-?}): ${readyz:-n/a}"
  echo
  for app in candidate admin; do
    echo "SPA $app: current -> $(readlink "$WWW_DIR/$app/current" 2>/dev/null || echo none), previous -> $(readlink "$WWW_DIR/$app/previous" 2>/dev/null || echo none)"
  done
  echo
  df -h "$CBI_HOME" /var/lib/docker 2>/dev/null | awk 'NR==1 || !seen[$0]++' || true
  echo
  echo "Last deploys:"
  tail -n 5 "$HISTORY_FILE" 2>/dev/null || echo "  (none)"
  echo
  [ "$ok" -eq 1 ] && echo "STATUS: OK" || echo "STATUS: DEGRADED"
fi

[ "$ok" -eq 1 ]

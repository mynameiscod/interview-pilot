#!/usr/bin/env bash
# Let's Encrypt certificate for one environment: a single SAN certificate named `cbi`
# covering the candidate, admin and API hostnames (see infrastructure/nginx/sites/*.conf).
#
# Usage:
#   certs.sh issue --env staging|production --email ops@codebegun.com [--test-cert]
#   certs.sh renew            # force a renewal check now (the certbot service also runs it every 12 h)
#   certs.sh show
#
# `issue` works before the first deploy: when NGINX is not running it uses certbot's
# standalone server on port 80; afterwards it uses the webroot served by NGINX.
# --test-cert uses the Let's Encrypt staging CA (untrusted; for rehearsals).
# After issuing, files are made group-readable for uid/gid 101 (nginx-unprivileged).
set -euo pipefail

CBI_SCRIPT=certs
# shellcheck source=lib/common.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib/common.sh"

CMD="${1:-}"
[ $# -gt 0 ] && shift
CBI_ENV="${CBI_ENV:-}"
EMAIL=""
TEST_CERT=()
while [ $# -gt 0 ]; do
  case "$1" in
    --env)
      CBI_ENV="${2:-}"
      shift 2
      ;;
    --email)
      EMAIL="${2:-}"
      shift 2
      ;;
    --test-cert)
      TEST_CERT=(--test-cert)
      shift
      ;;
    *) die "unknown argument: $1" ;;
  esac
done

load_state
CBI_ENV="${CBI_ENV:-${CBI_ENV_STATE:-}}"
valid_env "$CBI_ENV" || die "--env staging|production is required"
LE_DIR="$CBI_HOME/letsencrypt"
WEBROOT="$CBI_HOME/certbot-www"
CERTBOT_IMAGE="${CERTBOT_IMAGE:-certbot/certbot:v4.1.1}"
mkdir -p "$LE_DIR" "$WEBROOT"

# certbot writes root-owned files (0700 directories), which the deploy user cannot
# change, so the permissions are fixed from a short-lived root container.
fix_permissions() {
  docker run --rm --entrypoint sh -v "$LE_DIR:/etc/letsencrypt" "$CERTBOT_IMAGE" -c '
    if [ -d /etc/letsencrypt/archive ]; then
      chgrp -R 101 /etc/letsencrypt/live /etc/letsencrypt/archive
      chmod -R g+rX,o-rwx /etc/letsencrypt/live /etc/letsencrypt/archive
    fi'
}

nginx_up() {
  [ -f "$COMPOSE_ENV_FILE" ] && [ "$(service_health nginx)" = healthy ]
}

case "$CMD" in
  issue)
    [ -n "$EMAIL" ] || die "--email is required (expiry notices)"
    domains=()
    for h in $(hostnames_for "$CBI_ENV"); do domains+=(-d "$h"); done
    # A certificate from a --test-cert rehearsal is not "due", so certbot would keep it:
    # replace it when a trusted certificate is requested.
    replace=()
    if [ "${#TEST_CERT[@]}" -eq 0 ] &&
      docker run --rm --entrypoint sh -v "$LE_DIR:/etc/letsencrypt" "$CERTBOT_IMAGE" \
        -c 'grep -qs acme-staging /etc/letsencrypt/renewal/cbi.conf'; then
      log "replacing the test certificate with a trusted one"
      replace=(--force-renewal --break-my-certs)
    fi
    if nginx_up; then
      log "issuing via webroot (nginx is running)"
      docker run --rm -v "$LE_DIR:/etc/letsencrypt" -v "$WEBROOT:/var/www/certbot" "$CERTBOT_IMAGE" \
        certonly --webroot -w /var/www/certbot --cert-name cbi "${domains[@]}" \
        --email "$EMAIL" --agree-tos --no-eff-email --non-interactive --keep-until-expiring \
        --expand "${TEST_CERT[@]}" "${replace[@]}"
    else
      log "issuing via standalone server on port 80 (nginx not running yet)"
      docker run --rm -p 80:80 -v "$LE_DIR:/etc/letsencrypt" "$CERTBOT_IMAGE" \
        certonly --standalone --cert-name cbi "${domains[@]}" \
        --email "$EMAIL" --agree-tos --no-eff-email --non-interactive --keep-until-expiring \
        --expand "${TEST_CERT[@]}" "${replace[@]}"
    fi
    # Renewals always pass --webroot on the command line (certbot service, `renew`
    # below), which overrides the standalone authenticator saved at first issuance.
    fix_permissions
    if nginx_up; then dc exec -T nginx nginx -s reload; fi
    log "certificate ready: $LE_DIR/live/cbi (domains: $(hostnames_for "$CBI_ENV"))"
    ;;
  renew)
    nginx_up || die "nginx must be running for webroot renewal"
    dc exec -T certbot certbot renew --webroot -w /var/www/certbot
    fix_permissions
    dc exec -T nginx nginx -s reload
    ;;
  show)
    docker run --rm -v "$LE_DIR:/etc/letsencrypt" "$CERTBOT_IMAGE" certificates
    ;;
  *)
    sed -n '2,/^set -euo/p' "${BASH_SOURCE[0]}" | sed -e '$d' -e 's/^# \{0,1\}//'
    exit 2
    ;;
esac

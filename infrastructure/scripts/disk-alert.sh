#!/usr/bin/env bash
# Disk-usage alert (design §14 "disk alerts"). Installed by provision.sh to
# /usr/local/sbin/cbi-disk-alert and run every 15 minutes by cbi-disk-alert.timer.
#
# Usage:
#   disk-alert.sh [--threshold 80] [--paths "/ /var/lib/docker /srv/cbi"]
#
# Logs to syslog/journald (tag cbi-disk-alert) at warning level when a filesystem is
# above the threshold (or its inodes are), and POSTs to DISK_ALERT_URL when set in
# /etc/default/cbi-disk-alert. Also mails ALERT_EMAIL if `mail` is available.
# Exit: 0 when all filesystems are below the threshold, 1 otherwise.
set -euo pipefail

THRESHOLD=80
PATHS="/ /var/lib/docker /srv/cbi"
DISK_ALERT_URL=""
ALERT_EMAIL=""
# shellcheck disable=SC1091 # optional host config
[ -r /etc/default/cbi-disk-alert ] && . /etc/default/cbi-disk-alert

while [ $# -gt 0 ]; do
  case "$1" in
    --threshold)
      THRESHOLD="${2:-}"
      shift 2
      ;;
    --paths)
      PATHS="${2:-}"
      shift 2
      ;;
    -h | --help)
      sed -n '2,/^set -euo/p' "${BASH_SOURCE[0]}" | sed -e '$d' -e 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "unknown argument: $1" >&2
      exit 2
      ;;
  esac
done

problems=""
for p in $PATHS; do
  [ -e "$p" ] || continue
  used="$(df -P "$p" | awk 'NR==2 {gsub("%","",$5); print $5}')"
  inodes="$(df -Pi "$p" | awk 'NR==2 {gsub("%","",$5); print $5}')"
  [ "$inodes" = "-" ] && inodes=0
  if [ "${used:-0}" -ge "$THRESHOLD" ] || [ "${inodes:-0}" -ge "$THRESHOLD" ]; then
    problems="${problems}$p: ${used}% space, ${inodes}% inodes used; "
  fi
done

if [ -n "$problems" ]; then
  msg="CareerPilot disk alert on $(hostname): ${problems}threshold ${THRESHOLD}%"
  logger -t cbi-disk-alert -p user.warning "$msg" 2>/dev/null || echo "$msg" >&2
  if [ -n "$DISK_ALERT_URL" ]; then
    curl -fsS -m 10 -X POST -H 'Content-Type: text/plain' --data "$msg" "$DISK_ALERT_URL" >/dev/null || true
  fi
  if [ -n "$ALERT_EMAIL" ] && command -v mail >/dev/null 2>&1; then
    echo "$msg" | mail -s "Disk alert: $(hostname)" "$ALERT_EMAIL" || true
  fi
  exit 1
fi
exit 0

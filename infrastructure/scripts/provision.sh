#!/usr/bin/env bash
# One-time hardening + setup of a fresh Ubuntu 24.04 VPS for CareerPilot Interview.
# Run as root from a copy of the repository (or of docker-compose.production.yml +
# infrastructure/), e.g.:
#   scp -r docker-compose.production.yml infrastructure root@VPS:/root/cbi/
#   ssh root@VPS 'bash /root/cbi/infrastructure/scripts/provision.sh \
#       --env production --ssh-key-file /root/.ssh/authorized_keys --admin-user ops'
#
# Options:
#   --env staging|production   environment this host runs (one per VPS)          [required]
#   --ssh-key-file FILE        public key(s) for the deploy (and admin) user       [required]
#   --deploy-user NAME         user GitHub Actions connects as (default: deploy; docker group)
#   --admin-user NAME          optional human operator with sudo (key only)
#   --swap-gb N                swap file size when the host has none (default 4)
#   --alert-email ADDR         disk alerts are mailed here if a local MTA exists
#   --skip-ssh-hardening       do not change sshd (e.g. when testing in a VM)
#
# Idempotent: safe to re-run; existing files under /srv/cbi (env files, secrets,
# certificates, state) are never overwritten.
#
# What it does: apt upgrade; time sync (chrony, UTC); deploy/admin users with SSH keys
# only; sshd without passwords or root login; ufw (22/80/443 only); fail2ban (sshd +
# NGINX rate-limit offenders, banned in the DOCKER-USER chain); unattended security
# upgrades; Docker Engine + compose plugin from Docker's apt repo with log rotation and
# live-restore; swap; sysctl/ulimit tuning for many WebSocket connections and
# MongoDB/Redis; /srv/cbi layout, MongoDB keyfile, env templates; disk alert timer;
# backup/restore-drill systemd units (enabled later, once .env.backup is filled in).
set -euo pipefail

CBI_SCRIPT=provision
# shellcheck source=lib/common.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib/common.sh"

ENV_NAME=""
SSH_KEY_FILE=""
DEPLOY_USER=deploy
ADMIN_USER=""
SWAP_GB=4
ALERT_EMAIL=""
HARDEN_SSH=1
while [ $# -gt 0 ]; do
  case "$1" in
    --env)
      ENV_NAME="${2:-}"
      shift 2
      ;;
    --ssh-key-file)
      SSH_KEY_FILE="${2:-}"
      shift 2
      ;;
    --deploy-user)
      DEPLOY_USER="${2:-}"
      shift 2
      ;;
    --admin-user)
      ADMIN_USER="${2:-}"
      shift 2
      ;;
    --swap-gb)
      SWAP_GB="${2:-}"
      shift 2
      ;;
    --alert-email)
      ALERT_EMAIL="${2:-}"
      shift 2
      ;;
    --skip-ssh-hardening)
      HARDEN_SSH=0
      shift
      ;;
    -h | --help)
      sed -n '2,/^set -euo/p' "${BASH_SOURCE[0]}" | sed -e '$d' -e 's/^# \{0,1\}//'
      exit 0
      ;;
    *) die "unknown argument: $1 (see --help)" ;;
  esac
done

[ "$(id -u)" -eq 0 ] || die "run as root"
valid_env "$ENV_NAME" || die "--env staging|production is required"
[ -s "$SSH_KEY_FILE" ] || die "--ssh-key-file must point to a non-empty authorized_keys file"
grep -Eq '^(ssh-ed25519|ssh-rsa|ecdsa-sha2-|sk-)' "$SSH_KEY_FILE" || die "$SSH_KEY_FILE has no SSH public keys"
[[ "$DEPLOY_USER" =~ ^[a-z_][a-z0-9_-]{0,31}$ ]] || die "invalid --deploy-user"
[ -z "$ADMIN_USER" ] || [[ "$ADMIN_USER" =~ ^[a-z_][a-z0-9_-]{0,31}$ ]] || die "invalid --admin-user"
[[ "$SWAP_GB" =~ ^[0-9]+$ ]] || die "invalid --swap-gb"
# shellcheck disable=SC1091
. /etc/os-release
[ "${ID:-}" = ubuntu ] || die "this script targets Ubuntu (found ${ID:-unknown})"
[ "${VERSION_ID:-}" = "24.04" ] || warn "tested on Ubuntu 24.04; this is ${VERSION_ID:-unknown}"

export DEBIAN_FRONTEND=noninteractive
TARGET_APP_DIR="$CBI_HOME/app"

# 1. Packages + time ------------------------------------------------------------------------
log "updating packages"
apt-get update -q
apt-get -y -q -o Dpkg::Options::=--force-confold upgrade
apt-get -y -q install ca-certificates curl gnupg ufw fail2ban unattended-upgrades \
  apt-listchanges jq age chrony util-linux apache2-utils openssl logrotate rsync
timedatectl set-timezone UTC
systemctl enable --now chrony

# 2. Users ------------------------------------------------------------------------------------
install_keys() {
  local user="$1" home
  home="$(getent passwd "$user" | cut -d: -f6)"
  install -d -m 700 -o "$user" -g "$user" "$home/.ssh"
  install -m 600 -o "$user" -g "$user" "$SSH_KEY_FILE" "$home/.ssh/authorized_keys"
}
if ! id "$DEPLOY_USER" >/dev/null 2>&1; then
  log "creating user $DEPLOY_USER"
  adduser --disabled-password --gecos "CareerPilot deploy" "$DEPLOY_USER"
fi
passwd -l "$DEPLOY_USER" >/dev/null
install_keys "$DEPLOY_USER"
if [ -n "$ADMIN_USER" ]; then
  id "$ADMIN_USER" >/dev/null 2>&1 || adduser --disabled-password --gecos "CareerPilot operator" "$ADMIN_USER"
  usermod -aG sudo "$ADMIN_USER"
  install_keys "$ADMIN_USER"
  # Key-only accounts have no password, so sudo must not ask for one.
  echo "$ADMIN_USER ALL=(ALL) NOPASSWD:ALL" >"/etc/sudoers.d/90-cbi-$ADMIN_USER"
  chmod 440 "/etc/sudoers.d/90-cbi-$ADMIN_USER"
  visudo -cf "/etc/sudoers.d/90-cbi-$ADMIN_USER" >/dev/null
fi

# 3. SSH: keys only, no root -------------------------------------------------------------------
if [ "$HARDEN_SSH" -eq 1 ]; then
  log "hardening sshd"
  allow_users="$DEPLOY_USER${ADMIN_USER:+ $ADMIN_USER}"
  cat >/etc/ssh/sshd_config.d/99-cbi-hardening.conf <<EOF
# Managed by infrastructure/scripts/provision.sh
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitEmptyPasswords no
PubkeyAuthentication yes
PermitRootLogin no
AllowUsers $allow_users
MaxAuthTries 3
LoginGraceTime 30
X11Forwarding no
AllowAgentForwarding no
ClientAliveInterval 300
ClientAliveCountMax 2
EOF
  sshd -t || die "sshd config test failed; not restarting ssh"
  systemctl restart ssh || systemctl restart sshd
fi

# 4. Firewall -----------------------------------------------------------------------------------------
# Note: ports published by Docker bypass ufw. Only nginx publishes ports (80/443).
log "configuring ufw (22, 80, 443)"
ufw default deny incoming
ufw default allow outgoing
ufw limit 22/tcp comment 'ssh'
ufw allow 80/tcp comment 'http (acme + redirect)'
ufw allow 443/tcp comment 'https'
ufw --force enable

# 5. Docker Engine + compose plugin --------------------------------------------------------------------
if ! command -v docker >/dev/null 2>&1; then
  log "installing Docker Engine from Docker's apt repository"
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu ${VERSION_CODENAME} stable" \
    >/etc/apt/sources.list.d/docker.list
  apt-get update -q
  apt-get -y -q install docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
fi
mkdir -p /etc/docker
if [ ! -f /etc/docker/daemon.json ]; then
  cat >/etc/docker/daemon.json <<'EOF'
{
  "log-driver": "json-file",
  "log-opts": { "max-size": "20m", "max-file": "5" },
  "live-restore": true,
  "userland-proxy": false,
  "no-new-privileges": true,
  "default-ulimits": { "nofile": { "Name": "nofile", "Soft": 65536, "Hard": 65536 } }
}
EOF
  systemctl restart docker
else
  warn "/etc/docker/daemon.json exists; not changed (ensure log rotation is configured)"
fi
systemctl enable --now docker
usermod -aG docker "$DEPLOY_USER"

# 6. Swap ---------------------------------------------------------------------------------------------------
if [ "$SWAP_GB" -gt 0 ] && [ -z "$(swapon --show --noheadings)" ]; then
  log "creating ${SWAP_GB} GB swap file"
  fallocate -l "${SWAP_GB}G" /swapfile
  chmod 600 /swapfile
  mkswap /swapfile >/dev/null
  swapon /swapfile
  grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >>/etc/fstab
fi

# 7. Kernel + limits (many WebSockets, MongoDB, Redis) -----------------------------------------------------
cat >/etc/sysctl.d/99-cbi.conf <<'EOF'
# Managed by infrastructure/scripts/provision.sh
net.core.somaxconn = 65535
net.core.netdev_max_backlog = 16384
net.ipv4.tcp_max_syn_backlog = 8192
net.ipv4.ip_local_port_range = 1024 65535
net.ipv4.tcp_fin_timeout = 15
net.ipv4.tcp_tw_reuse = 1
net.ipv4.tcp_keepalive_time = 120
fs.file-max = 2097152
fs.nr_open = 2097152
# Redis: allow fork for AOF rewrite / RDB snapshots without failing.
vm.overcommit_memory = 1
vm.swappiness = 10
# MongoDB (WiredTiger) recommendation.
vm.max_map_count = 262144
EOF
sysctl --system >/dev/null
cat >/etc/security/limits.d/99-cbi.conf <<'EOF'
*    soft nofile 1048576
*    hard nofile 1048576
root soft nofile 1048576
root hard nofile 1048576
EOF

# 8. fail2ban -------------------------------------------------------------------------------------------------
# fail2ban refuses to start when a jail matches no log file, which would also leave the
# sshd jail down. Before the first deploy there are no container logs, so the NGINX jail
# also watches an always-present empty file.
touch /var/log/cbi-nginx-placeholder.log
chmod 640 /var/log/cbi-nginx-placeholder.log
cat >/etc/fail2ban/jail.d/cbi.local <<'EOF'
# Managed by infrastructure/scripts/provision.sh
[DEFAULT]
bantime = 1h
findtime = 10m
maxretry = 5
backend = auto

[sshd]
enabled = true
mode = aggressive
backend = systemd

# NGINX runs in Docker and logs to the json-file driver; published ports are
# forwarded through DOCKER-USER, so bans must be inserted there.
[nginx-limit-req]
enabled = true
logpath = /var/lib/docker/containers/*/*-json.log
          /var/log/cbi-nginx-placeholder.log
filter = nginx-limit-req
maxretry = 20
findtime = 5m
bantime = 30m
banaction = iptables-multiport[chain="DOCKER-USER", port="http,https", protocol=tcp]
EOF
systemctl enable fail2ban
systemctl restart fail2ban
systemctl is-active --quiet fail2ban || die "fail2ban did not start: journalctl -u fail2ban"

# 9. Unattended security upgrades (no automatic reboot: schedule reboots in a window) --------------------
cat >/etc/apt/apt.conf.d/20auto-upgrades <<'EOF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
APT::Periodic::AutocleanInterval "7";
EOF
cat >/etc/apt/apt.conf.d/52cbi-unattended-upgrades <<'EOF'
// Managed by infrastructure/scripts/provision.sh
Unattended-Upgrade::Allowed-Origins { "${distro_id}:${distro_codename}-security"; "${distro_id}ESMApps:${distro_codename}-apps-security"; "${distro_id}ESM:${distro_codename}-infra-security"; };
// Docker upgrades restart the daemon: do them by hand in a maintenance window.
Unattended-Upgrade::Package-Blacklist { "docker-ce"; "docker-ce-cli"; "containerd.io"; "docker-compose-plugin"; };
Unattended-Upgrade::Automatic-Reboot "false";
Unattended-Upgrade::Remove-Unused-Dependencies "true";
EOF
systemctl enable --now unattended-upgrades

# 10. /srv/cbi layout --------------------------------------------------------------------------------------------
log "preparing $CBI_HOME"
install -d -m 755 -o "$DEPLOY_USER" -g "$DEPLOY_USER" "$CBI_HOME" "$CBI_HOME/app" "$CBI_HOME/state" \
  "$CBI_HOME/nginx" "$CBI_HOME/www" "$CBI_HOME/certbot-www" "$CBI_HOME/letsencrypt"
install -d -m 750 -o "$DEPLOY_USER" -g "$DEPLOY_USER" "$CBI_HOME/backup"
install -d -m 700 -o "$DEPLOY_USER" -g "$DEPLOY_USER" "$CBI_HOME/secrets"
if [ "$APP_DIR" != "$TARGET_APP_DIR" ]; then
  cp -f "$APP_DIR/docker-compose.production.yml" "$TARGET_APP_DIR/"
  rm -rf "$TARGET_APP_DIR/infrastructure"
  cp -r "$APP_DIR/infrastructure" "$TARGET_APP_DIR/"
  chown -R "$DEPLOY_USER:$DEPLOY_USER" "$TARGET_APP_DIR"
fi
chmod 755 "$TARGET_APP_DIR"/infrastructure/scripts/*.sh
if [ ! -f "$CBI_HOME/secrets/mongo-keyfile" ]; then
  openssl rand -base64 756 >"$CBI_HOME/secrets/mongo-keyfile"
  chmod 400 "$CBI_HOME/secrets/mongo-keyfile"
  chown "$DEPLOY_USER:$DEPLOY_USER" "$CBI_HOME/secrets/mongo-keyfile"
  log "generated MongoDB replica-set keyfile"
fi
# Env files: root-owned, readable by the deploy group only (docker compose reads them
# client-side). Placeholders make deploy.sh refuse to start until they are replaced.
copy_template() {
  local src="$1" dest="$2"
  [ -f "$dest" ] && return 0
  install -m 640 -o root -g "$DEPLOY_USER" "$src" "$dest"
  log "created $dest from template: fill in the REPLACE_WITH_* values"
}
copy_template "$TARGET_APP_DIR/infrastructure/env/production.env.example" "$CBI_HOME/.env.$ENV_NAME"
sed -i "s/^APP_ENV=.*/APP_ENV=$ENV_NAME/" "$CBI_HOME/.env.$ENV_NAME"
copy_template "$TARGET_APP_DIR/infrastructure/env/datastores.env.example" "$CBI_HOME/.env.datastores"
copy_template "$TARGET_APP_DIR/infrastructure/env/backup.env.example" "$CBI_HOME/.env.backup"
sed -i "s/^BUNNY_BACKUP_PREFIX=.*/BUNNY_BACKUP_PREFIX=$ENV_NAME/" "$CBI_HOME/.env.backup"
for f in staging-allowlist.conf htpasswd; do
  [ -f "$CBI_HOME/nginx/$f" ] || install -m 644 -o "$DEPLOY_USER" -g "$DEPLOY_USER" /dev/null "$CBI_HOME/nginx/$f"
done
[ -f "$CBI_HOME/nginx/upstream-api.conf" ] ||
  install -m 644 -o "$DEPLOY_USER" -g "$DEPLOY_USER" "$TARGET_APP_DIR/infrastructure/nginx/upstream-api.conf" "$CBI_HOME/nginx/upstream-api.conf"
[ -f "$CBI_HOME/state/deploy.state" ] ||
  install -m 640 -o "$DEPLOY_USER" -g "$DEPLOY_USER" /dev/stdin "$CBI_HOME/state/deploy.state" <<<"CBI_ENV_STATE=$ENV_NAME"

# 11. Disk alerts + backup/drill units ---------------------------------------------------------------------------
install -m 755 "$TARGET_APP_DIR/infrastructure/scripts/disk-alert.sh" /usr/local/sbin/cbi-disk-alert
if [ ! -f /etc/default/cbi-disk-alert ]; then
  cat >/etc/default/cbi-disk-alert <<EOF
THRESHOLD=80
PATHS="/ /var/lib/docker $CBI_HOME"
# Optional webhook that receives a POST with the alert text.
DISK_ALERT_URL=
ALERT_EMAIL=$ALERT_EMAIL
EOF
fi
for unit in cbi-disk-alert.service cbi-disk-alert.timer cbi-backup.service cbi-backup.timer \
  cbi-restore-drill.service cbi-restore-drill.timer; do
  sed -e "s#/srv/cbi#$CBI_HOME#g" -e "s#^User=deploy#User=$DEPLOY_USER#" \
    "$TARGET_APP_DIR/infrastructure/systemd/$unit" >"/etc/systemd/system/$unit"
done
systemctl daemon-reload
systemctl enable --now cbi-disk-alert.timer

log "provisioning complete for $ENV_NAME"
cat <<EOF

Next steps (docs/deployment/production.md):
  1. DNS: point $(hostnames_for "$ENV_NAME") at this server.
  2. Fill in $CBI_HOME/.env.$ENV_NAME, $CBI_HOME/.env.datastores and $CBI_HOME/.env.backup
     (replace every REPLACE_WITH_* value) and $CBI_HOME/backup/age-recipients.txt.
  3. As $DEPLOY_USER: $TARGET_APP_DIR/infrastructure/scripts/certs.sh issue --env $ENV_NAME --email <ops email>
  4. As $DEPLOY_USER: docker login ghcr.io, then $TARGET_APP_DIR/infrastructure/scripts/deploy.sh <tag> --env $ENV_NAME
  5. Seed the first super admin, then: systemctl enable --now cbi-backup.timer
EOF

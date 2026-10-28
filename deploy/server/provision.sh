#!/usr/bin/env bash
#
# Phase 2: an empty Hetzner Ubuntu 24.04 server → the host Vitrina runs on.
# Idempotent: every step converges, so re-running it is how a change lands.
#
# First run, as root (the only account there is):
#   scp -r deploy/server root@<ip>:/root/vitrina-server
#   ssh -t root@<ip> bash /root/vitrina-server/provision.sh <name>
# Every later run, as the admin user (root login is gone after the first):
#   scp -r deploy/server <name>@<ip>:vitrina-server
#   ssh -t <name>@<ip> sudo bash vitrina-server/provision.sh <name>
#
# -t matters: the first run asks for the admin user's sudo password.
# Keep the first root session open until `deploy/server/check.sh` passes from
# a second terminal — sshd is reloaded under it, and an open session survives.
#
# Installs nothing of Vitrina's own: no code, no secret, no env file. Those are
# phases 4 and 5, and the API unit stays skipped until they exist.

set -euo pipefail
export DEBIAN_FRONTEND=noninteractive

here=$(cd "$(dirname "$0")" && pwd)
files="$here/files"
ADMIN_USER=${1:-}
cd / # psql as postgres warns from a home it cannot read
NODE_VERSION=v22.23.4
PG_MAJOR=15 # docker-compose.yml's postgres:15

step() { printf '\n== %s\n' "$*"; }
fail() { echo "provision: $*" >&2; exit 1; }
# Install a file; print "changed" if it did, so callers restart only then.
put() { # <src> <dest> <mode>
	if [[ -f "$2" ]] && cmp -s "$1" "$2"; then return 1; fi
	install -m "$3" -o root -g root "$1" "$2"
	echo "  wrote $2"
}

# --- preconditions -----------------------------------------------------------

[[ $EUID -eq 0 ]] || fail "run as root (sudo)"
# shellcheck source=/dev/null
. /etc/os-release
[[ "$ID" == ubuntu && "$VERSION_ID" == 24.04 ]] || fail "this is $PRETTY_NAME; the script is written for Ubuntu 24.04"
[[ "${ADMIN_USER:-}" =~ ^[a-z][a-z0-9-]{1,30}$ ]] || fail "usage: provision.sh <admin-user> (lowercase letters, digits, -)"
[[ "$ADMIN_USER" != root && "$ADMIN_USER" != vitrina ]] || fail "ADMIN_USER must not be root or the service user"
[[ -f "$here/node.sha256" ]] || fail "deploy/server/node.sha256 is missing — run deploy/server/pin-node.sh on the Mac first"

case "$(uname -m)" in
x86_64) NODE_ARCH=x64 ;;
aarch64) NODE_ARCH=arm64 ;;
*) fail "unsupported architecture $(uname -m)" ;;
esac

# --- packages ------------------------------------------------------------------

step "packages"
apt-get update -q
apt-get full-upgrade -yq
apt-get install -yq --no-install-recommends \
	ufw unattended-upgrades ca-certificates curl gnupg xz-utils \
	postgresql-common

# --- the admin user --------------------------------------------------------------

step "admin user $ADMIN_USER"
if ! id -u "$ADMIN_USER" >/dev/null 2>&1; then
	adduser --disabled-password --gecos "" "$ADMIN_USER"
fi
usermod -aG sudo "$ADMIN_USER"
home=$(getent passwd "$ADMIN_USER" | cut -d: -f6)
install -d -m 700 -o "$ADMIN_USER" -g "$ADMIN_USER" "$home/.ssh"
if [[ ! -s "$home/.ssh/authorized_keys" ]]; then
	[[ -s /root/.ssh/authorized_keys ]] || fail "no SSH key to give $ADMIN_USER: /root/.ssh/authorized_keys is empty"
	install -m 600 -o "$ADMIN_USER" -g "$ADMIN_USER" /root/.ssh/authorized_keys "$home/.ssh/authorized_keys"
	echo "  copied root's authorized key(s) to $ADMIN_USER"
fi
# A password for sudo only — SSH never accepts one. Without it, a stolen key is root.
if [[ "$(passwd -S "$ADMIN_USER" | awk '{print $2}')" != P ]]; then
	[[ -t 0 ]] || fail "$ADMIN_USER has no sudo password and there is no terminal to set one: re-run with ssh -t"
	echo "  set $ADMIN_USER's sudo password (keep it in the password manager):"
	passwd "$ADMIN_USER"
fi

# --- sshd: keys only, no root -----------------------------------------------------

step "sshd"
# Checked here, before the config that depends on them takes effect.
[[ -s "$home/.ssh/authorized_keys" ]] || fail "$ADMIN_USER has no authorized key; refusing to disable root login"
id -nG "$ADMIN_USER" | grep -qw sudo || fail "$ADMIN_USER is not in sudo; refusing to disable root login"
tmp=$(mktemp)
sed "s/__ADMIN_USER__/$ADMIN_USER/" "$files/sshd-vitrina.conf" >"$tmp"
# 24.04 starts sshd by socket activation, so its runtime directory may not exist
# yet, and `sshd -t` refuses to test without it (measured on the first run).
install -d -m 755 /run/sshd
if put "$tmp" /etc/ssh/sshd_config.d/00-vitrina.conf 644; then
	sshd -t || { rm -f /etc/ssh/sshd_config.d/00-vitrina.conf; fail "sshd rejected the config; removed it"; }
	# Reloads a running daemon; an idle socket-activated one reads the file on the next connection.
	systemctl try-reload-or-restart ssh.service
fi
rm -f "$tmp"

# --- root's key: removed once the admin path is proven -----------------------------

step "root's authorized key"
# True when this script descends from an SSH session belonging to ADMIN_USER:
# the per-session sshd process runs as the user who logged in.
admin_over_ssh() {
	local pid=$$ comm user
	while [[ "$pid" -gt 1 ]]; do
		read -r comm user < <(ps -o comm=,user= -p "$pid")
		if [[ ("$comm" == sshd || "$comm" == sshd-session) && "$user" == "$ADMIN_USER" ]]; then return 0; fi
		pid=$(ps -o ppid= -p "$pid" | tr -d ' ')
	done
	return 1
}
if [[ ! -s /root/.ssh/authorized_keys ]]; then
	echo "  none"
elif [[ "${SUDO_USER:-}" == "$ADMIN_USER" ]] && admin_over_ssh; then
	# Proven by this very run: $ADMIN_USER logged in with the key and passed sudo.
	rm -f /root/.ssh/authorized_keys
	echo "  removed — $ADMIN_USER reached root over SSH and sudo, which is now the only way in"
else
	echo "  kept for now: it is removed by a run made as $ADMIN_USER over SSH with sudo (this one is ${SUDO_USER:-root})"
fi

# --- firewall: 22, 80, 443 ----------------------------------------------------------

step "firewall"
ufw default deny incoming >/dev/null
ufw default allow outgoing >/dev/null
for port in 22/tcp 80/tcp 443/tcp; do ufw allow "$port" >/dev/null; done
ufw --force enable >/dev/null
ufw status verbose

# --- automatic security updates ---------------------------------------------------------

step "unattended upgrades"
put "$files/20auto-upgrades" /etc/apt/apt.conf.d/20auto-upgrades 644 || true
put "$files/unattended-upgrades-vitrina.conf" /etc/apt/apt.conf.d/52vitrina-unattended 644 || true
systemctl enable --now unattended-upgrades apt-daily.timer apt-daily-upgrade.timer >/dev/null

# --- journald: 14 days ------------------------------------------------------------------

step "journald"
install -d -m 755 /etc/systemd/journald.conf.d
if put "$files/journald-vitrina.conf" /etc/systemd/journald.conf.d/vitrina.conf 644; then
	systemctl restart systemd-journald
fi

# --- Node, exactly ------------------------------------------------------------------------

step "node $NODE_VERSION ($NODE_ARCH)"
node_dir=/opt/node-$NODE_VERSION-linux-$NODE_ARCH
if [[ "$("$node_dir/bin/node" --version 2>/dev/null)" != "$NODE_VERSION" ]]; then
	tarball=node-$NODE_VERSION-linux-$NODE_ARCH.tar.xz
	dl=$(mktemp -d)
	curl -fsSL -o "$dl/$tarball" "https://nodejs.org/dist/$NODE_VERSION/$tarball"
	(cd "$dl" && grep "  $tarball\$" "$here/node.sha256" | sha256sum -c -) || fail "$tarball does not match node.sha256"
	rm -rf "$node_dir"
	tar -xJf "$dl/$tarball" -C /opt
	chown -R root:root "$node_dir"
	rm -rf "$dl"
fi
ln -sfn "$node_dir/bin/node" /usr/local/bin/node
/usr/local/bin/node --version

# --- PostgreSQL 15, loopback only ----------------------------------------------------------

step "postgresql $PG_MAJOR"
if [[ ! -f /etc/apt/sources.list.d/pgdg.list && ! -f /etc/apt/sources.list.d/pgdg.sources ]]; then
	/usr/share/postgresql-common/pgdg/apt.postgresql.org.sh -y
fi
apt-get install -yq "postgresql-$PG_MAJOR"
# Exactly one cluster, and it is 15: a second would be a second listener.
clusters=$(pg_lsclusters --no-header | awk '{print $1"/"$2}')
[[ "$clusters" == "$PG_MAJOR/main" ]] || fail "expected only cluster $PG_MAJOR/main, found: $clusters"
install -d -m 755 -o postgres -g postgres "/etc/postgresql/$PG_MAJOR/main/conf.d"
if put "$files/postgresql-vitrina.conf" "/etc/postgresql/$PG_MAJOR/main/conf.d/vitrina.conf" 644; then
	chown postgres:postgres "/etc/postgresql/$PG_MAJOR/main/conf.d/vitrina.conf"
	systemctl restart "postgresql@$PG_MAJOR-main"
fi

# --- the service user, its database, its unit -------------------------------------------------

step "service user vitrina"
if ! id -u vitrina >/dev/null 2>&1; then
	useradd --system --user-group --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin vitrina
fi
# Peer authentication over the local socket: no database password exists to leak.
sudo -u postgres psql -qtAc "SELECT 1 FROM pg_roles WHERE rolname = 'vitrina'" | grep -q 1 ||
	sudo -u postgres createuser --no-superuser --no-createdb --no-createrole vitrina
sudo -u postgres psql -qtAc "SELECT 1 FROM pg_database WHERE datname = 'vitrina'" | grep -q 1 ||
	sudo -u postgres createdb --owner=vitrina vitrina

install -d -m 755 -o root -g root /opt/vitrina /opt/vitrina/api /opt/vitrina/app
install -d -m 700 -o root -g root /etc/vitrina
if put "$files/vitrina-api.service" /etc/systemd/system/vitrina-api.service 644; then
	systemctl daemon-reload
fi
# verify also reports on unrelated units; only this one's findings stop us.
verdict=$(systemd-analyze verify /etc/systemd/system/vitrina-api.service 2>&1 || true)
if grep -q '^vitrina-api.service:' <<<"$verdict"; then echo "$verdict"; fail "systemd rejects vitrina-api.service"; fi
systemctl enable vitrina-api.service >/dev/null

# --- Caddy ------------------------------------------------------------------------------------

step "caddy"
if [[ ! -f /etc/apt/sources.list.d/caddy-stable.list ]]; then
	curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/gpg.key |
		gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
	curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt >/etc/apt/sources.list.d/caddy-stable.list
	apt-get update -q
fi
apt-get install -yq caddy
caddy validate --adapter caddyfile --config "$files/Caddyfile" >/dev/null
if put "$files/Caddyfile" /etc/caddy/Caddyfile 644; then
	systemctl reload caddy || systemctl restart caddy
fi
systemctl enable --now caddy >/dev/null

step "done — now, from the Mac, in a second terminal: deploy/server/check.sh <ip> $ADMIN_USER"

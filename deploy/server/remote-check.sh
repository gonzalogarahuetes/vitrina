#!/usr/bin/env bash
#
# Phase 2's checks from inside the server, as root. check.sh copies this up
# and runs it; it changes nothing. Exit 1 if any check fails.
#
#   remote-check.sh <admin-user>

set -uo pipefail
ADMIN_USER=${1:?usage: remote-check.sh <admin-user>}
cd /
fails=0
pass() { echo "PASS $*"; }
bad() { echo "FAIL $*"; fails=$((fails + 1)); }
check() { # <description> <command…>: PASS if the command succeeds
	local what=$1
	shift
	if "$@" >/dev/null 2>&1; then pass "$what"; else bad "$what"; fi
}
sshd_says() { [[ "$(sshd -T 2>/dev/null | awk -v k="$1" '$1 == k { $1 = ""; sub(/^ /, ""); print; exit }')" == "$2" ]]; }

# shellcheck source=/dev/null
. /etc/os-release
check "Ubuntu 24.04 ($PRETTY_NAME)" test "$ID $VERSION_ID" = "ubuntu 24.04"

# --- SSH --------------------------------------------------------------------
# sshd -T needs its runtime directory, which socket activation may not have made.
install -d -m 755 /run/sshd
check "sshd: no root login" sshd_says permitrootlogin no
check "sshd: no passwords" sshd_says passwordauthentication no
check "sshd: no keyboard-interactive" sshd_says kbdinteractiveauthentication no
check "sshd: public key only" sshd_says authenticationmethods publickey
check "sshd: only $ADMIN_USER may log in" sshd_says allowusers "$ADMIN_USER"
check "$ADMIN_USER is in sudo" bash -c "id -nG $ADMIN_USER | grep -qw sudo"
check "$ADMIN_USER has a sudo password" bash -c "passwd -S $ADMIN_USER | awk '{exit \$2 != \"P\"}'"
# Not a FAIL while present: provision.sh removes it only on a run made by
# $ADMIN_USER over SSH with sudo, which the first (root) run cannot be.
if [[ -s /root/.ssh/authorized_keys ]]; then
	echo "NOTE root still holds an authorized key — the next provision.sh run, as $ADMIN_USER with sudo, removes it"
else pass "root holds no authorized key"; fi

# --- firewall ---------------------------------------------------------------
check "ufw active, incoming denied by default" bash -c "ufw status verbose | grep -q '^Status: active' && ufw status verbose | grep -q 'deny (incoming)'"
# Rule column only ("22/tcp", "22/tcp (v6)"); with IPv6 off the v6 rows are absent.
rules=$(ufw status | awk '/ ALLOW /' | sed -E 's/ {2,}.*//' | LC_ALL=C sort -u | tr '\n' ';')
case "$rules" in
"22/tcp;22/tcp (v6);443/tcp;443/tcp (v6);80/tcp;80/tcp (v6);" | "22/tcp;443/tcp;80/tcp;") pass "ufw allows exactly 22, 80, 443/tcp" ;;
*) bad "ufw allows: $rules" ;;
esac
if ufw status | grep -qE ' (DENY|REJECT|LIMIT) '; then bad "ufw has rules beyond the three allows"; fi

# Every listening socket not on loopback is 22, 80 or 443 — whatever the firewall says.
# The DHCP clients' sockets (68, 546) are outbound by nature and firewalled anyway.
exposed=$(ss -Hltnu | awk '{print $5}' | grep -vE '^(127\.[0-9.]+(%[a-z0-9]+)?|\[::1\]|::1):' |
	grep -vE ':(22|80|443)$' | grep -vE ':(68|546)$' | sort -u | tr '\n' ' ')
if [[ -z "$exposed" ]]; then pass "nothing but 22, 80, 443 listens beyond loopback"; else bad "listening beyond loopback: $exposed"; fi

# --- updates ----------------------------------------------------------------
check "unattended upgrades enabled" bash -c "apt-config dump APT::Periodic::Unattended-Upgrade | grep -q '\"1\"'"
check "package lists refreshed daily" bash -c "apt-config dump APT::Periodic::Update-Package-Lists | grep -q '\"1\"'"
check "apt-daily-upgrade.timer active" systemctl is-active apt-daily-upgrade.timer
check "unattended-upgrade dry run succeeds" unattended-upgrade --dry-run
check "PostgreSQL repository allowed for automatic upgrades" bash -c "unattended-upgrade --dry-run --debug 2>&1 | grep -q 'origin=apt.postgresql.org'"

# --- journald ----------------------------------------------------------------
check "journald keeps 14 days" bash -c "systemd-analyze cat-config systemd/journald.conf | grep -qx 'MaxRetentionSec=14day'"
check "journald is persistent" test -d /var/log/journal

# --- Node -------------------------------------------------------------------
check "node is v22.23.4" test "$(/usr/local/bin/node --version 2>/dev/null)" = v22.23.4
check "the service user can run node" sudo -u vitrina /usr/local/bin/node -e 0

# --- PostgreSQL ----------------------------------------------------------------
check "PostgreSQL 15" bash -c "sudo -u postgres psql -qtAc 'SHOW server_version_num' | grep -q '^15'"
check "one cluster: 15/main" test "$(pg_lsclusters --no-header | awk '{print $1"/"$2}')" = 15/main
check "listen_addresses = localhost" test "$(sudo -u postgres psql -qtAc 'SHOW listen_addresses')" = localhost
pg_listen=$(ss -Hltn 'sport = :5432' | awk '{print $4}' | sort -u | tr '\n' ' ')
if [[ -n "$pg_listen" && -z "$(echo "$pg_listen" | tr ' ' '\n' | grep -vE '^(127\.0\.0\.1|\[::1\]):5432$')" ]]; then
	pass "5432 bound to loopback only ($pg_listen)"
else bad "5432 bound to: ${pg_listen:-nothing}"; fi
check "vitrina connects to its database by peer, no password" \
	test "$(sudo -u vitrina psql -d vitrina -qtAc 'SELECT current_user' 2>/dev/null)" = vitrina
check "vitrina is not a superuser" \
	test "$(sudo -u postgres psql -qtAc "SELECT rolsuper FROM pg_roles WHERE rolname = 'vitrina'")" = f

# --- the service user and unit ---------------------------------------------------
check "vitrina has no login shell" test "$(getent passwd vitrina | cut -d: -f7)" = /usr/sbin/nologin
check "vitrina is not in sudo" bash -c "! id -nG vitrina | grep -qw sudo"
check "/etc/vitrina is root-only" test "$(stat -c '%U %a' /etc/vitrina)" = "root 700"
check "unit runs as vitrina" test "$(systemctl show -p User --value vitrina-api)" = vitrina
# In ExecStart, not Environment=: an EnvironmentFile value would override that.
check "unit pins HOST=127.0.0.1 in ExecStart" bash -c "systemctl show -p ExecStart --value vitrina-api | grep -q 'HOST=127.0.0.1 PORT=3000 /usr/local/bin/node'"
check "unit is enabled" systemctl is-enabled vitrina-api
# systemd's own scale: SAFE or OK passes; MEDIUM and worse fail and say why.
level=$(systemd-analyze security vitrina-api.service 2>/dev/null | grep -oE 'Overall exposure level for vitrina-api.service: [0-9.]+ [A-Z]+' | awk '{print $(NF-1), $NF}')
case "$level" in
*" SAFE" | *" OK") pass "unit exposure: $level" ;;
*) bad "unit exposure: ${level:-unknown} — systemd-analyze security vitrina-api shows each finding" ;;
esac

# --- Caddy ------------------------------------------------------------------------
check "caddy active" systemctl is-active caddy
check "caddy config valid" caddy validate --adapter caddyfile --config /etc/caddy/Caddyfile
check "caddy admin endpoint on loopback only" bash -c "ss -Hltn 'sport = :2019' | awk '{print \$4}' | grep -qvE '^(127\.0\.0\.1|\[::1\]):2019$' && exit 1 || exit 0"

echo
if [[ $fails -eq 0 ]]; then echo "remote: all PASS"; else echo "remote: $fails FAIL"; exit 1; fi

#!/usr/bin/env bash
#
# Phase 2's checks, from the owner's Mac: what the internet sees, then
# remote-check.sh run on the server as root. Changes nothing, except with
# --violate, which opens 5432 in the firewall for a few seconds to show
# PostgreSQL still refuses from outside, and closes it again.
#
#   deploy/server/check.sh <ip> <admin-user> [--violate]
#
# SSH_KEY defaults to ~/.ssh/vitrina_hetzner. Each sudo step asks for the
# admin user's sudo password. Written for macOS's bash 3.2.

set -uo pipefail
HOST=${1:?usage: check.sh <ip> <admin-user> [--violate]}
ADMIN_USER=${2:?usage: check.sh <ip> <admin-user> [--violate]}
VIOLATE=${3:-}
KEY=${SSH_KEY:-$HOME/.ssh/vitrina_hetzner}
here=$(cd "$(dirname "$0")" && pwd)
SSH_OPTS=(-i "$KEY" -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=10)
fails=0
pass() { echo "PASS $*"; }
bad() { echo "FAIL $*"; fails=$((fails + 1)); }

# open | refused (the host answered, nothing listens) | filtered (dropped: the firewall)
probe() {
	node -e '
		const s = require("node:net").connect({ host: process.argv[1], port: Number(process.argv[2]) });
		const done = (r) => { clearTimeout(t); s.destroy(); console.log(r); };
		const t = setTimeout(() => done("filtered"), 4000);
		s.on("connect", () => done("open"));
		s.on("error", (e) => done(e.code === "ECONNREFUSED" ? "refused" : "error " + e.code));
	' "$HOST" "$1"
}
expect_port() { # <port> <state> <why>
	local got
	got=$(probe "$1")
	if [[ "$got" == "$2" ]]; then pass "port $1 $got — $3"; else bad "port $1 is $got, expected $2 — $3"; fi
}
remote_sudo() { ssh -t "${SSH_OPTS[@]}" "$ADMIN_USER@$HOST" "sudo $*"; }

# The login checks run with BatchMode, which cannot ask for a passphrase. With
# the key locked, every login fails for want of a key — root's refusal would
# then prove nothing about sshd. So the key must be in the agent first.
fingerprint=$(ssh-keygen -lf "$KEY.pub" 2>/dev/null | awk '{print $2}')
if [[ -z "$fingerprint" ]] || ! ssh-add -l 2>/dev/null | grep -qF "$fingerprint"; then
	echo "check.sh: load the key into the agent first, so the login checks can use it:" >&2
	echo "  ssh-add --apple-use-keychain $KEY" >&2
	exit 2
fi

echo "== from outside"
expect_port 22 open "ssh"
expect_port 80 open "caddy (ACME, redirect to https)"
expect_port 443 open "caddy"
for port in 3000 5432 2019 8080; do expect_port "$port" filtered "the firewall drops it"; done

# Run this before the provision.sh run that removes root's key: while root
# still holds it, the refusal can only be sshd's config — the violation proof.
out=$(ssh "${SSH_OPTS[@]}" -o BatchMode=yes "root@$HOST" true 2>&1)
if [[ $? -ne 0 && "$out" == *"Permission denied"* ]]; then pass "root login refused (remote-check says whether root still holds the key)"
else bad "root login: ${out:-succeeded}"; fi

# The method list in the refusal is what the server offers: publickey and nothing else.
out=$(ssh -o BatchMode=yes -o PubkeyAuthentication=no -o PreferredAuthentications=password,keyboard-interactive \
	-o StrictHostKeyChecking=accept-new -o ConnectTimeout=10 "$ADMIN_USER@$HOST" true 2>&1)
if [[ "$out" == *"Permission denied (publickey)"* ]]; then pass "no password or keyboard-interactive login offered"
else bad "password login: ${out:-succeeded}"; fi

if ssh "${SSH_OPTS[@]}" -o BatchMode=yes "$ADMIN_USER@$HOST" true; then pass "$ADMIN_USER logs in with the key"
else bad "$ADMIN_USER cannot log in with $KEY"; fi

# Hetzner's whole-server backup would put the secret and the database in one snapshot.
if command -v hcloud >/dev/null; then
	window=$(hcloud server list -o json | node -e '
		let j = ""; process.stdin.on("data", (d) => (j += d)).on("end", () => {
			const s = JSON.parse(j).find((s) => s.public_net?.ipv4?.ip === process.argv[1]);
			console.log(s ? String(s.backup_window ?? "off") : "not found");
		});' "$HOST")
	if [[ "$window" == off ]]; then pass "Hetzner server backups are off"; else bad "Hetzner server backups: $window"; fi
else
	echo "UNVERIFIED Hetzner server backups — install hcloud, or check the console shows Backups disabled"
fi

echo
echo "== on the server (sudo password)"
scp -q "${SSH_OPTS[@]}" "$here/remote-check.sh" "$ADMIN_USER@$HOST:/tmp/vitrina-remote-check.sh" &&
	remote_sudo "bash /tmp/vitrina-remote-check.sh $ADMIN_USER; rc=\$?; rm -f /tmp/vitrina-remote-check.sh; exit \$rc" ||
	fails=$((fails + 1))

if [[ "$VIOLATE" == --violate ]]; then
	echo
	echo "== by violation: 5432 opened in the firewall; PostgreSQL alone must still refuse (sudo password, twice)"
	# Not silenced: if it runs, its sudo prompt must be visible.
	trap 'echo "closing 5432 again:"; remote_sudo "ufw delete allow 5432/tcp"' EXIT
	remote_sudo "ufw allow 5432/tcp"
	# "refused", not "filtered": the packet now reaches the host, and nothing answers on a public address.
	expect_port 5432 refused "firewall open, PostgreSQL bound to loopback"
	remote_sudo "ufw delete allow 5432/tcp"
	trap - EXIT
	expect_port 5432 filtered "firewall closed again"
fi

echo
if [[ $fails -eq 0 ]]; then echo "All PASS."; else echo "$fails FAIL"; exit 1; fi

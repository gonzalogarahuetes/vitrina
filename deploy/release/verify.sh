#!/usr/bin/env bash
#
# Phase 5's end-to-end checks against the live deployment — the ones a
# signed-in session needs. Run after deploy.sh; it changes the server for a
# few minutes and puts everything back:
#
#   1. public-check.mjs (anonymous: headers, health, CORS, redirects)
#   2. walk-server.sh open: the HOST violation; a throwaway address invited
#   3. walk.mjs: that account uploads through Caddy (Content-Length kept,
#      chunked refused with 411), reads ranges, then erases what it stored
#   4. walk-server.sh close: the allowlist restored; Caddy's log checked for
#      the walk's bearer token; the account deleted; the bucket checked
#
#   deploy/release/verify.sh <ip> <admin-user>
#
# Each server step asks for the sudo password. The API restarts four times:
# run it before anyone depends on the app, or at a quiet moment.

set -uo pipefail
HOST=${1:?usage: verify.sh <ip> <admin-user>}
ADMIN_USER=${2:?usage: verify.sh <ip> <admin-user>}
KEY=${SSH_KEY:-$HOME/.ssh/vitrina_hetzner}
here=$(cd "$(dirname "$0")" && pwd)
SSH_OPTS=(-i "$KEY" -o IdentitiesOnly=yes -o ConnectTimeout=10)
remote=/tmp/vitrina-walk
fails=0

id=$(node -e 'console.log(require("node:crypto").randomUUID())')
email="walk-$id@verify.invalid"
marker="vitrina-verify/$id"
state=$(mktemp)
trap 'rm -f "$state"' EXIT

echo "== 1. anonymous"
node "$here/public-check.mjs" || fails=$((fails + 1))

echo
echo "== 2. open (sudo password)"
ssh "${SSH_OPTS[@]}" "$ADMIN_USER@$HOST" "rm -rf $remote && mkdir -m 700 $remote" &&
	scp -q "${SSH_OPTS[@]}" "$here/walk-server.sh" "$here/../server/lib.sh" "$ADMIN_USER@$HOST:$remote/" ||
	{ echo "FAIL could not upload walk-server.sh"; exit 1; }
if ! ssh -t "${SSH_OPTS[@]}" "$ADMIN_USER@$HOST" "sudo bash $remote/walk-server.sh open $email"; then
	echo "FAIL open did not complete; nothing was walked. If it left /etc/vitrina/.walk-backup, run close by hand."
	exit 1
fi

echo
echo "== 3. the walk, through Caddy"
node "$here/walk.mjs" "$email" "$marker" "$state" || fails=$((fails + 1))

echo
echo "== 4. close (sudo password) — runs whatever the walk did"
scp -q "${SSH_OPTS[@]}" "$state" "$ADMIN_USER@$HOST:$remote/state.json" &&
	ssh -t "${SSH_OPTS[@]}" "$ADMIN_USER@$HOST" \
		"sudo bash $remote/walk-server.sh close $email $marker $remote/state.json; rc=\$?; rm -rf $remote; exit \$rc" ||
	fails=$((fails + 1))

echo
if [[ $fails -eq 0 ]]; then echo "All PASS."; else echo "$fails part(s) FAILED (above)"; exit 1; fi

#!/usr/bin/env bash
#
# Phase 4's checks, from the owner's Mac: config-check.sh on the server, then
# its fingerprints looked for in this repository (every tracked file, every
# commit), then CI. Changes nothing.
#
#   deploy/server/check-config.sh <ip> <admin-user>
#
# SSH_KEY defaults to ~/.ssh/vitrina_hetzner, and must be in the agent.

set -uo pipefail
HOST=${1:?usage: check-config.sh <ip> <admin-user>}
ADMIN_USER=${2:?usage: check-config.sh <ip> <admin-user>}
KEY=${SSH_KEY:-$HOME/.ssh/vitrina_hetzner}
here=$(cd "$(dirname "$0")" && pwd)
repo=$(cd "$here/../.." && pwd)
SSH_OPTS=(-i "$KEY" -o IdentitiesOnly=yes -o ConnectTimeout=10)
fails=0

out=$(mktemp)
trap 'rm -f "$out"' EXIT

echo "== on the server (sudo password)"
scp -q "${SSH_OPTS[@]}" "$here/config-check.sh" "$here/lib.sh" "$ADMIN_USER@$HOST:/tmp/" &&
	ssh -t "${SSH_OPTS[@]}" "$ADMIN_USER@$HOST" \
		"sudo bash /tmp/config-check.sh $ADMIN_USER; rc=\$?; rm -f /tmp/config-check.sh /tmp/lib.sh; exit \$rc" |
	tee "$out" || fails=$((fails + 1))

echo
echo "== in this repository: every tracked file and every commit"
specs=$(tr -d '\r' <"$out" | awk '/^FINGERPRINT / { print $2 ":" $3 ":" $4 }')
if [[ -z "$specs" ]]; then
	echo "FAIL no fingerprints came back from the server"
	fails=$((fails + 1))
else
	# shellcheck disable=SC2086 # one argument per fingerprint, by design
	node "$here/secret-scan.mjs" "$repo" $specs || fails=$((fails + 1))
fi

echo
echo "== CI"
# The API's secrets never reach CI: no workflow names a secret at all.
if grep -nE '\$\{\{\s*secrets\.' "$repo"/.github/workflows/*.yml; then
	echo "FAIL a workflow references secrets (above)"
	fails=$((fails + 1))
else
	echo "PASS no workflow references a secret"
fi

echo
if [[ $fails -eq 0 ]]; then echo "All PASS."; else echo "$fails FAIL"; exit 1; fi

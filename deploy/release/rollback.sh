#!/usr/bin/env bash
#
# Back to the release that was live before this one: both `current` links,
# the API restarted, /health awaited (rollback-server.sh, on the server), then
# the public checks and the tag now live (live.sh), from here.
#
#   deploy/release/rollback.sh <ip> <admin-user>
#
# Refuses if no previous release is recorded, and a second time in a row (the
# rule covers one release back). Never touches the database:
# migrations the rolled-back release applied stay applied, which is safe only
# because of the migration rule (README §3). Afterwards, fix forward with a new
# tag; the old tag cannot simply be deployed again once a migration it lacks
# is applied (migrate.mjs refuses "recorded but missing from disk").
#
# Asks for the sudo password once.

set -euo pipefail
HOST=${1:?usage: rollback.sh <ip> <admin-user>}
ADMIN_USER=${2:?usage: rollback.sh <ip> <admin-user>}
KEY=${SSH_KEY:-$HOME/.ssh/vitrina_hetzner}
here=$(cd "$(dirname "$0")" && pwd)
SSH_OPTS=(-i "$KEY" -o IdentitiesOnly=yes -o ConnectTimeout=10)
remote=/tmp/vitrina-rollback
fail() { echo "rollback: $*" >&2; exit 1; }

fingerprint=$(ssh-keygen -lf "$KEY.pub" 2>/dev/null | awk '{print $2}')
ssh-add -l 2>/dev/null | grep -qF "${fingerprint:-none}" || fail "load the key first: ssh-add --apple-use-keychain $KEY"

was=$(bash "$here/live.sh" "$HOST" "$ADMIN_USER") || fail "cannot tell what is live (above); nothing done"
echo "live now: $was"

ssh "${SSH_OPTS[@]}" "$ADMIN_USER@$HOST" "rm -rf $remote && mkdir -m 700 $remote"
scp -q "${SSH_OPTS[@]}" "$here/rollback-server.sh" "$ADMIN_USER@$HOST:$remote/"
ssh -t "${SSH_OPTS[@]}" "$ADMIN_USER@$HOST" \
	"sudo bash $remote/rollback-server.sh; rc=\$?; rm -rf $remote; exit \$rc" || fail "the server refused or failed (above)"

printf '\n== from outside\n'
public=ok
node "$here/public-check.mjs" || public=failed
echo
now=$(bash "$here/live.sh" "$HOST" "$ADMIN_USER") || fail "cannot tell what is live after the rollback (above)"
echo "rolled back from $was; live: $now"
[[ "$public" == ok ]] || fail "the public checks failed (above)"

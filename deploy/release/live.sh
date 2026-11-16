#!/usr/bin/env bash
#
# What's live: the tag of the release both `current` links point at. Prints the
# tag alone on stdout ("untagged" for a release from before tags were
# required), the release's name on stderr. Changes nothing; no sudo.
#
#   deploy/release/live.sh <ip> <admin-user>
#
# Exit 1 when either link is missing or the API and the app are on different
# releases — then there is no one answer, and that is the finding.

set -euo pipefail
HOST=${1:?usage: live.sh <ip> <admin-user>}
ADMIN_USER=${2:?usage: live.sh <ip> <admin-user>}
KEY=${SSH_KEY:-$HOME/.ssh/vitrina_hetzner}
SSH_OPTS=(-i "$KEY" -o IdentitiesOnly=yes -o ConnectTimeout=10)
fail() { echo "live: $*" >&2; exit 1; }

# /opt/vitrina is root-owned and world-readable (provision.sh): no sudo needed.
links=$(ssh "${SSH_OPTS[@]}" "$ADMIN_USER@$HOST" \
	'readlink /opt/vitrina/api/current || echo none; readlink /opt/vitrina/app/current || echo none') ||
	fail "could not reach $HOST"
api=$(sed -n 1p <<<"$links")
app=$(sed -n 2p <<<"$links")

# release.sh links api/current to releases/<id>/packages/server, app/current to releases/<id>.
id=${api#/opt/vitrina/api/releases/}
id=${id%/packages/server}
[[ "$api" == "/opt/vitrina/api/releases/$id/packages/server" && -n "$id" ]] || fail "api/current is not a release: $api"
[[ "$app" == "/opt/vitrina/app/releases/$id" ]] || fail "the API runs $id but the app is $app"

if [[ "$id" =~ ^[0-9]{8}T[0-9]{6}Z-(v[0-9]+\.[0-9]+\.[0-9]+)-[0-9a-f]{12}$ ]]; then
	echo "${BASH_REMATCH[1]}"
else
	echo untagged
fi
echo "release $id (API and app)" >&2

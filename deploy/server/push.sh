#!/usr/bin/env bash
#
# Copy deploy/server to the admin's home on the server as ~/vitrina-server,
# replacing any older copy — `scp -r` into an existing folder would nest the new
# copy inside it and leave the old scripts to run.
#
#   deploy/server/push.sh <ip> <admin-user>

set -euo pipefail
HOST=${1:?usage: push.sh <ip> <admin-user>}
ADMIN_USER=${2:?usage: push.sh <ip> <admin-user>}
KEY=${SSH_KEY:-$HOME/.ssh/vitrina_hetzner}
here=$(cd "$(dirname "$0")" && pwd)
SSH_OPTS=(-i "$KEY" -o IdentitiesOnly=yes -o ConnectTimeout=10)

ssh "${SSH_OPTS[@]}" "$ADMIN_USER@$HOST" 'rm -rf vitrina-server'
scp -q -r "${SSH_OPTS[@]}" "$here" "$ADMIN_USER@$HOST:vitrina-server"
echo "copied deploy/server to $ADMIN_USER@$HOST:vitrina-server"

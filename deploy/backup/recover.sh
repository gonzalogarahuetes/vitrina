#!/usr/bin/env bash
#
# Disaster recovery, the database: the newest backup (or a named one) from the
# backup bucket, decrypted HERE with the offline key, streamed over SSH into
# the new server, restored there by recover-server.sh. The private key never
# leaves the Mac; the plaintext exists on the server only until it is restored.
#
#   AGE_IDENTITY=<offline key file> deploy/backup/recover.sh <ip> <admin-user> [backup-key]
#
# BACKUP_ENV_FILE (default ~/.vitrina/backup-bucket.env) holds the backup
# bucket's BACKUP_* names. This script only lists and reads that bucket.
# Run after configure.sh and BEFORE the first deploy.sh: the database must be
# empty, and the release's migrations then find nothing to apply.

set -euo pipefail
HOST=${1:?usage: recover.sh <ip> <admin-user> [backup-key]}
ADMIN_USER=${2:?usage: recover.sh <ip> <admin-user> [backup-key]}
chosen=${3:-}
KEY=${SSH_KEY:-$HOME/.ssh/vitrina_hetzner}
BACKUP_ENV_FILE=${BACKUP_ENV_FILE:-$HOME/.vitrina/backup-bucket.env}
here=$(cd "$(dirname "$0")" && pwd)
repo=$(cd "$here/../.." && pwd)
SSH_OPTS=(-i "$KEY" -o IdentitiesOnly=yes -o ConnectTimeout=10)
die() { echo "recover: $*" >&2; exit 1; }

[[ -r "${AGE_IDENTITY:-}" ]] || die "set AGE_IDENTITY to the offline age key file"
[[ -r "$BACKUP_ENV_FILE" ]] || die "no $BACKUP_ENV_FILE (the backup bucket's BACKUP_* values)"
command -v age >/dev/null || die "brew install age"
fingerprint=$(ssh-keygen -lf "$KEY.pub" 2>/dev/null | awk '{print $2}')
ssh-add -l 2>/dev/null | grep -qF "${fingerprint:-none}" || die "load the key first: ssh-add --apple-use-keychain $KEY"

s3() { node --env-file="$BACKUP_ENV_FILE" "$here/s3.mjs" "$@"; } # list and read only, here
backup=${chosen:-$(s3 latest pg/)}
echo "== backup $backup"

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
s3 get "$backup" "$work/backup.age"
echo "downloaded $(wc -c <"$work/backup.age" | tr -d ' ') bytes of ciphertext"

echo "== decrypt here, stream to the server"
# age authenticates every chunk: a wrong key fails before any byte, a damaged
# file fails partway. Either way the partial plaintext on the server is removed
# and nothing is restored.
if ! age --decrypt -i "$AGE_IDENTITY" "$work/backup.age" |
	ssh "${SSH_OPTS[@]}" "$ADMIN_USER@$HOST" 'umask 077 && cat >recover.dump'; then
	ssh "${SSH_OPTS[@]}" "$ADMIN_USER@$HOST" 'rm -f recover.dump' || true
	die "decrypting or streaming failed (above); nothing was restored"
fi
echo "streamed"

echo "== restore on the server (sudo password)"
ssh "${SSH_OPTS[@]}" "$ADMIN_USER@$HOST" "rm -rf /tmp/vitrina-recover && mkdir -m 700 /tmp/vitrina-recover"
scp -q "${SSH_OPTS[@]}" "$repo/deploy/server/recover-server.sh" "$repo/deploy/server/lib.sh" "$ADMIN_USER@$HOST:/tmp/vitrina-recover/"
ssh -t "${SSH_OPTS[@]}" "$ADMIN_USER@$HOST" \
	"sudo bash /tmp/vitrina-recover/recover-server.sh $ADMIN_USER; rc=\$?; rm -rf /tmp/vitrina-recover; exit \$rc"
echo
echo "recovered $backup. Next: deploy/release/deploy.sh — its migrations must report '0 applied'."

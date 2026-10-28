#!/usr/bin/env bash
#
# Restore one backup into an EMPTY database: download, decrypt, pg_restore.
#
#   restore.sh [--hide-missing] [key]    default key: the newest under BACKUP_PREFIX
#
# --hide-missing (off by default): after restoring, hide (removed_at) every
# `ready` row whose objects are absent from the media bucket, and list them —
# consistency.mjs does it. Needs the API's S3_* / AWS_* names as well.
#
# Environment:
#   TARGET_DATABASE_URL  must exist and hold no tables — this never restores over data
#   AGE_IDENTITY         path to the age identity file (the offline private key)
#   BACKUP_BUCKET BACKUP_S3_ENDPOINT BACKUP_S3_REGION
#   BACKUP_AWS_ACCESS_KEY_ID BACKUP_AWS_SECRET_ACCESS_KEY
#   PG_RESTORE           default `pg_restore`; the rehearsal uses the container's
#   BACKUP_PREFIX        default `pg/`
#
# Restores the database only. The server secret comes back from its own
# backup (the password manager), and photos were never in this one.

set -euo pipefail
umask 077

here=$(cd "$(dirname "$0")" && pwd)
fail() { echo "restore: $*" >&2; exit 1; }
now_ms() { node -e 'process.stdout.write(String(Date.now()))'; }

hide_missing=false
if [[ "${1:-}" == --hide-missing ]]; then hide_missing=true; shift; fi
[[ "${1:-}" != -* ]] || fail "unknown option: $1"

required="TARGET_DATABASE_URL AGE_IDENTITY BACKUP_BUCKET BACKUP_S3_ENDPOINT BACKUP_S3_REGION BACKUP_AWS_ACCESS_KEY_ID BACKUP_AWS_SECRET_ACCESS_KEY"
$hide_missing && required="$required S3_ENDPOINT S3_BUCKET AWS_DEFAULT_REGION AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY"
for name in $required; do
	[[ -n "${!name:-}" ]] || fail "missing $name"
done
[[ -r "$AGE_IDENTITY" ]] || fail "cannot read AGE_IDENTITY"
command -v age >/dev/null || fail "age is not installed"
PG_RESTORE=${PG_RESTORE:-pg_restore}
BACKUP_PREFIX=${BACKUP_PREFIX:-pg/}

DATABASE_URL="$TARGET_DATABASE_URL" node "$here/counts.mjs" --expect-empty >/dev/null ||
	fail "target database is not empty; refusing to restore over it"

key=${1:-$(node "$here/s3.mjs" latest "$BACKUP_PREFIX")}
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

t0=$(now_ms)
node "$here/s3.mjs" get "$key" "$work/backup.age"
t1=$(now_ms)
# age authenticates: a tampered or truncated file fails here, before pg_restore sees a byte.
age --decrypt -i "$AGE_IDENTITY" -o "$work/backup.dump" "$work/backup.age"
# shellcheck disable=SC2086 # PG_RESTORE may be a command with arguments, by design
$PG_RESTORE --exit-on-error --no-owner --no-acl --dbname="$TARGET_DATABASE_URL" <"$work/backup.dump"
t2=$(now_ms)

echo "restore ok key=$key bytes=$(wc -c <"$work/backup.age" | tr -d ' ') download_ms=$((t1 - t0)) decrypt+restore_ms=$((t2 - t1))"

if $hide_missing; then
	DATABASE_URL="$TARGET_DATABASE_URL" node "$here/consistency.mjs" --hide-missing ||
		fail "restored, but rows remain that the bucket does not back (listed above)"
fi

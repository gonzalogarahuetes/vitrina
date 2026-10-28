#!/usr/bin/env bash
#
# One database backup: pg_dump | age → a separate bucket, then retention.
# Nightly on the server (phase 6, via a systemd timer); the local rehearsal
# runs this same file.
#
# The plaintext dump never touches disk: pg_dump streams into age, and only
# ciphertext is written. The age PRIVATE key is not on this machine — only the
# recipient (public key) is — so this machine can make backups and cannot
# read them.
#
# Environment — its own, never the API's (the API's holds the server secret,
# and one artifact holding both collapses the pepper; .env.example):
#   DATABASE_URL       what pg_dump connects to
#   AGE_RECIPIENT      age1… public key; the identity stays offline with the owner
#   MEDIA_BUCKET       the API's bucket, named only so this can refuse it
#   BACKUP_BUCKET BACKUP_S3_ENDPOINT BACKUP_S3_REGION
#   BACKUP_AWS_ACCESS_KEY_ID BACKUP_AWS_SECRET_ACCESS_KEY
#   RETENTION_DAYS     no default: how long removed photos' rows survive in backups is a decision
#   KEEP_MIN           newest N kept whatever their age (default 7)
#   PG_DUMP            default `pg_dump`; the rehearsal uses the container's
#   BACKUP_PREFIX      default `pg/`; retention never touches a key outside it
#   BACKUP_HEARTBEAT_URL  optional, https: pinged after a complete run (backup and
#                      retention), so the monitor alerts when a night's ping is missing
#
# To see what retention would delete, deleting nothing (same environment):
#   node deploy/backup/s3.mjs prune "$BACKUP_PREFIX" "$RETENTION_DAYS" "$KEEP_MIN" --dry-run

set -euo pipefail
umask 077

here=$(cd "$(dirname "$0")" && pwd)
fail() { echo "backup: $*" >&2; exit 1; }
now_ms() { node -e 'process.stdout.write(String(Date.now()))'; }

for name in DATABASE_URL AGE_RECIPIENT MEDIA_BUCKET BACKUP_BUCKET BACKUP_S3_ENDPOINT BACKUP_S3_REGION \
	BACKUP_AWS_ACCESS_KEY_ID BACKUP_AWS_SECRET_ACCESS_KEY RETENTION_DAYS; do
	[[ -n "${!name:-}" ]] || fail "missing $name"
done

# Guards, each a refusal rather than a warning.
[[ -z "${VITRINA_SERVER_SECRET:-}" ]] ||
	fail "refusing: VITRINA_SERVER_SECRET is in this environment. The backup job must not hold it."
[[ "$AGE_RECIPIENT" != AGE-SECRET-KEY-* ]] ||
	fail "refusing: AGE_RECIPIENT is an age PRIVATE key. It belongs offline; this takes the age1… public key."
[[ "$AGE_RECIPIENT" =~ ^age1[02-9ac-hj-np-z]{58}$ ]] ||
	fail "AGE_RECIPIENT is not an age X25519 recipient (age1…)"
[[ "$BACKUP_BUCKET" != "$MEDIA_BUCKET" ]] ||
	fail "refusing: BACKUP_BUCKET is the media bucket. Backups go to a separate one."
[[ "$RETENTION_DAYS" =~ ^[1-9][0-9]*$ ]] || fail "RETENTION_DAYS must be a positive integer"
KEEP_MIN=${KEEP_MIN:-7}
[[ "$KEEP_MIN" =~ ^[1-9][0-9]*$ ]] || fail "KEEP_MIN must be a positive integer"
[[ -z "${BACKUP_HEARTBEAT_URL:-}" || "$BACKUP_HEARTBEAT_URL" == https://?* ]] ||
	fail "BACKUP_HEARTBEAT_URL must be https"
BACKUP_PREFIX=${BACKUP_PREFIX:-pg/}
# The name carries the backup's age for retention (prune.mjs); it also
# validates the prefix, before anything is dumped.
key=$(node "$here/name.mjs" "$BACKUP_PREFIX") || fail "invalid BACKUP_PREFIX"
command -v age >/dev/null || fail "age is not installed"

PG_DUMP=${PG_DUMP:-pg_dump}
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
out="$work/backup.age"

t0=$(now_ms)
# shellcheck disable=SC2086 # PG_DUMP may be a command with arguments, by design
$PG_DUMP --format=custom --no-password "$DATABASE_URL" | age --encrypt -r "$AGE_RECIPIENT" >"$out"
t1=$(now_ms)

[[ "$(head -c 21 "$out")" == "age-encryption.org/v1" ]] || fail "output is not age ciphertext; nothing uploaded"
bytes=$(wc -c <"$out" | tr -d ' ')

node "$here/s3.mjs" put "$out" "$key"
t2=$(now_ms)
node "$here/s3.mjs" prune "$BACKUP_PREFIX" "$RETENTION_DAYS" "$KEEP_MIN"

echo "backup ok key=$key bytes=$bytes dump+encrypt_ms=$((t1 - t0)) upload_ms=$((t2 - t1))"

# Only a complete run reaches this line, so a failure anywhere above is a
# missing ping, and the monitor's alert. The URL is a credential (anyone with it
# can report a backup that never happened): it reaches curl through a file
# descriptor, never its arguments, and is never printed. A failed ping does not
# fail the backup — the backup is done — but it is said, for the journal.
if [[ -n "${BACKUP_HEARTBEAT_URL:-}" ]]; then
	if curl -fsS -o /dev/null --max-time 10 --retry 3 -K <(printf 'url = "%s"\n' "$BACKUP_HEARTBEAT_URL"); then
		echo "heartbeat pinged"
	else
		echo "WARNING heartbeat ping failed — the monitor will report this night as missed" >&2
	fi
fi

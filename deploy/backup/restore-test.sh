#!/usr/bin/env bash
#
# Phase 6's restore test, once: a real backup of the live database, restored
# here, on the Mac, with the offline key — which therefore never goes near the
# server. That is also the disaster it rehearses: the server is gone, and the
# backup bucket and the offline key are all there is.
#
#   pnpm infra:up && pnpm infra:wait                        # a local PostgreSQL 15
#   AGE_IDENTITY=<the offline key file> deploy/backup/restore-test.sh <ip> <admin-user>
#
#   1. on the server (backup-now.sh): checks, a backup run as the timer runs
#      it, the live row counts, the ciphertext left in /tmp
#   2. here: download, decrypt in a pipe (no plaintext file), pg_restore into a
#      scratch database in the local container
#   3. row counts equal to the live ones; the migration runner a no-op; every
#      ready photo's objects present in the media bucket (~/.vitrina/storage.env)
#   4. timings and size; the scratch database dropped, the ciphertext deleted

set -uo pipefail
HOST=${1:?usage: restore-test.sh <ip> <admin-user>}
ADMIN_USER=${2:?usage: restore-test.sh <ip> <admin-user>}
KEY=${SSH_KEY:-$HOME/.ssh/vitrina_hetzner}
STORAGE_ENV=${STORAGE_ENV:-$HOME/.vitrina/storage.env}
here=$(cd "$(dirname "$0")" && pwd)
repo=$(cd "$here/../.." && pwd)
SSH_OPTS=(-i "$KEY" -o IdentitiesOnly=yes -o ConnectTimeout=10)
PGC=vitrina-postgres
DB=vitrina_restore_test
URL="postgres://admin:password@localhost:5432/$DB" # compose's public local credentials
fails=0
pass() { echo "PASS $*"; }
bad() { echo "FAIL $*"; fails=$((fails + 1)); }
die() { echo "restore-test: $*" >&2; exit 1; }
now_ms() { node -e 'process.stdout.write(String(Date.now()))'; }

[[ -r "${AGE_IDENTITY:-}" ]] || die "set AGE_IDENTITY to the offline age key file"
[[ -r "$STORAGE_ENV" ]] || die "no $STORAGE_ENV (the media bucket's values, from phase 1)"
[[ "$(docker inspect -f '{{.State.Running}}' "$PGC" 2>/dev/null)" == true ]] || die "pnpm infra:up && pnpm infra:wait"
[[ -f "$repo/packages/server/dist/composition-root.js" ]] || die "pnpm --filter @vitrina/server build"
command -v age >/dev/null || die "brew install age"

work=$(mktemp -d)
cleanup() {
	docker exec "$PGC" psql -X -q -U admin -d postgres -c "DROP DATABASE IF EXISTS $DB" >/dev/null 2>&1
	rm -rf "$work"
}
trap cleanup EXIT

# --- 1. the server ---------------------------------------------------------------
echo "== on the server: a backup now (sudo password)"
ssh "${SSH_OPTS[@]}" "$ADMIN_USER@$HOST" "rm -rf /tmp/vitrina-backup-now && mkdir -m 700 /tmp/vitrina-backup-now" &&
	scp -q "${SSH_OPTS[@]}" "$repo/deploy/server/backup-now.sh" "$repo/deploy/server/lib.sh" "$ADMIN_USER@$HOST:/tmp/vitrina-backup-now/" ||
	die "could not upload backup-now.sh"
ssh -t "${SSH_OPTS[@]}" "$ADMIN_USER@$HOST" "sudo bash /tmp/vitrina-backup-now/backup-now.sh $ADMIN_USER" | tee "$work/server.out"
[[ ${PIPESTATUS[0]} -eq 0 ]] || bad "the server's part (above)"
out=$(tr -d '\r' <"$work/server.out")
key=$(sed -n 's/^KEY //p' <<<"$out")
live=$(sed -n 's/^COUNTS //p' <<<"$out")
result=$(sed -n 's/^RESULT //p' <<<"$out")
[[ -n "$key" && -n "$live" ]] || die "no backup came back from the server"

echo
echo "== here: download, decrypt, restore"
t0=$(now_ms)
scp -q "${SSH_OPTS[@]}" "$ADMIN_USER@$HOST:/tmp/vitrina-backup-latest.age" "$work/backup.age" || die "download failed"
ssh "${SSH_OPTS[@]}" "$ADMIN_USER@$HOST" "rm -rf /tmp/vitrina-backup-latest.age /tmp/vitrina-backup-now"
t1=$(now_ms)
size=$(wc -c <"$work/backup.age" | tr -d ' ')
docker exec "$PGC" psql -X -q -U admin -d postgres -v ON_ERROR_STOP=1 -c "DROP DATABASE IF EXISTS $DB" -c "CREATE DATABASE $DB" ||
	die "cannot create the scratch database"
# Plaintext only in the pipe. age authenticates: a wrong key or a damaged file stops here.
if age --decrypt -i "$AGE_IDENTITY" "$work/backup.age" |
	docker exec -i "$PGC" pg_restore --exit-on-error --no-owner --no-acl --dbname="$URL"; then
	pass "the offline key decrypts the backup, and it restores into an empty database"
else
	bad "decrypt or restore failed (above) — if it is the key, the offline copy is not the one the server encrypts to"
fi
t2=$(now_ms)

# --- 3. what came back --------------------------------------------------------------
restored=$(DATABASE_URL=$URL node "$here/counts.mjs")
same=$(node -e '
	const sort = (o) => JSON.stringify(Object.fromEntries(Object.entries(JSON.parse(o)).sort()));
	console.log(sort(process.argv[1]) === sort(process.argv[2]) ? "yes" : "no")' "$live" "$restored")
if [[ "$same" == yes ]]; then pass "row counts equal the live database's at backup time: $restored"
else bad "row counts differ — live $live, restored $restored"; fi

if DATABASE_URL=$URL node "$repo/packages/server/scripts/migrate.mjs" | grep -q '^0 applied'; then
	pass "the migration runner finds nothing to apply"
else bad "the migration runner wanted to apply something"; fi

echo "-- every ready photo's objects, in the live media bucket"
# The environment's DATABASE_URL wins over the file's (node --env-file).
if DATABASE_URL=$URL node --env-file="$STORAGE_ENV" "$here/consistency.mjs"; then pass "the restored rows all point at objects that exist"
else bad "consistency (above)"; fi

echo
echo "backup on the server: $result"
echo "backup size: $size bytes; download $((t1 - t0)) ms; decrypt + restore $((t2 - t1)) ms"
echo
if [[ $fails -eq 0 ]]; then echo "All PASS. Scratch database dropped, ciphertext deleted."; else echo "$fails FAIL"; exit 1; fi

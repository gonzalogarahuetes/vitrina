#!/usr/bin/env bash
#
# Phase 6, rehearsed locally against `pnpm infra:up`. The real backup.sh and
# restore.sh, on scratch databases beside your dev one (never touching it).
#
#   brew install age
#   age-keygen -o ~/vitrina-rehearsal.agekey          # stands in for the offline key
#   pnpm infra:up && pnpm infra:wait
#
#   OWNER_EMAIL=<you> deploy/backup/rehearse.sh source
#                                        API on :3000 over a fresh database and a fresh secret,
#                                        with signup open to you and the scripted canary only
#       … then, in the app (pnpm --filter @vitrina/web dev): sign up, create an
#       album, upload photos, make a QR invite, open it in a second browser.
#   AGE_RECIPIENT=$(age-keygen -y ~/vitrina-rehearsal.agekey) deploy/backup/rehearse.sh backup
#   AGE_IDENTITY=~/vitrina-rehearsal.agekey deploy/backup/rehearse.sh restore
#   AGE_IDENTITY=~/vitrina-rehearsal.agekey deploy/backup/rehearse.sh hide-missing   # deletes one photo
#   deploy/backup/rehearse.sh clean
#
# Standalone, any time after `pnpm infra:up` (its own scratch bucket):
#   AGE_RECIPIENT=$(age-keygen -y ~/vitrina-rehearsal.agekey) deploy/backup/rehearse.sh prune
#
# Written for macOS's bash 3.2.

set -euo pipefail
umask 077

REPO=$(cd "$(dirname "$0")/../.." && pwd)
HERE="$REPO/deploy/backup"
RD=${REHEARSAL_DIR:-${TMPDIR:-/tmp}/vitrina-rehearsal}
PGC=vitrina-postgres
SRC_DB=vitrina_rehearsal_src
DST_DB=vitrina_rehearsal_restored
HIDE_DB=vitrina_rehearsal_hidden
API=http://localhost:3000
APP=http://localhost:5173

fail() { echo "rehearse: $*" >&2; exit 1; }
say() { echo "$*" | tee -a "$RD/report.txt"; }
now_ms() { node -e 'process.stdout.write(String(Date.now()))'; }
dburl() { echo "postgres://admin:password@localhost:5432/$1"; } # compose's public local credentials
example() { grep -E "^$1=" "$REPO/.env.example" | head -1 | cut -d= -f2-; }
psql_admin() { docker exec "$PGC" psql -X -q -U admin -d postgres -v ON_ERROR_STOP=1 -c "$1"; }
ask() { local a; read -r -p "$1 [y/n] " a; [[ "$a" == y || "$a" == Y ]]; }

# The local stack's object store, read from .env.example rather than copied.
S3_ENDPOINT=$(example S3_ENDPOINT)
S3_BUCKET=$(example S3_BUCKET)
AWS_DEFAULT_REGION=$(example AWS_DEFAULT_REGION)
AWS_ACCESS_KEY_ID=$(example AWS_ACCESS_KEY_ID)
AWS_SECRET_ACCESS_KEY=$(example AWS_SECRET_ACCESS_KEY)
export S3_ENDPOINT S3_BUCKET AWS_DEFAULT_REGION AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY

# A separate bucket for backups. Locally one identity writes both; in
# production the backup job has its own credentials and its own env file.
export BACKUP_BUCKET=vitrina-backups-rehearsal BACKUP_PREFIX=rehearsal/
export BACKUP_S3_ENDPOINT=$S3_ENDPOINT BACKUP_S3_REGION=$AWS_DEFAULT_REGION
export BACKUP_AWS_ACCESS_KEY_ID=$AWS_ACCESS_KEY_ID BACKUP_AWS_SECRET_ACCESS_KEY=$AWS_SECRET_ACCESS_KEY
export MEDIA_BUCKET=$S3_BUCKET RETENTION_DAYS=30
export PG_DUMP="docker exec -i $PGC pg_dump" PG_RESTORE="docker exec -i $PGC pg_restore"

preflight() {
	[[ "$(docker inspect -f '{{.State.Running}}' "$PGC" 2>/dev/null)" == true ]] ||
		fail "Postgres is not up: pnpm infra:up && pnpm infra:wait"
	command -v age >/dev/null || fail "brew install age"
}

# --- the API, run exactly as production runs it: built dist, env, a socket ---

api_running() { curl -fsS -m 2 "$API/health" >/dev/null 2>&1; } # GET, never HEAD (api-sketch §11.8)

start_api() { # <db> <secret, or "" for none> <log name>
	! api_running || fail "something already answers on $API — stop your dev API first"
	(
		export CLIENT_ORIGIN=$APP PORT=3000 DATABASE_URL
		# Closed unless the step sets it, as production is (config.ts).
		[[ -z "${SIGNUP_ALLOWLIST:-}" ]] || export SIGNUP_ALLOWLIST
		DATABASE_URL=$(dburl "$1")
		if [[ -n "$2" ]]; then export VITRINA_SERVER_SECRET="$2"; else unset VITRINA_SERVER_SECRET; fi
		exec node "$REPO/packages/server/dist/index.js"
	) >"$RD/$3.log" 2>&1 &
	echo $! >"$RD/api.pid"
	local i
	for i in $(seq 1 40); do
		api_running && return 0
		kill -0 "$(cat "$RD/api.pid")" 2>/dev/null || return 1 # exited
		sleep 0.25
	done
	return 1
}

stop_api() {
	[[ -f "$RD/api.pid" ]] || return 0
	kill "$(cat "$RD/api.pid")" 2>/dev/null || true
	while kill -0 "$(cat "$RD/api.pid")" 2>/dev/null; do sleep 0.1; done
	rm -f "$RD/api.pid"
}

new_secret() { node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("base64url"))'; }

# --- steps ------------------------------------------------------------------

step_source() {
	preflight
	[[ "${OWNER_EMAIL:-}" == *@* ]] || fail "set OWNER_EMAIL to the address you will sign up with"
	[[ ! -e "$RD" ]] || fail "$RD exists — run \`$0 clean\` first"
	mkdir -p "$RD" && chmod 700 "$RD"
	: >"$RD/report.txt"

	pnpm --filter @vitrina/server build >/dev/null
	psql_admin "CREATE DATABASE $SRC_DB"
	DATABASE_URL=$(dburl "$SRC_DB") node "$REPO/packages/server/scripts/migrate.mjs"
	node "$HERE/s3.mjs" ensure-bucket

	# Not the public value in .env.example: production's secret is generated, so this one is.
	new_secret >"$RD/secret"
	# The canary's address is fixed before the API starts, so the allowlist can hold it.
	local canary_email
	canary_email="canary-$(node -e 'console.log(require("node:crypto").randomUUID())')@rehearsal.invalid"
	SIGNUP_ALLOWLIST="$OWNER_EMAIL,$canary_email" \
		start_api "$SRC_DB" "$(cat "$RD/secret")" source || fail "API did not start — $RD/source.log"
	node "$HERE/canary.mjs" signup "$API" "$RD/canary.json" "$canary_email"

	cat <<-EOF

		API up on $API over $SRC_DB, with a fresh server secret.
		Now, with \`pnpm --filter @vitrina/web dev\` at $APP:
		  1. sign up as $OWNER_EMAIL (the only address invited); create an album; upload a few photos
		  2. make a QR invite; open it in a second browser (or a private window)
		Then: AGE_RECIPIENT=\$(age-keygen -y ~/vitrina-rehearsal.agekey) $0 backup
	EOF
}

step_backup() {
	preflight
	[[ -f "$RD/secret" ]] || fail "run \`$0 source\` first"
	[[ -n "${AGE_RECIPIENT:-}" ]] || fail "set AGE_RECIPIENT (age-keygen -y <identity file>)"

	stop_api # quiesce: the counts below must be the counts in the dump
	local src counts
	src=$(dburl "$SRC_DB")
	DATABASE_URL=$src node "$HERE/consistency.mjs" ||
		fail "source content is not ready to rehearse with (see above) — upload photos through the app"
	counts=$(DATABASE_URL=$src node "$HERE/counts.mjs")
	echo "$counts" >"$RD/counts.src.json"
	node -e '
		const c = JSON.parse(process.argv[1]);
		const want = { owners: 2, albums: 1, recipients: 1, media: 1 }; // owners: you + the canary
		const short = Object.entries(want).filter(([t, n]) => !(c[t] >= n));
		if (short.length) { console.error("too little content: " + short.map(([t]) => t).join(", ")); process.exit(1); }
	' "$counts"

	say "== backup"
	say "source counts: $counts"
	local t0 out t1
	t0=$(now_ms)
	# backup.sh refuses an environment holding the server secret; this one does not hold it.
	out=$(DATABASE_URL=$src "$HERE/backup.sh")
	t1=$(now_ms)
	say "$out"
	say "backup wall clock: $((t1 - t0)) ms"

	cat <<-EOF

		The server secret is the one thing this backup must NOT contain, so it is
		about to be deleted. Store it as production will — in your password manager:
		  pbcopy < "$RD/secret"
	EOF
	until ask "Saved in the password manager (and clipboard cleared)?"; do :; done
	rm -f "$RD/secret"
	say "server secret deleted from disk; it now exists only in the password manager"
	echo "Next: AGE_IDENTITY=~/vitrina-rehearsal.agekey $0 restore"
}

step_restore() {
	preflight
	[[ -f "$RD/counts.src.json" && ! -f "$RD/secret" ]] || fail "run \`$0 backup\` first"
	[[ -r "${AGE_IDENTITY:-}" ]] || fail "set AGE_IDENTITY to the age identity file"

	local secret dst t0 t1 out key canary
	read -r -s -p "Paste the server secret from the password manager: " secret
	echo
	node -e 'const b = Buffer.from(process.argv[1], "base64url");
		if (!/^[A-Za-z0-9_-]+$/.test(process.argv[1]) || b.length < 32) process.exit(1)' "$secret" ||
		fail "that is not a base64url secret of at least 32 bytes"

	say "== restore"
	psql_admin "CREATE DATABASE $DST_DB"
	dst=$(dburl "$DST_DB")
	t0=$(now_ms)
	out=$(TARGET_DATABASE_URL=$dst "$HERE/restore.sh")
	t1=$(now_ms)
	say "$out"
	say "restore wall clock: $((t1 - t0)) ms"

	local restored
	restored=$(DATABASE_URL=$dst node "$HERE/counts.mjs")
	if [[ "$restored" == "$(cat "$RD/counts.src.json")" ]]; then say "PASS row counts identical: $restored"
	else say "FAIL row counts differ: restored $restored"; fi

	if DATABASE_URL=$dst node "$REPO/packages/server/scripts/migrate.mjs" | grep -q '^0 applied'; then
		say "PASS migration runner is a no-op on the restored database"
	else say "FAIL migration runner wanted to apply something to the restored database"; fi

	# The secret must not be in the database backup. Scan the decrypted SQL in a
	# pipe (plaintext never written), with a positive control so a scan that read
	# nothing cannot pass.
	key=$(node "$HERE/s3.mjs" latest "$BACKUP_PREFIX")
	node "$HERE/s3.mjs" get "$key" "$RD/scan.age"
	local hex hits control
	hex=$(node -e 'process.stdout.write(Buffer.from(process.argv[1], "base64url").toString("hex"))' "$secret")
	read -r hits control < <(age -d -i "$AGE_IDENTITY" "$RD/scan.age" | $PG_RESTORE -f - |
		awk -v s="$secret" -v h="$hex" 'index($0, s) || index(tolower($0), h) { n++ } /schema_migrations/ { c++ } END { print n+0, c+0 }')
	rm -f "$RD/scan.age"
	if [[ "$control" -gt 0 && "$hits" -eq 0 ]]; then say "PASS server secret absent from the database backup (scanned SQL, control matched)"
	else say "FAIL secret scan: hits=$hits control=$control"; fi

	say "-- consistency: every ready row's objects in the bucket"
	DATABASE_URL=$dst node "$HERE/consistency.mjs" | tee -a "$RD/report.txt" ||
		say "FAIL consistency"

	say "== the server secret, verified by violation"

	# V1. Absent: the API must refuse to boot (brief §6 #17).
	if start_api "$DST_DB" "" v1-no-secret; then
		stop_api; say "FAIL API booted with no server secret"
	elif grep -q 'VITRINA_SERVER_SECRET' "$RD/v1-no-secret.log"; then
		say "PASS no secret: the API refuses to start ($(grep -o 'Missing required env var: [A-Z_]*' "$RD/v1-no-secret.log" | head -1))"
	else say "FAIL API did not start, but not for the secret — see $RD/v1-no-secret.log"; fi
	rm -f "$RD/api.pid"

	# V2. Different: boots, and no owner can sign in — every auth_hash is peppered with the old one.
	start_api "$DST_DB" "$(new_secret)" v2-wrong-secret || fail "API did not start — $RD/v2-wrong-secret.log"
	canary=$(node "$HERE/canary.mjs" login "$API" "$RD/canary.json")
	if [[ "$canary" == "401 INVALID_CREDENTIALS" ]]; then say "PASS wrong secret: canary sign-in refused ($canary)"
	else say "FAIL wrong secret: canary sign-in answered $canary"; fi
	echo "Restored database, WRONG secret. In $APP, sign in as yourself."
	if ask "Did sign-in FAIL?"; then say "PASS wrong secret: owner sign-in refused (owner observed)"
	else say "FAIL wrong secret: owner signed in"; fi
	if ask "Informational — open the invite again in the second browser. Did it open?"; then
		say "NOTE wrong secret: the recipient invite still opens — recipient tokens are unpeppered SHA-256 (schema §6). Losing the secret locks out owners, not recipients."
	else say "NOTE wrong secret: the recipient invite did not open"; fi
	stop_api

	# V3. The restored secret: everything works.
	start_api "$DST_DB" "$secret" v3-restored-secret || fail "API did not start — $RD/v3-restored-secret.log"
	canary=$(node "$HERE/canary.mjs" login "$API" "$RD/canary.json")
	if [[ "$canary" == "200 ok" ]]; then say "PASS restored secret: canary sign-in accepted"
	else say "FAIL restored secret: canary sign-in answered $canary"; fi
	echo "Restored database, RESTORED secret. In $APP: sign in, open the album, open a photo;"
	echo "then open the invite in the second browser."
	if ask "All of that worked?"; then say "PASS restored secret: owner sign-in, album, photo, and recipient invite (owner observed)"
	else say "FAIL restored secret: owner walk incomplete"; fi
	stop_api

	echo
	echo "Report: $RD/report.txt (copy it before \`$0 clean\`)"
	if grep -q '^FAIL' "$RD/report.txt"; then echo "FAILURES above."; exit 1; fi
	echo "All PASS."
}

# restore.sh --hide-missing, by violation, after `restore`: one photo's
# thumbnail is deleted from the bucket, as a §9.11 removal after the backup
# would leave it, and a second restore must hide exactly that row.
step_hide_missing() {
	preflight
	[[ -f "$RD/counts.src.json" ]] || fail "run \`$0 restore\` first"
	[[ -r "${AGE_IDENTITY:-}" ]] || fail "set AGE_IDENTITY to the age identity file"
	local victim out
	victim=$(docker exec "$PGC" psql -X -tA -U admin -d "$DST_DB" -c \
		"SELECT id FROM media WHERE status = 'ready' AND removed_at IS NULL ORDER BY created_at DESC LIMIT 1")
	[[ -n "$victim" ]] || fail "no ready row to sacrifice"
	say "== restore.sh --hide-missing (victim $victim; that photo is gone from here on)"
	node --input-type=module -e '
		const { pathToFileURL } = await import("node:url");
		const dist = new URL("packages/server/dist/", pathToFileURL(process.argv[1] + "/"));
		const { createS3Client } = await import(new URL("composition-root.js", dist));
		const { createObjectStore } = await import(new URL("adapters/driven/s3/object-store.js", dist));
		const { objectKey } = await import(new URL("domain/media/object-key.js", dist));
		const e = process.env;
		const client = createS3Client({ endpoint: e.S3_ENDPOINT, region: e.AWS_DEFAULT_REGION, bucket: e.S3_BUCKET,
			accessKeyId: e.AWS_ACCESS_KEY_ID, secretAccessKey: e.AWS_SECRET_ACCESS_KEY });
		await createObjectStore(client, e.S3_BUCKET).remove(objectKey(process.argv[2], "thumbnail"));
		client.destroy();
	' "$REPO" "$victim"

	if DATABASE_URL=$(dburl "$DST_DB") node "$HERE/consistency.mjs" >/dev/null; then
		say "FAIL control: the read-only check did not notice the missing thumbnail"
	else say "PASS control: the read-only check reports the missing thumbnail and changes nothing"; fi

	psql_admin "CREATE DATABASE $HIDE_DB"
	out=$(TARGET_DATABASE_URL=$(dburl "$HIDE_DB") "$HERE/restore.sh" --hide-missing) || { say "$out"; fail "restore.sh --hide-missing failed"; }
	say "$out"
	local hidden
	hidden=$(docker exec "$PGC" psql -X -tA -U admin -d "$HIDE_DB" -c \
		"SELECT string_agg(id::text, ',') FROM media WHERE removed_at IS NOT NULL AND status = 'ready'")
	if [[ "$hidden" == "$victim" ]]; then say "PASS --hide-missing hid exactly the row whose object is gone"
	else say "FAIL --hide-missing hid [$hidden], expected [$victim]"; fi
	if DATABASE_URL=$(dburl "$HIDE_DB") node "$HERE/consistency.mjs" >/dev/null; then
		say "PASS after hiding, every live ready row is backed by the bucket"
	else say "FAIL after hiding, the read-only check still fails"; fi
	if grep -q '^FAIL' "$RD/report.txt"; then exit 1; fi
}

# Retention against a real bucket. Standalone — needs only `pnpm infra:up` and
# AGE_RECIPIENT — in a scratch bucket of its own. Three real backups (a dump of
# the empty `postgres` maintenance database, encrypted) under backdated names,
# and decoys beside and below the prefix with ancient, well-formed names.
step_prune() {
	preflight
	[[ -n "${AGE_RECIPIENT:-}" ]] || fail "set AGE_RECIPIENT (age-keygen -y <identity file>)"
	export BACKUP_BUCKET=vitrina-prune-rehearsal # scratch, never the backup rehearsal's bucket
	local P=pg/ log="${RD%/}-prune.txt"
	mkdir -p "$(dirname "$log")" && : >"$log"
	pr() { echo "$*" | tee -a "$log"; }
	ago() { node "$HERE/name.mjs" "${2:-$P}" "$(node -e 'console.log(new Date(Date.now() - Number(process.argv[1]) * 864e5).toISOString())' "$1")"; }
	listing() { node "$HERE/s3.mjs" list "" | sort; }
	sorted() { printf '%s\n' "$@" | sort; }

	node "$HERE/s3.mjs" ensure-bucket
	node "$HERE/s3.mjs" delete-prefix pg && node "$HERE/s3.mjs" delete-prefix other/ # a clean start
	PRUNE_TMP=$(mktemp -d) # global: the EXIT trap runs after this function's locals are gone
	trap 'rm -rf "${PRUNE_TMP:-}"' EXIT
	$PG_DUMP --format=custom --no-password "$(dburl postgres)" | age --encrypt -r "$AGE_RECIPIENT" >"$PRUNE_TMP/backup.age"

	local d30 d15 d3 decoys k
	d30=$(ago 30) d15=$(ago 15) d3=$(ago 3)
	decoys="$(ago 400 pgx/) $(ago 400 other/) $(ago 400 pg/sub/) pg/README"
	for k in $d30 $d15 $d3 $decoys; do node "$HERE/s3.mjs" put "$PRUNE_TMP/backup.age" "$k" >/dev/null; done
	local all
	all=$(listing)
	pr "== prune, in $BACKUP_BUCKET: backups $d30 $d15 $d3; decoys $decoys"

	# 1. Dry run: names exactly the two past a 10-day window, deletes nothing.
	local would
	would=$(node "$HERE/s3.mjs" prune "$P" 10 1 --dry-run | sed -n 's/^would prune //p' | sort)
	if [[ "$would" == "$(sorted "$d30" "$d15")" && "$(listing)" == "$all" ]]; then pr "PASS --dry-run lists the 30- and 15-day backups and deletes nothing"
	else pr "FAIL --dry-run listed [$would] or changed the bucket"; fi

	# 2. By violation: prefixes that would reach outside pg/ are refused before any listing.
	local bad
	for bad in "" pg /pg/ "pg/../"; do
		if node "$HERE/s3.mjs" prune "$bad" 1 1 >/dev/null 2>&1; then pr "FAIL prune accepted the prefix \"$bad\""
		elif [[ "$(listing)" != "$all" ]]; then pr "FAIL prune refused \"$bad\" but the bucket changed"
		else pr "PASS prefix \"$bad\" refused, nothing deleted"; fi
	done

	# 3. For real: exactly the two old backups go; the newest and every decoy stay.
	node "$HERE/s3.mjs" prune "$P" 10 1 | tee -a "$log"
	# shellcheck disable=SC2086 # $decoys is a list of keys, by design
	if [[ "$(listing)" == "$(sorted "$d3" $decoys)" ]]; then pr "PASS prune deleted exactly the 30- and 15-day backups; the 3-day one and all four decoys remain"
	else pr "FAIL after prune the bucket holds: $(listing | tr '\n' ' ')"; fi

	# 4. keepMin: a 1-day window would take the 3-day backup, but it is the newest.
	node "$HERE/s3.mjs" prune "$P" 1 1 | tee -a "$log"
	# shellcheck disable=SC2086
	if [[ "$(listing)" == "$(sorted "$d3" $decoys)" ]]; then pr "PASS keepMin kept the last backup however old"
	else pr "FAIL keepMin: the bucket holds $(listing | tr '\n' ' ')"; fi

	node "$HERE/s3.mjs" delete-prefix pg && node "$HERE/s3.mjs" delete-prefix other/
	echo "Report: $log"
	if grep -q '^FAIL' "$log"; then exit 1; fi
	echo "All PASS."
}

step_clean() {
	stop_api || true
	if [[ "$(docker inspect -f '{{.State.Running}}' "$PGC" 2>/dev/null)" == true ]]; then
		# The rehearsal's photos, from the source rows, through the API's own key derivation.
		if docker exec "$PGC" psql -X -tA -U admin -d postgres -c "SELECT 1 FROM pg_database WHERE datname='$SRC_DB'" | grep -q 1; then
			DATABASE_URL=$(dburl "$SRC_DB") node --input-type=module -e '
				const { pathToFileURL } = await import("node:url");
				const dist = new URL("packages/server/dist/", pathToFileURL(process.argv[1] + "/"));
				const { buildComposition } = await import(new URL("composition-root.js", dist));
				const { objectKey } = await import(new URL("domain/media/object-key.js", dist));
				const e = process.env;
				const { adapters } = buildComposition({ serverSecret: Buffer.alloc(32, 1), databaseUrl: e.DATABASE_URL,
					storage: { endpoint: e.S3_ENDPOINT, region: e.AWS_DEFAULT_REGION, bucket: e.S3_BUCKET,
						accessKeyId: e.AWS_ACCESS_KEY_ID, secretAccessKey: e.AWS_SECRET_ACCESS_KEY } });
				const { rows } = await adapters.pool.query("SELECT id::text AS id FROM media");
				for (const { id } of rows) for (const v of ["asset", "thumbnail"]) await adapters.objectStore.remove(objectKey(id, v));
				console.log(`removed objects of ${rows.length} media rows`);
				await adapters.pool.end(); adapters.client.destroy();
			' "$REPO"
		fi
		psql_admin "DROP DATABASE IF EXISTS $HIDE_DB"
		psql_admin "DROP DATABASE IF EXISTS $DST_DB"
		psql_admin "DROP DATABASE IF EXISTS $SRC_DB"
	fi
	node "$HERE/s3.mjs" delete-prefix "$BACKUP_PREFIX" || true
	rm -rf "$RD"
	echo "clean"
}

case "${1:-}" in
source) step_source ;;
backup) step_backup ;;
restore) step_restore ;;
hide-missing) step_hide_missing ;;
prune) step_prune ;;
clean) step_clean ;;
*) fail "usage: $0 source|backup|restore|hide-missing|prune|clean" ;;
esac

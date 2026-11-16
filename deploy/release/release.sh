#!/usr/bin/env bash
#
# Phase 5, on the server, as root — deploy.sh uploads this and runs it:
#   release.sh <release> <api-sha256> <app-sha256> <pnpm-version> <integrity-arm64> <integrity-x64>
#
#   1. checks both uploads against the hashes computed on the Mac
#   2. refuses, changing nothing: an app built for another API host than this
#      server's; and, on production, a release that adds migrations when the
#      newest backup in the bucket is over an hour old (README §3)
#   3. installs pnpm exactly, checked against the lockfile's integrity
#   4. unpacks the API, installs its production dependencies from the lockfile
#   5. unpacks the app
#   6. migrates the database, as the service user
#   7. switches both `current` links, restarts the API, waits for /health
#   8. on failure after the switch: switches back and restarts the old release
#   9. records the release in /opt/vitrina/history (rollback.sh reads it) and
#      keeps the releases of the last two that went live; the rest go
#
# <release> is <UTC time>-<tag>-<commit>: the tag is in the release's name,
# which is how live.sh answers "what's live?".
#
# Releases are root-owned and world-readable: the service reads them, and
# nothing that runs as the service can change them.

set -euo pipefail
umask 022
release=${1:?} api_sha=${2:?} app_sha=${3:?} pnpm_version=${4:?} int_arm64=${5:?} int_x64=${6:?}
here=$(cd "$(dirname "$0")" && pwd)
cd /

fail() { echo "release: $*" >&2; exit 1; }
step() { printf '\n== %s\n' "$*"; }

# Before anything else, so deploy/test/release.test.mjs can check it unprivileged.
[[ "$release" =~ ^[0-9]{8}T[0-9]{6}Z-v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)-[0-9a-f]{12}$ ]] ||
	fail "not a release id (<time>-vX.Y.Z-<commit>): $release"
[[ $EUID -eq 0 ]] || fail "run with sudo"
[[ -f /etc/vitrina/api.env ]] || fail "no /etc/vitrina/api.env — phase 4 (configure.sh) first"

API_ROOT=/opt/vitrina/api
APP_ROOT=/opt/vitrina/app
# Release names, oldest first, one per line: each release that went live, the
# last line the one live now. release.sh appends; rollback.sh removes the last.
HISTORY=/opt/vitrina/history
# site.mjs's default; deploy/test/release.test.mjs keeps the two equal.
PRODUCTION_API_HOST=api.lirioapp.eu
api_dir=$API_ROOT/releases/$release
app_dir=$APP_ROOT/releases/$release

step "uploads"
echo "$api_sha  $here/api.tgz" | sha256sum -c --quiet - || fail "api.tgz is not what the Mac built"
echo "$app_sha  $here/app.tgz" | sha256sum -c --quiet - || fail "app.tgz is not what the Mac built"
echo "both match the Mac's hashes"

# --- refusals, before anything on this server changes ------------------------------------

step "built for this server"
api_host=$(sed -n 's/^API_HOST=//p' /etc/vitrina/site.env 2>/dev/null)
[[ -n "$api_host" ]] || fail "no API_HOST in /etc/vitrina/site.env — provision.sh first"
# check-build.mjs guarantees connect-src names exactly one origin.
index=$(tar -xzOf "$here/app.tgz" ./index.html) || fail "no ./index.html in app.tgz"
built=$(grep -o 'connect-src [^;"]*' <<<"$index" | head -1 || true)
[[ "$built" == "connect-src https://$api_host" ]] ||
	fail "the app was built for '${built#connect-src }', and this server is https://$api_host — check VITRINA_API_HOST and the IP"
echo "the app connects to https://$api_host, this server's API"

step "migrations this release adds"
# The migration rule (README §3): every migration works with the previous
# release's code. What makes undoing one possible is a backup taken just before.
shipped=$(tar -tzf "$here/api.tgz" | sed -n 's|^\(\./\)\{0,1\}packages/server/migrations/\([0-9][0-9][0-9]_[a-z0-9_]*\.sql\)$|\2|p' | sort)
[[ -n "$shipped" ]] || fail "api.tgz holds no migrations"
tables=$(sudo -u postgres psql -d vitrina -qtAc "SELECT count(*) FROM pg_tables WHERE schemaname = 'public'") ||
	fail "cannot query PostgreSQL; nothing changed"
applied=""
if [[ "$tables" != 0 ]]; then
	applied=$(sudo -u postgres psql -d vitrina -qtAc "SELECT filename FROM schema_migrations ORDER BY 1") ||
		fail "the database has tables but no readable schema_migrations; nothing changed"
fi
adds=$(comm -23 <(printf '%s\n' "$shipped") <(printf '%s\n' "$applied" | sort))
if [[ -z "$adds" ]]; then
	echo "none"
elif [[ "$tables" == 0 ]]; then
	echo "$(wc -l <<<"$adds" | tr -d ' ') — onto an empty database (a first deployment): nothing to back up"
elif [[ "$api_host" != "$PRODUCTION_API_HOST" ]]; then
	echo "$adds" | sed 's/^/  /'
	echo "not production ($api_host): the backup rule guards production's data only"
else
	echo "$adds" | sed 's/^/  /'
	again="Run deploy/backup/restore-test.sh <ip> <admin> (it runs backup-now.sh), then deploy again within the hour. Nothing on this server has changed."
	BACKUP_ENV=/etc/vitrina/backup.env
	ops=$API_ROOT/current/ops
	[[ -f "$BACKUP_ENV" ]] || fail "this release adds migrations and production has no $BACKUP_ENV. Nothing on this server has changed."
	[[ -f "$ops/s3.mjs" && -f "$ops/prune.mjs" ]] || fail "no live release to read the backup bucket with ($ops). Nothing on this server has changed."
	benv() { sed -n "s/^$1=//p" "$BACKUP_ENV" | tail -n 1; }
	prefix=$(benv BACKUP_PREFIX)
	prefix=${prefix:-pg/}
	# The bucket's own answer, not anyone's word: the newest backup's name carries its time (prune.mjs).
	newest=$(env -i PATH=/usr/local/bin:/usr/bin:/bin \
		BACKUP_S3_ENDPOINT="$(benv BACKUP_S3_ENDPOINT)" BACKUP_S3_REGION="$(benv BACKUP_S3_REGION)" \
		BACKUP_BUCKET="$(benv BACKUP_BUCKET)" BACKUP_AWS_ACCESS_KEY_ID="$(benv BACKUP_AWS_ACCESS_KEY_ID)" \
		BACKUP_AWS_SECRET_ACCESS_KEY="$(benv BACKUP_AWS_SECRET_ACCESS_KEY)" \
		/usr/local/bin/node "$ops/s3.mjs" latest "$prefix") || fail "could not read the newest backup from the bucket. $again"
	age=$(/usr/local/bin/node --input-type=module -e '
		const { pathToFileURL } = await import("node:url");
		const { parseBackupKey } = await import(pathToFileURL(process.argv[1]));
		const at = parseBackupKey(process.argv[2], process.argv[3]);
		if (!at) process.exit(1);
		console.log(Math.floor((Date.now() - at.getTime()) / 1000));' "$ops/prune.mjs" "$prefix" "$newest") ||
		fail "cannot read a time from the backup's name: $newest"
	# This server's clock wrote the name and reads it now: a time in the future is wrong, not skew.
	if (( age < 0 || age > 3600 )); then
		fail "this release adds migrations, and the newest backup ($newest) is $((age / 60)) minutes old. $again"
	fi
	echo "the newest backup is $((age / 60)) minutes old: $newest"
fi

# --- pnpm, exactly ---------------------------------------------------------------------

step "pnpm $pnpm_version"
case "$(uname -m)" in
aarch64) arch=arm64 integrity=$int_arm64 ;;
x86_64) arch=x64 integrity=$int_x64 ;;
*) fail "unsupported architecture $(uname -m)" ;;
esac
pnpm_dir=/opt/pnpm-$pnpm_version-linux-$arch
if [[ "$("$pnpm_dir/pnpm" --version 2>/dev/null)" != "$pnpm_version" ]]; then
	dl=$(mktemp -d)
	curl -fsSL -o "$dl/pnpm.tgz" "https://registry.npmjs.org/@pnpm/exe.linux-$arch/-/exe.linux-$arch-$pnpm_version.tgz"
	got="sha512-$(openssl dgst -sha512 -binary "$dl/pnpm.tgz" | base64 -w0)"
	[[ "$got" == "$integrity" ]] || fail "the pnpm download does not match pnpm-lock.yaml's integrity"
	tar -xzf "$dl/pnpm.tgz" -C "$dl"
	install -d -m 755 "$pnpm_dir"
	install -m 755 "$dl/package/pnpm" "$pnpm_dir/pnpm"
	rm -rf "$dl"
fi
ln -sfn "$pnpm_dir/pnpm" /usr/local/bin/pnpm
pnpm --version

# --- the API -------------------------------------------------------------------------------

step "api $release"
[[ ! -e "$api_dir" ]] || fail "$api_dir already exists"
install -d -m 755 "$api_dir"
tar -xzf "$here/api.tgz" -C "$api_dir" --no-same-owner --warning=no-unknown-keyword
# From the lockfile, production only, and no package's install scripts:
# none of the server's dependencies has one (checked 28 October 2026), and a
# script that appears later should be a decision, not a side effect.
(cd "$api_dir" && CI=true pnpm install --frozen-lockfile --prod --ignore-scripts \
	--filter "@vitrina/server..." --store-dir /var/cache/vitrina/pnpm-store --reporter=append-only)
# No native code, so nothing built for another platform can be in here.
native=$(find "$api_dir" -name '*.node' -o -name binding.gyp | head -5)
[[ -z "$native" ]] || fail "native code among the dependencies: $native"
[[ -f "$api_dir/packages/server/dist/index.js" ]] || fail "no dist/index.js in the release"
# tar keeps each file's mode from the Mac, where some repository files are 600
# (measured on the first deploy: the migrations were unreadable to the service
# user). Normalised here, whatever the archive says: readable by all, written by root.
chmod -R u=rwX,go=rX "$api_dir"
sudo -u vitrina test -r "$api_dir/packages/server/migrations/001_initial_schema.sql" ||
	fail "the service user cannot read the release"

# --- the app ---------------------------------------------------------------------------------

step "app $release"
[[ ! -e "$app_dir" ]] || fail "$app_dir already exists"
install -d -m 755 "$app_dir"
tar -xzf "$here/app.tgz" -C "$app_dir" --no-same-owner --warning=no-unknown-keyword
[[ -f "$app_dir/index.html" ]] || fail "no index.html in the app bundle"
chmod -R u=rwX,go=rX "$app_dir" # as above: Caddy serves these as its own user
sudo -u caddy test -r "$app_dir/index.html" || fail "Caddy cannot read the app"

# --- migrations -------------------------------------------------------------------------------

step "migrations"
# The runner is idempotent and forward-only: a re-run applies nothing.
db_url=$(sed -n 's/^DATABASE_URL=//p' /etc/vitrina/api.env)
sudo -u vitrina env DATABASE_URL="$db_url" /usr/local/bin/node "$api_dir/packages/server/scripts/migrate.mjs"

# --- switch, restart, health --------------------------------------------------------------------

link() { ln -sfn "$1" "$2.new" && mv -T "$2.new" "$2"; } # atomic: rename over the old link
prev_api=$(readlink "$API_ROOT/current" 2>/dev/null || true)
prev_app=$(readlink "$APP_ROOT/current" 2>/dev/null || true)
prev_id=""
[[ -z "$prev_app" ]] || prev_id=$(basename "$prev_app")

healthy() {
	local i
	for i in $(seq 1 30); do
		# GET, never HEAD: the API answers no HEAD (api-sketch §11.8).
		[[ "$(curl -fsS --max-time 2 http://127.0.0.1:3000/health 2>/dev/null)" == '{"status":"ok"}' ]] && return 0
		sleep 1
	done
	return 1
}

step "switch to $release"
link "$api_dir/packages/server" "$API_ROOT/current"
link "$app_dir" "$APP_ROOT/current"
systemctl restart vitrina-api
if ! healthy; then
	journalctl -u vitrina-api -n 40 --no-pager -o cat || true
	if [[ -n "$prev_api" && -n "$prev_app" ]]; then
		link "$prev_api" "$API_ROOT/current"
		link "$prev_app" "$APP_ROOT/current"
		systemctl restart vitrina-api
		healthy && echo "ROLLED BACK to $(basename "$(dirname "$(dirname "$prev_api")")")" >&2
	fi
	fail "$release did not become healthy (log above); the migrations it ran stay applied"
fi
echo "healthy: GET http://127.0.0.1:3000/health"

# The history, as soon as it is live: a check failing below must not leave it
# disagreeing with the links. What was live before goes in first if the history
# does not end with it (the first tagged release, or a link changed by hand),
# so rollback.sh can return to it. Two lines kept: rollback goes back one.
{
	[[ ! -s "$HISTORY" ]] || cat "$HISTORY"
	[[ -z "$prev_id" || "$(tail -n 1 "$HISTORY" 2>/dev/null)" == "$prev_id" ]] || echo "$prev_id"
	echo "$release"
} | tail -n 2 >"$HISTORY.new"
chmod 644 "$HISTORY.new"
mv -f "$HISTORY.new" "$HISTORY"
echo "history: $(tr '\n' ' ' <"$HISTORY")"

# Loopback only, whatever the environment says — ExecStart pins it.
listen=$(ss -Hltn 'sport = :3000' | awk '{print $4}' | sort -u | tr '\n' ' ')
[[ "$listen" =~ ^(127\.0\.0\.1:3000\ )+$ ]] || fail "the API listens on: $listen"
echo "listening on loopback only: $listen"

# --- keep the releases of the last two that went live --------------------------------------------

# Releases that never went live (a failed migration, an unhealthy start) go
# here too: rollback must never land on one.
for root in "$API_ROOT" "$APP_ROOT"; do
	for old in "$root"/releases/*; do
		grep -qxF "$(basename "$old")" "$HISTORY" || rm -rf "$old"
	done
done

rm -rf "$here"
step "released $release"

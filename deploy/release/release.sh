#!/usr/bin/env bash
#
# Phase 5, on the server, as root — deploy.sh uploads this and runs it:
#   release.sh <release> <api-sha256> <app-sha256> <pnpm-version> <integrity-arm64> <integrity-x64>
#
#   1. checks both uploads against the hashes computed on the Mac
#   2. installs pnpm exactly, checked against the lockfile's integrity
#   3. unpacks the API, installs its production dependencies from the lockfile
#   4. unpacks the app
#   5. migrates the database, as the service user
#   6. switches both `current` links, restarts the API, waits for /health
#   7. on failure after the switch: switches back and restarts the old release
#   8. keeps the three newest releases of each
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

[[ $EUID -eq 0 ]] || fail "run with sudo"
[[ "$release" =~ ^[0-9]{8}T[0-9]{6}Z-[0-9a-f]{7,40}$ ]] || fail "not a release id: $release"
[[ -f /etc/vitrina/api.env ]] || fail "no /etc/vitrina/api.env — phase 4 (configure.sh) first"

API_ROOT=/opt/vitrina/api
APP_ROOT=/opt/vitrina/app
api_dir=$API_ROOT/releases/$release
app_dir=$APP_ROOT/releases/$release

step "uploads"
echo "$api_sha  $here/api.tgz" | sha256sum -c --quiet - || fail "api.tgz is not what the Mac built"
echo "$app_sha  $here/app.tgz" | sha256sum -c --quiet - || fail "app.tgz is not what the Mac built"
echo "both match the Mac's hashes"

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
chmod -R go-w "$api_dir"

# --- the app ---------------------------------------------------------------------------------

step "app $release"
[[ ! -e "$app_dir" ]] || fail "$app_dir already exists"
install -d -m 755 "$app_dir"
tar -xzf "$here/app.tgz" -C "$app_dir" --no-same-owner --warning=no-unknown-keyword
[[ -f "$app_dir/index.html" ]] || fail "no index.html in the app bundle"
chmod -R go-w "$app_dir"

# --- migrations -------------------------------------------------------------------------------

step "migrations"
# The runner is idempotent and forward-only: a re-run applies nothing.
db_url=$(sed -n 's/^DATABASE_URL=//p' /etc/vitrina/api.env)
sudo -u vitrina env DATABASE_URL="$db_url" /usr/local/bin/node "$api_dir/packages/server/scripts/migrate.mjs"

# --- switch, restart, health --------------------------------------------------------------------

link() { ln -sfn "$1" "$2.new" && mv -T "$2.new" "$2"; } # atomic: rename over the old link
prev_api=$(readlink "$API_ROOT/current" 2>/dev/null || true)
prev_app=$(readlink "$APP_ROOT/current" 2>/dev/null || true)

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

# Loopback only, whatever the environment says — ExecStart pins it.
listen=$(ss -Hltn 'sport = :3000' | awk '{print $4}' | sort -u | tr '\n' ' ')
[[ "$listen" =~ ^(127\.0\.0\.1:3000\ )+$ ]] || fail "the API listens on: $listen"
echo "listening on loopback only: $listen"

# --- keep three of each -----------------------------------------------------------------------------

for root in "$API_ROOT" "$APP_ROOT"; do
	keep=$(readlink -f "$root/current")
	ls -1dt "$root"/releases/* | tail -n +4 | while read -r old; do
		[[ "$keep" == "$old"* ]] || rm -rf "$old"
	done
done

rm -rf "$here"
step "released $release"

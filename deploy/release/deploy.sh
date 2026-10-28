#!/usr/bin/env bash
#
# Phase 5: build a commit on the Mac, release it on the server, check it from
# outside. Fails loudly at the first thing that is not as it should be.
#
#   deploy/release/deploy.sh <ip> <admin-user>
#
# Builds: the envelope WASM (the web bundle inlines it), the server, and the
# web app with VITE_API_ORIGIN=https://api.lirioapp.eu. Ships the server as
# compiled JavaScript plus every workspace manifest and the lockfile; the
# server installs its production dependencies from that lockfile itself
# (--frozen-lockfile --prod), never node_modules copied from macOS.
#
# SSH_KEY defaults to ~/.ssh/vitrina_hetzner, and must be in the agent.
# Written for macOS's bash 3.2.

set -euo pipefail
HOST=${1:?usage: deploy.sh <ip> <admin-user>}
ADMIN_USER=${2:?usage: deploy.sh <ip> <admin-user>}
KEY=${SSH_KEY:-$HOME/.ssh/vitrina_hetzner}
here=$(cd "$(dirname "$0")" && pwd)
repo=$(cd "$here/../.." && pwd)
API_ORIGIN=https://api.lirioapp.eu
SSH_OPTS=(-i "$KEY" -o IdentitiesOnly=yes -o ConnectTimeout=10)

fail() { echo "deploy: $*" >&2; exit 1; }
step() { printf '\n== %s\n' "$*"; }
cd "$repo"

# --- preconditions ----------------------------------------------------------------

fingerprint=$(ssh-keygen -lf "$KEY.pub" 2>/dev/null | awk '{print $2}')
ssh-add -l 2>/dev/null | grep -qF "${fingerprint:-none}" || fail "load the key first: ssh-add --apple-use-keychain $KEY"

# What runs on the server is a commit, so the repository can say what it was.
[[ -z "$(git status --porcelain)" ]] || fail "uncommitted changes — commit first, so the release is a commit"
commit=$(git rev-parse --short=12 HEAD)
release="$(date -u +%Y%m%dT%H%M%SZ)-$commit"

# pnpm for the server: the version root package.json pins, and the integrity
# of its native executable as the lockfile records it.
pnpm_version=$(node -p 'require("./package.json").packageManager.replace(/^pnpm@/, "")')
integrity() { # <arch>
	awk -v k="  '@pnpm/exe.linux-$1@$pnpm_version':" '$0 == k { getline; sub(/.*integrity: /, ""); sub(/}$/, ""); print; exit }' pnpm-lock.yaml
}
int_arm64=$(integrity arm64)
int_x64=$(integrity x64)
[[ "$int_arm64" == sha512-* && "$int_x64" == sha512-* ]] || fail "pnpm-lock.yaml does not pin @pnpm/exe.linux-* $pnpm_version"

# --- build --------------------------------------------------------------------------

step "build $release"
pnpm install --frozen-lockfile >/dev/null
pnpm --filter @vitrina/envelope build:wasm
pnpm --filter @vitrina/server build
# check-build.mjs runs inside `build` and refuses a connect-src naming anything else.
VITE_API_ORIGIN=$API_ORIGIN pnpm --filter @vitrina/web build
grep -q "connect-src $API_ORIGIN" packages/web/build/index.html || fail "the built app does not connect to $API_ORIGIN"
! grep -q "localhost" packages/web/build/index.html || fail "the built app mentions localhost"
[[ -f packages/server/dist/index.js && -f packages/shared/dist/index.js ]] || fail "server or shared not built"

# --- bundle -----------------------------------------------------------------------------

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
# COPYFILE_DISABLE: no macOS ._ files or extended attributes in the archives.
COPYFILE_DISABLE=1 tar -czf "$work/api.tgz" --exclude='*.tsbuildinfo' \
	package.json pnpm-lock.yaml pnpm-workspace.yaml packages/*/package.json \
	packages/server/dist packages/server/migrations packages/server/scripts packages/shared/dist
COPYFILE_DISABLE=1 tar -czf "$work/app.tgz" -C packages/web/build .
api_sha=$(shasum -a 256 "$work/api.tgz" | cut -d' ' -f1)
app_sha=$(shasum -a 256 "$work/app.tgz" | cut -d' ' -f1)
echo "api.tgz $(wc -c <"$work/api.tgz" | tr -d ' ') bytes, app.tgz $(wc -c <"$work/app.tgz" | tr -d ' ') bytes"

# --- release on the server ------------------------------------------------------------------

step "upload and release (sudo password)"
remote=/tmp/vitrina-release-$release
ssh "${SSH_OPTS[@]}" "$ADMIN_USER@$HOST" "mkdir -m 700 $remote"
scp -q "${SSH_OPTS[@]}" "$work/api.tgz" "$work/app.tgz" "$here/release.sh" "$ADMIN_USER@$HOST:$remote/"
ssh -t "${SSH_OPTS[@]}" "$ADMIN_USER@$HOST" \
	"sudo bash $remote/release.sh $release $api_sha $app_sha $pnpm_version $int_arm64 $int_x64"

# --- from outside ---------------------------------------------------------------------------------

step "from outside"
node "$here/public-check.mjs"
echo
echo "released $release"

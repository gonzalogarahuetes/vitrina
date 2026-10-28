#!/usr/bin/env bash
#
# Once, on the owner's Mac: pin the SHA-256 of the Node tarballs the server
# installs, after checking nodejs.org's signature over the checksum list.
# Writes deploy/server/node.sha256, which the owner commits; provision.sh
# installs nothing that does not match it (as CI pins wasm-bindgen).
#
#   brew install gnupg
#   deploy/server/pin-node.sh
#
# The keyring is the Node project's own (nodejs/release-keys), the
# verification its documented one: gpgv against SHASUMS256.txt.sig.

set -euo pipefail

VERSION=v22.23.4 # CI's NODE_VERSION and compose's migrate image, as of the owner's bump
here=$(cd "$(dirname "$0")" && pwd)
command -v gpgv >/dev/null || { echo "pin-node: brew install gnupg" >&2; exit 1; }

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
cd "$work"
curl -fsSLO "https://nodejs.org/dist/$VERSION/SHASUMS256.txt"
curl -fsSLO "https://nodejs.org/dist/$VERSION/SHASUMS256.txt.sig"
curl -fsSLo pubring.kbx https://github.com/nodejs/release-keys/raw/HEAD/gpg-only-active-keys/pubring.kbx
gpgv --keyring="$work/pubring.kbx" SHASUMS256.txt.sig SHASUMS256.txt

grep -E "  node-$VERSION-linux-(x64|arm64)\.tar\.xz\$" SHASUMS256.txt >"$here/node.sha256"
[[ $(wc -l <"$here/node.sha256") -eq 2 ]] || { echo "pin-node: expected two tarball lines" >&2; exit 1; }
echo "pinned (commit deploy/server/node.sha256):"
cat "$here/node.sha256"

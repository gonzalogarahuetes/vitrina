#!/usr/bin/env bash
#
# Builds crates/envelope-wasm for wasm32-unknown-unknown and runs wasm-bindgen
# over it. `--target web` is the artifact a browser loads; the harness feeds
# the same files to Node by reading the .wasm bytes itself.
#
# wasm-bindgen-cli must match the wasm-bindgen crate in Cargo.lock exactly.
# The CLI checks this itself and refuses a mismatched module, so no version
# check is repeated here.

set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$(cd ../.. && pwd)"

cargo build --release --target wasm32-unknown-unknown -p vitrina-envelope-wasm \
	--manifest-path "$ROOT/Cargo.toml"

rm -rf wasm dist/wasm
wasm-bindgen --target web --out-dir wasm --out-name envelope \
	"$ROOT/target/wasm32-unknown-unknown/release/vitrina_envelope_wasm.wasm"

# tsc emits dist/test/*.js and copies nothing else; the glue sits beside it.
mkdir -p dist/wasm
cp wasm/envelope.js wasm/envelope_bg.wasm dist/wasm/

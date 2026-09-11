#!/usr/bin/env bash
# Builds crates/envelope-wasm and runs wasm-bindgen over it. `--target web` is
# what a browser loads; the harness feeds Node the same files. The CLI itself
# refuses a module built against a different wasm-bindgen version.

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

#!/usr/bin/env bash
# Every file under crates/envelope/src/ containing `#[test]` must also carry the
# `wasm_bindgen_test as test` alias; without it those tests compile for wasm32
# and silently never run. Blunt on purpose: lib.rs's cfg graph is not read.

# Scoped to crates/envelope/src/: this script and ci.yml contain the alias text,
# so a wider grep would match itself (see check-forbidden-constructions.sh).
# Run locally with: ./scripts/check-wasm-test-alias.sh

set -euo pipefail

cd "$(dirname "$0")/.."

SEARCH_PATH=crates/envelope/src
TEST_ATTR='#[test]'
ALIAS='wasm_bindgen_test as test'

if [[ ! -d "$SEARCH_PATH" ]]; then
	echo "check-wasm-test-alias: $SEARCH_PATH does not exist; nothing to scan" >&2
	exit 1
fi

missing=()
scanned=0
while IFS= read -r -d '' file; do
	# -q quiet, -F literal string: neither pattern is a regex.
	if grep -qF "$TEST_ATTR" "$file"; then
		scanned=$((scanned + 1))
		if ! grep -qF "$ALIAS" "$file"; then
			missing+=("$file")
		fi
	fi
done < <(find "$SEARCH_PATH" -type f -name '*.rs' -print0 | sort -z)

if [[ $scanned -eq 0 ]]; then
	echo "check-wasm-test-alias: no file under $SEARCH_PATH contains $TEST_ATTR; the layout has changed" >&2
	exit 1
fi

if [[ ${#missing[@]} -gt 0 ]]; then
	echo
	echo "WASM TEST ALIAS MISSING: ${#missing[@]} file(s) contain $TEST_ATTR without the alias"
	echo
	for file in "${missing[@]}"; do
		echo "  $file"
	done
	echo
	cat <<-EOT
		Each test module in crates/envelope must carry

		    #[cfg(target_arch = "wasm32")]
		    use wasm_bindgen_test::wasm_bindgen_test as test;

		next to its other imports. Without it the module's #[test] functions
		compile for wasm32-unknown-unknown and never run there, and nothing
		fails — the wasm32 test count simply does not move. Add the alias to
		the file(s) named above; do not widen this check's exclusions.
	EOT
	echo
	exit 1
fi

echo "check-wasm-test-alias: clean ($scanned test files under $SEARCH_PATH carry the alias)"

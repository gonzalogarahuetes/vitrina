#!/usr/bin/env bash
#
# `crypto_secretstream_xchacha20poly1305` — and every other sequential-only
# streaming construction — is forbidden in Vitrina. It is the idiomatic answer
# to "how do I encrypt a stream" and it is the wrong answer here: it chains
# each chunk's state to the previous one, so chunk N is only decryptable after
# chunks 0..N-1. Vitrina requires that any chunk be decryptable from the key,
# the header, and that chunk's bytes alone, because Phase 3 video seeking is
# random access into ciphertext. The envelope format is permanent — the relay
# cannot decrypt, therefore it cannot migrate — so this cannot be fixed later.
#
# See: CLAUDE.md "Hard rules", spec/vitrina-encryption-spec.md,
#      spec/vitrina-project-brief.md §6.
#
# SCOPE. Only application source is searched: crates/ and packages/.
# The banned identifier appears LEGITIMATELY in spec/ and CLAUDE.md, because
# that is where the ban is written down. A tree-wide grep would match the ban
# itself and fail the build unconditionally, forever — so those paths, along
# with build output and vendored dependencies, are outside the search.
#
# Run locally with: pnpm check:forbidden

set -euo pipefail

cd "$(dirname "$0")/.."

# Paths that are application source. Everything else — spec/, CLAUDE.md,
# .github/ (this rule's own workflow step), README.md — is out of scope.
SEARCH_PATHS=(crates packages)

# Excluded even inside the search paths: vendored deps and build output, which
# may legitimately contain a libsodium binding and are not our code.
EXCLUDE_DIRS=(node_modules target dist build .svelte-kit)

# Sequential-only streaming constructions. Add to this list, do not remove.
FORBIDDEN=(
	crypto_secretstream
)

exclude_args=()
for dir in "${EXCLUDE_DIRS[@]}"; do
	exclude_args+=("--exclude-dir=$dir")
done

present_paths=()
for path in "${SEARCH_PATHS[@]}"; do
	if [[ -d "$path" ]]; then
		present_paths+=("$path")
	fi
done

if [[ ${#present_paths[@]} -eq 0 ]]; then
	echo "check-forbidden-constructions: none of ${SEARCH_PATHS[*]} exist; nothing to scan" >&2
	exit 1
fi

status=0
for needle in "${FORBIDDEN[@]}"; do
	# -r recursive, -n line numbers, -I skip binaries, -F literal string.
	if hits=$(grep -rnIF "$needle" "${exclude_args[@]}" "${present_paths[@]}"); then
		status=1
		echo
		echo "FORBIDDEN CONSTRUCTION: '$needle' found in application source"
		echo
		echo "$hits"
		echo
		cat <<-EOF
			Vitrina forbids crypto_secretstream_xchacha20poly1305 and every other
			sequential-only streaming construction (CLAUDE.md, "Hard rules";
			project brief §6).

			Why: these constructions chain each chunk's state to the previous one,
			so chunk N can only be decrypted after decrypting chunks 0..N-1. The
			envelope format requires the opposite property — any chunk must be
			decryptable from the key, the header, and that chunk's bytes alone.
			Phase 3 video seeking is random access into ciphertext, and chunk
			offsets are computed arithmetically rather than discovered by scanning.
			A sequential construction makes both impossible.

			Why it cannot be fixed later: the relay stores ciphertext it cannot
			read, so it cannot migrate the format. Whatever ships is permanent.

			This check is not the rule — it is a reminder of the rule. Deleting it
			does not make the construction safe to use. If you believe you have a
			genuine reason to reference this identifier in application source,
			stop and raise it rather than widening the exclusions here.
		EOF
		echo
	fi
done

if [[ $status -eq 0 ]]; then
	echo "check-forbidden-constructions: clean (${present_paths[*]})"
fi

exit $status

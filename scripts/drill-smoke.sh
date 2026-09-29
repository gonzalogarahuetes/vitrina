#!/usr/bin/env bash
#
# Verify-by-violation for infra/smoke.test.mjs — DISPOSABLE. Delete it once it
# has run; it is a one-off check that the smoke harness asserts what it claims,
# not a check anyone needs to run again.
#
# Each drill breaks one thing, rebuilds, runs the smoke file alone, and expects
# a NAMED step to fail. A drill that stays green is the finding: the harness is
# passing for a reason other than the one it says.
#
# Needs the stack: pnpm infra:up && pnpm infra:wait
set -uo pipefail
cd "$(dirname "$0")/.."

USE_CASE=packages/server/src/application/use-cases/upload-media-object.ts
REPOSITORY=packages/server/src/adapters/driven/postgres/media-repository.ts
SMOKE=infra/smoke.test.mjs

# Tracked AND clean. An UNTRACKED file passes `git diff --quiet` trivially and
# then cannot be restored by `git checkout --`, which would leave a drill edit
# in the tree — the one failure mode of this script that is worse than useless.
for file in "$USE_CASE" "$REPOSITORY" "$SMOKE"; do
	if ! git ls-files --error-unmatch "$file" >/dev/null 2>&1; then
		echo "refusing to run: $file is not tracked, so it cannot be restored."
		echo "Commit it first."
		exit 1
	fi
done
if ! git diff --quiet -- "$USE_CASE" "$REPOSITORY" "$SMOKE"; then
	echo "refusing to run: those three files have uncommitted changes, and this"
	echo "script reverts with git checkout. Commit or stash first."
	exit 1
fi

restore() { git checkout -- "$USE_CASE" "$REPOSITORY" "$SMOKE"; }
trap restore EXIT

# Runs the smoke file and reports whether $1 was among the failures.
expect_failure() {
	local step="$1" label="$2" output
	pnpm --filter @vitrina/server build >/dev/null 2>&1 || {
		echo "BUILD FAILED — the drill edit did not compile, so it proved nothing"
		return 1
	}
	output=$(node --test "$SMOKE" 2>&1)

	# Unanchored: the spec reporter's indentation is not worth depending on.
	if grep -qE "(✖|not ok [0-9]+ - )\s*${step}" <<<"$output"; then
		echo "RED as expected  — ${label}"
		return 0
	fi
	echo "STILL GREEN      — ${label}"
	echo "  the harness does not see this break. That is the finding."
	grep -E "^ℹ (pass|fail)" <<<"$output" | sed 's/^/  /'
	return 1
}

failures=0

echo "== drill 1: ready on the FIRST object =="
# The absent-other branch marks ready instead of leaving processing. Marking
# rather than deleting the guard, so `other` stays narrowed and this compiles —
# a drill that fails to build proves nothing. Step 5 passes against this, which
# is the whole reason step 4 is a separate assertion.
perl -0pi -e 's/      if \(!other\) \{\n        const row/      if (!other) {\n        await deps.media.markReady(media.id, written.length);\n        const row/' "$USE_CASE"
git diff --quiet -- "$USE_CASE" && { echo "PATCH DID NOT APPLY — the source has moved; fix the pattern"; failures=1; } || {
	expect_failure "4\\." "step 4 must fail: the row reaches ready with one object" || failures=1
}
git checkout -- "$USE_CASE"

echo
echo "== drill 2: a ready row accepts another upload =="
perl -0pi -e 's/return mediaRow\.row_exists \? "already_ready" : null;/return mediaRow.row_exists ? "started" : null;/' "$REPOSITORY"
git diff --quiet -- "$REPOSITORY" && { echo "PATCH DID NOT APPLY"; failures=1; } || {
	expect_failure "9\\." "step 9 must fail: the second upload is no longer 409" || failures=1
}
git checkout -- "$REPOSITORY"

echo
echo "== drill 3: step 6 reads the store at all =="
perl -0pi -e 's{/asset`\)\n\tconst thumbnail}{/assets`)\n\tconst thumbnail}' "$SMOKE"
git diff --quiet -- "$SMOKE" && { echo "PATCH DID NOT APPLY"; failures=1; } || {
	expect_failure "6\\." "step 6 must fail: a key that was never written" || failures=1
}
git checkout -- "$SMOKE"

echo
if [ "$failures" -eq 0 ]; then
	echo "all three drills went red. The harness asserts what it says it does."
else
	echo "at least one drill did not behave — see above."
fi
exit "$failures"

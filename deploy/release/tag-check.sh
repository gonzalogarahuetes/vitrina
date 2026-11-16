#!/usr/bin/env bash
#
# Only tags on main are deployable. Run from the repository root (deploy.sh
# does); prints "<tag> <commit>" for the checkout, or refuses when:
#
#   - the tree is not clean: tracked changes or untracked files
#   - HEAD carries no tag of the form vMAJOR.MINOR.PATCH, or more than one
#   - origin does not have that tag, or origin's tag names another commit
#     (a tag that exists only here, or was moved, cannot answer "what's live?")
#   - the commit is not on origin/main, as fetched just now
#
#   deploy/release/tag-check.sh
#
# Fetches origin/main first: a stale copy would answer for an older main.
# deploy/test/release.test.mjs violates each refusal. Written for macOS's bash 3.2.

set -euo pipefail
fail() { echo "deploy: $*" >&2; exit 1; }
# No leading zeros: v1.02.3 and v1.2.3 would otherwise be two names for one version.
TAG_RE='^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$'

[[ -z "$(git status --porcelain)" ]] ||
	fail "the tree is not clean (git status) — a release is a tagged commit and nothing else"

commit=$(git rev-parse HEAD)
short=$(git rev-parse --short=12 HEAD)
tags=$(git tag --points-at HEAD | grep -E "$TAG_RE" || true)
[[ -n "$tags" ]] || fail "$short has no vMAJOR.MINOR.PATCH tag — tag it on main and push the tag, then: git checkout vX.Y.Z"
[[ "$(printf '%s\n' "$tags" | wc -l | tr -d ' ')" == 1 ]] ||
	fail "$short carries more than one version tag ($(printf '%s ' $tags)) — which release is it?"
tag=$tags

git fetch --quiet --no-tags origin main || fail "could not fetch origin main"

remote=$(git ls-remote origin "refs/tags/$tag" "refs/tags/$tag^{}") || fail "could not ask origin for $tag"
# An annotated tag's commit is on its ^{} line; a lightweight tag's is on its own.
remote_commit=$(awk '$2 ~ /\^\{\}$/ { print $1; found = 1; exit } { first = $1 } END { if (!found) print first }' <<<"$remote")
[[ -n "$remote_commit" ]] || fail "origin has no tag $tag — push it first: git push origin $tag"
[[ "$remote_commit" == "$commit" ]] || fail "origin's $tag is ${remote_commit:0:12}, not $short — tags are never moved; make a new one"

git merge-base --is-ancestor "$commit" refs/remotes/origin/main ||
	fail "$tag ($short) is not on origin/main — only tags on main are deployable"

echo "$tag $short"

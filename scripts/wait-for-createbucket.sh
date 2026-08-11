#!/usr/bin/env bash
#
# Block until the compose `createbucket` service has exited 0.
#
# `createbucket` is a one-shot seeder: it waits for the SeaweedFS S3 gateway to
# answer, creates the vitrina-media bucket, and exits. `docker compose up -d`
# returns once containers have *started*, which says nothing about whether the
# bucket exists yet — so anything that runs straight afterwards races the seed.
#
# This polls the container's real exit status rather than sleeping a fixed
# number of seconds. A fixed sleep is either too short (flaky on a loaded CI
# runner) or too long (wasted on every green run), and it never tells you the
# difference between "slow" and "failed".
#
# Usage: scripts/wait-for-createbucket.sh [timeout-seconds]   (default 180)

set -euo pipefail

cd "$(dirname "$0")/.."

SERVICE=createbucket
TIMEOUT=${1:-180}
POLL_INTERVAL=2

fail() {
	echo "$*" >&2
	echo >&2
	echo "--- docker compose ps -a ---" >&2
	docker compose ps -a >&2 || true
	echo >&2
	echo "--- $SERVICE logs ---" >&2
	docker compose logs --no-color "$SERVICE" >&2 || true
	echo >&2
	echo "--- seaweedfs logs (tail) ---" >&2
	docker compose logs --no-color --tail=50 seaweedfs >&2 || true
	exit 1
}

echo "waiting up to ${TIMEOUT}s for '$SERVICE' to exit 0..."

deadline=$((SECONDS + TIMEOUT))

# The container may not be registered the instant `up -d` returns.
container=""
while [[ -z "$container" ]]; do
	container=$(docker compose ps -aq "$SERVICE" 2>/dev/null | head -1 || true)
	if [[ -n "$container" ]]; then
		break
	fi
	if ((SECONDS >= deadline)); then
		fail "timed out: no container for service '$SERVICE' ever appeared"
	fi
	sleep "$POLL_INTERVAL"
done

while :; do
	state=$(docker inspect -f '{{.State.Status}}' "$container" 2>/dev/null || echo unknown)
	case "$state" in
	exited)
		code=$(docker inspect -f '{{.State.ExitCode}}' "$container")
		if [[ "$code" == "0" ]]; then
			echo "'$SERVICE' exited 0 after ~${SECONDS}s; bucket is seeded"
			exit 0
		fi
		fail "'$SERVICE' exited $code — the bucket was not seeded"
		;;
	dead)
		fail "'$SERVICE' container is dead"
		;;
	esac

	if ((SECONDS >= deadline)); then
		fail "timed out after ${TIMEOUT}s with '$SERVICE' in state '$state'"
	fi
	sleep "$POLL_INTERVAL"
done

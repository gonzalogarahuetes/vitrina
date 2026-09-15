#!/usr/bin/env bash
#
# Block until a compose one-shot service has exited 0.
#
# The stack has two one-shots, each provisioning a backing service during `up`
# rather than as a step somebody has to remember afterwards:
#
#   createbucket — waits for the SeaweedFS S3 gateway, creates vitrina-media
#   migrate      — waits for Postgres to be healthy, applies every migration
#                  in packages/server/migrations/ that the database lacks
#
# `docker compose up -d` returns once containers have *started*, which says
# nothing about whether either has finished — so anything that runs straight
# afterwards races them. This polls the container's real exit status rather
# than sleeping a fixed number of seconds. A fixed sleep is either too short
# (flaky on a loaded CI runner) or too long (wasted on every green run), and it
# never tells you the difference between "slow" and "failed".
#
# A non-zero exit is the one-shot's own verdict. Both are written so that their
# last statement is the thing that fails when the work failed; there is no
# `|| true` between the work and the exit code, and none should be added.
#
# Usage: scripts/wait-for-oneshot.sh <service> [timeout-seconds]   (default 180)

set -euo pipefail

cd "$(dirname "$0")/.."

SERVICE=${1:?service name required}
TIMEOUT=${2:-180}
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
	echo "--- stack logs (tail) ---" >&2
	docker compose logs --no-color --tail=50 >&2 || true
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
			echo "'$SERVICE' exited 0 after ~${SECONDS}s"
			exit 0
		fi
		fail "'$SERVICE' exited $code"
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

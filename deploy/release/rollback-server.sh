#!/usr/bin/env bash
#
# On the server, as root — rollback.sh uploads this and runs it:
#   rollback-server.sh
#
#   1. reads /opt/vitrina/history (release.sh writes it): the release before
#      the one live is the target. Refuses if there is none, if the history's
#      last line is not what is live, or if the target's files are gone
#   2. lists the migrations the live release added over the target: they stay
#      applied — the migration rule (README §3) is what makes that safe
#   3. switches both `current` links to the target, restarts the API, waits
#      for /health; if it never answers, switches back and says so
#   4. leaves the target alone in the history, so a second rollback refuses:
#      the migration rule covers the previous release's code, not the one
#      before it. After a rollback, fix forward
#
# Never touches the database: no migration, no query, no restore.

set -euo pipefail
cd /

fail() { echo "rollback: $*" >&2; exit 1; }
step() { printf '\n== %s\n' "$*"; }
[[ $EUID -eq 0 ]] || fail "run with sudo"

API_ROOT=/opt/vitrina/api
APP_ROOT=/opt/vitrina/app
HISTORY=/opt/vitrina/history

# --- what is live, and what was before it ----------------------------------------------

cur_api=$(readlink "$API_ROOT/current") || fail "no $API_ROOT/current: nothing is live"
cur_app=$(readlink "$APP_ROOT/current") || fail "no $APP_ROOT/current: nothing is live"
live=$(basename "$cur_app")
[[ "$cur_api" == "$API_ROOT/releases/$live/packages/server" ]] ||
	fail "the API runs $cur_api and the app $cur_app: not one release. Sort that out by hand"

[[ -s "$HISTORY" ]] || fail "no $HISTORY: no previous release is recorded (the history starts with the first tagged deploy)"
[[ "$(tail -n 1 "$HISTORY")" == "$live" ]] ||
	fail "$HISTORY ends with $(tail -n 1 "$HISTORY"), but $live is live — a link was changed by hand; nothing done"
[[ "$(wc -l <"$HISTORY" | tr -d ' ')" -ge 2 ]] || fail "no previous release: $live is the only one in $HISTORY"
target=$(tail -n 2 "$HISTORY" | head -n 1)
target_api=$API_ROOT/releases/$target/packages/server
target_app=$APP_ROOT/releases/$target
[[ -f "$target_api/dist/index.js" ]] || fail "$target_api/dist/index.js is gone"
[[ -f "$target_app/index.html" ]] || fail "$target_app/index.html is gone"

step "from $live to $target"
# Read from the two releases' files, not the database.
added=$(comm -13 <(ls -1 "$target_api/migrations" | sort) <(ls -1 "$cur_api/migrations" | sort))
if [[ -n "$added" ]]; then
	echo "these stay applied; $target runs on the schema they made:"
	echo "$added" | sed 's/^/  /'
else
	echo "no migration between them"
fi

# --- switch, restart, health --------------------------------------------------------------

link() { ln -sfn "$1" "$2.new" && mv -T "$2.new" "$2"; } # atomic: rename over the old link
healthy() {
	local i
	for i in $(seq 1 30); do
		# GET, never HEAD: the API answers no HEAD (api-sketch §11.8).
		[[ "$(curl -fsS --max-time 2 http://127.0.0.1:3000/health 2>/dev/null)" == '{"status":"ok"}' ]] && return 0
		sleep 1
	done
	return 1
}

link "$target_api" "$API_ROOT/current"
link "$target_app" "$APP_ROOT/current"
systemctl restart vitrina-api
if ! healthy; then
	journalctl -u vitrina-api -n 40 --no-pager -o cat || true
	link "$cur_api" "$API_ROOT/current"
	link "$cur_app" "$APP_ROOT/current"
	systemctl restart vitrina-api
	healthy && echo "switched back to $live, which answers /health" >&2
	fail "$target did not become healthy (log above)"
fi
echo "healthy: GET http://127.0.0.1:3000/health"

echo "$target" >"$HISTORY.new"
chmod 644 "$HISTORY.new"
mv -f "$HISTORY.new" "$HISTORY"
# Left on disk, out of the history: release.sh removes it at the next deploy.
echo "history: $(tr '\n' ' ' <"$HISTORY")"
step "live: $target"

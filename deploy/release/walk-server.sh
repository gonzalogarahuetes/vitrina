#!/usr/bin/env bash
#
# The server half of verify.sh, as root. Two calls around walk.mjs:
#
#   walk-server.sh open  <email>
#       1. by violation: HOST=0.0.0.0 added to api.env, the API restarted —
#          it must still listen on 127.0.0.1 only. Then api.env is restored.
#       2. <email> added to the signup allowlist, for walk.mjs's account.
#   walk-server.sh close <email> <user-agent-marker> <state-file>
#       1. the allowlist restored exactly as it was
#       2. Caddy's access log has walk.mjs's requests and not its bearer token,
#          nor any Authorization field; the API's log has no token either
#       3. walk.mjs's account deleted (albums and media rows cascade), and its
#          objects confirmed absent from the bucket
#
# Every file it changes is backed up first and restored on any exit.

set -uo pipefail
umask 077
here=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=../server/lib.sh
. "$here/lib.sh"
cd /
fails=0
pass() { echo "PASS $*"; }
bad() { echo "FAIL $*"; fails=$((fails + 1)); }
die() { echo "walk-server: $*" >&2; exit 1; }
[[ $EUID -eq 0 ]] || die "run with sudo"

BACKUP=/etc/vitrina/.walk-backup
healthy() {
	local i
	for i in $(seq 1 30); do
		[[ "$(curl -fsS --max-time 2 http://127.0.0.1:3000/health 2>/dev/null)" == '{"status":"ok"}' ]] && return 0
		sleep 1
	done
	return 1
}
restart() { systemctl restart vitrina-api && healthy || die "the API did not come back healthy after a restart"; }

case "${1:-}" in
open)
	email=${2:?open <email>}
	[[ ! -e "$BACKUP" ]] || die "$BACKUP exists: a previous walk did not close. Run close first"
	install -d -m 700 "$BACKUP"
	cp -p "$API_ENV" "$BACKUP/api.env"
	if [[ -f "$SIGNUP_ENV" ]]; then cp -p "$SIGNUP_ENV" "$BACKUP/signup.env"; else touch "$BACKUP/no-signup.env"; fi

	# 1. HOST in api.env cannot move the API off loopback.
	trap 'cp -p "$BACKUP/api.env" "$API_ENV"' EXIT
	echo "HOST=0.0.0.0" >>"$API_ENV"
	restart
	listen=$(ss -Hltn 'sport = :3000' | awk '{print $4}' | sort -u | tr '\n' ' ')
	if [[ "$listen" =~ ^(127\.0\.0\.1:3000\ )+$ ]]; then pass "HOST=0.0.0.0 in api.env, and the API still listens on $listen only (by violation)"
	else bad "with HOST=0.0.0.0 in api.env the API listens on: $listen"; fi
	cp -p "$BACKUP/api.env" "$API_ENV"
	trap - EXIT

	# 2. Invite the walk's address, for the walk only.
	list=$(env_get "$SIGNUP_ENV" SIGNUP_ALLOWLIST)
	tmp=$(mktemp /etc/vitrina/.tmp.XXXXXX)
	printf 'SIGNUP_ALLOWLIST=%s\n' "${list:+$list,}$email" >"$tmp"
	chmod 600 "$tmp" && mv -f "$tmp" "$SIGNUP_ENV"
	restart
	pass "$email invited for the walk; the API is healthy"
	;;

close)
	email=${2:?close <email> <marker> <state-file>} marker=${3:?} state=${4:?}
	[[ -d "$BACKUP" ]] || die "no $BACKUP: nothing was opened"

	# 1. The allowlist exactly as it was.
	if [[ -f "$BACKUP/no-signup.env" ]]; then rm -f "$SIGNUP_ENV"; else cp -p "$BACKUP/signup.env" "$SIGNUP_ENV"; fi
	cmp -s "$BACKUP/api.env" "$API_ENV" || bad "api.env differs from its backup"
	restart
	if [[ -f "$BACKUP/no-signup.env" ]]; then [[ ! -e "$SIGNUP_ENV" ]] && pass "allowlist restored (absent, as before)"
	elif cmp -s "$BACKUP/signup.env" "$SIGNUP_ENV"; then pass "allowlist restored exactly"
	else bad "signup.env differs from its backup"; fi

	# 2. The logs. The walk's token was a real, signed-in bearer token.
	token=$(sed -n 's/.*"token":"\([^"]*\)".*/\1/p' "$state")
	media=$(sed -n 's/.*"media":\[\([^]]*\)\].*/\1/p' "$state" | tr -d '"' | tr ',' ' ')
	caddy=$(journalctl -u caddy --since "-30 min" -o cat --no-pager | grep -F "$marker")
	n=$(printf '%s' "$caddy" | grep -c . || true)
	if [[ "$n" -gt 0 ]]; then pass "Caddy logged the walk's requests ($n lines)"; else bad "no Caddy log line carries the walk's marker — nothing below is proved"; fi
	if [[ -n "$token" ]] && printf '%s' "$caddy" | grep -qF "$token"; then bad "Caddy's log holds the bearer token"
	else pass "Caddy's log does not hold the bearer token"; fi
	if printf '%s' "$caddy" | grep -qi '"authorization"'; then bad "Caddy's log has an Authorization field"
	else pass "Caddy's log has no Authorization field at all"; fi
	if [[ -n "$token" ]] && journalctl -u vitrina-api --since "-30 min" -o cat --no-pager | grep -qF "$token"; then bad "the API's log holds the bearer token"
	else pass "the API's log does not hold the bearer token"; fi

	# 3. The account and what it stored.
	deleted=$(sudo -u postgres psql -d vitrina -qtA -v e="$email" -c "DELETE FROM owners WHERE email = :'e' RETURNING id" | grep -c . || true)
	if [[ "$deleted" -eq 1 ]]; then pass "the walk's account deleted (its albums and media cascade)"
	else bad "deleted $deleted accounts for $email, expected 1"; fi
	endpoint=$(env_get "$API_ENV" S3_ENDPOINT) region=$(env_get "$API_ENV" AWS_DEFAULT_REGION)
	bucket=$(env_get "$API_ENV" S3_BUCKET) key_id=$(env_get "$API_ENV" AWS_ACCESS_KEY_ID)
	key_secret=$(env_get "$API_ENV" AWS_SECRET_ACCESS_KEY)
	left=0
	for id in $media; do
		for variant in asset thumbnail; do
			# s3_head_status signs a HEAD on "$endpoint/<path>": here the object's path.
			status=$(s3_head_status "$endpoint" "$region" "$bucket/media/$id/$variant" "$key_id" "$key_secret")
			[[ "$status" == 404 ]] || { bad "media/$id/$variant still answers $status"; left=$((left + 1)); }
		done
	done
	[[ -z "$media" ]] && bad "the state file lists no media — nothing about erasure is proved"
	[[ -n "$media" && $left -eq 0 ]] && pass "every object the walk stored is gone from $bucket"

	rm -rf "$BACKUP" "$state"
	;;

*) die "usage: walk-server.sh open <email> | close <email> <marker> <state-file>" ;;
esac

[[ $fails -eq 0 ]] || { echo "walk-server: $fails FAIL"; exit 1; }

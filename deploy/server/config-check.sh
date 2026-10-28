#!/usr/bin/env bash
#
# Phase 4's checks inside the server, as root. check-config.sh copies this up
# and runs it. Read-only. Ends with FINGERPRINT lines: the sha256 of each
# secret, which check-config.sh looks for in the repository on the Mac — the
# values themselves never leave the server.
#
#   config-check.sh <admin-user>

set -uo pipefail
ADMIN_USER=${1:?usage: config-check.sh <admin-user>}
here=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=lib.sh
. "$here/lib.sh"
cd /
fails=0
pass() { echo "PASS $*"; }
bad() { echo "FAIL $*"; fails=$((fails + 1)); }
check() { local what=$1; shift; if "$@" >/dev/null 2>&1; then pass "$what"; else bad "$what"; fi; }

# --- the files ----------------------------------------------------------------
check "/etc/vitrina is root-only (700)" test "$(stat -c '%U %a' /etc/vitrina)" = "root 700"
check "api.env exists, root-only (600)" test "$(stat -c '%U %G %a' "$API_ENV" 2>/dev/null)" = "root root 600"

keys=$(grep -vE '^\s*(#|$)' "$API_ENV" | cut -d= -f1 | LC_ALL=C sort | tr '\n' ' ')
want=$(printf '%s\n' $API_KEYS | LC_ALL=C sort | tr '\n' ' ')
if [[ "$keys" == "$want" ]]; then pass "api.env holds exactly the API's variables, each once (no HOST, no PORT)"
else bad "api.env keys: $keys— expected: $want"; fi

check "CLIENT_ORIGIN is $CLIENT_ORIGIN_PROD" test "$(env_get "$API_ENV" CLIENT_ORIGIN)" = "$CLIENT_ORIGIN_PROD"
check "DATABASE_URL is the peer-authenticated socket" test "$(env_get "$API_ENV" DATABASE_URL)" = "$DATABASE_URL_PROD"
secret=$(env_get "$API_ENV" VITRINA_SERVER_SECRET)
if secret_ok "$secret"; then pass "VITRINA_SERVER_SECRET is base64url of at least 32 bytes"
else bad "VITRINA_SERVER_SECRET is missing or malformed"; fi
if [[ "$(env_get "$API_ENV" S3_ENDPOINT)" =~ ^https://[A-Za-z0-9.-]+$ ]]; then pass "S3_ENDPOINT is an https origin"
else bad "S3_ENDPOINT is not an https origin"; fi

if [[ -f "$SIGNUP_ENV" ]]; then
	check "signup.env is root-only (600)" test "$(stat -c '%U %G %a' "$SIGNUP_ENV")" = "root root 600"
	list=$(env_get "$SIGNUP_ENV" SIGNUP_ALLOWLIST)
	# Every comma-separated field, empty ones included — a trailing comma is an
	# empty entry, which config.ts refuses at boot. (An earlier version counted
	# lines with `wc -l`, read a one-address list as zero, and failed it.)
	if [[ -n "$list" ]] && n=$(allowlist_ok "$list"); then pass "SIGNUP_ALLOWLIST holds $n address(es)"
	else bad "SIGNUP_ALLOWLIST is empty or has an entry that is not an address"; fi
	check "signup.env holds nothing but SIGNUP_ALLOWLIST" test "$(grep -vE '^\s*(#|$)' "$SIGNUP_ENV" | cut -d= -f1 | sort -u)" = SIGNUP_ALLOWLIST
else
	echo "NOTE no signup.env: signup is closed (configure.sh --allow opens it)"
fi

# --- by violation: who can read the secret ------------------------------------------
check "the service user cannot read api.env (systemd reads it, then hands values over)" bash -c "! sudo -u vitrina cat '$API_ENV'"
check "$ADMIN_USER cannot read api.env without sudo" bash -c "! sudo -u '$ADMIN_USER' cat '$API_ENV'"

# --- the database, as the service will reach it ----------------------------------------
check "vitrina reaches its database over the socket, by peer, no password" \
	test "$(sudo -u vitrina psql "$DATABASE_URL_PROD" -qtAc 'SELECT current_user' 2>/dev/null)" = vitrina
# By violation: the same URL from any other OS user is refused — there is no
# password that would let it in.
check "the same URL from another OS user is refused (peer, by violation)" \
	bash -c "! sudo -u '$ADMIN_USER' psql '$DATABASE_URL_PROD' -qtAc 'SELECT 1'"

# --- storage, as the service will reach it --------------------------------------------
endpoint=$(env_get "$API_ENV" S3_ENDPOINT) region=$(env_get "$API_ENV" AWS_DEFAULT_REGION)
bucket=$(env_get "$API_ENV" S3_BUCKET) key_id=$(env_get "$API_ENV" AWS_ACCESS_KEY_ID)
key_secret=$(env_get "$API_ENV" AWS_SECRET_ACCESS_KEY)
status=$(s3_head_status "$endpoint" "$region" "$bucket" "$key_id" "$key_secret")
if [[ "$status" == 200 ]]; then pass "the configured credentials open $bucket (signed HEAD 200)"; else bad "signed HEAD on $bucket: $status"; fi
# By violation: so a 200 above is the credentials at work, not a public bucket.
status=$(s3_head_status "$endpoint" "$region" "$bucket" "$key_id" "${key_secret}x")
if [[ "$status" == 403 ]]; then pass "a wrong secret is refused (403, by violation)"; else bad "a wrong secret got $status, expected 403"; fi

# --- the unit ----------------------------------------------------------------------------
check "unit reads api.env and signup.env" bash -c "systemctl show -p EnvironmentFiles --value vitrina-api | grep -q '$API_ENV' && systemctl show -p EnvironmentFiles --value vitrina-api | grep -q '$SIGNUP_ENV'"
check "unit pins HOST=127.0.0.1 in ExecStart, where api.env cannot override it" \
	bash -c "systemctl show -p ExecStart --value vitrina-api | grep -q 'HOST=127.0.0.1 PORT=3000 /usr/local/bin/node'"

# --- fingerprints, for the repository scan on the Mac ---------------------------------------
echo "FINGERPRINT VITRINA_SERVER_SECRET ${#secret} $(fingerprint "$secret")"
echo "FINGERPRINT AWS_SECRET_ACCESS_KEY ${#key_secret} $(fingerprint "$key_secret")"
unset secret key_secret

echo
if [[ $fails -eq 0 ]]; then echo "remote: all PASS"; else echo "remote: $fails FAIL"; exit 1; fi

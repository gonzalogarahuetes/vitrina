#!/usr/bin/env bash
#
# Phase 4: the API's configuration, on the server. Idempotent, interactive.
#
#   scp -r deploy/server <admin>@<ip>:vitrina-server
#   ssh -t <admin>@<ip> sudo bash vitrina-server/configure.sh --allow you@example.com
#
# Writes, root-only (0600 in a 0700 directory; systemd reads them and hands the
# values to the service, which itself cannot read either file):
#   /etc/vitrina/api.env      the secret, the storage credentials, the origin, the database
#   /etc/vitrina/signup.env   SIGNUP_ALLOWLIST, only when --allow is given
#
# Options:
#   --allow "a@x.es,b@y.es"   (re)write the signup allowlist
#   --storage                 re-enter the storage values on a configured server
#   --restore-secret          api.env lost: enter the secret from the password manager
#
# The server secret is generated once and never again. Rotating it moves every
# decoy salt and locks every owner out (.env.example); so an existing one is
# kept, and a missing one is never regenerated while accounts exist.

set -euo pipefail
umask 077
here=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=lib.sh
. "$here/lib.sh"
cd /

fail() { echo "configure: $*" >&2; exit 1; }
say() { echo "  $*"; }

allow="" storage=false restore=false
while [[ $# -gt 0 ]]; do
	case "$1" in
	--allow) allow=${2:?--allow needs addresses}; shift 2 ;;
	--storage) storage=true; shift ;;
	--restore-secret) restore=true; shift ;;
	*) fail "unknown option: $1" ;;
	esac
done

[[ $EUID -eq 0 ]] || fail "run with sudo"
[[ -t 0 ]] || fail "needs a terminal: ssh -t"
[[ -d /etc/vitrina ]] || fail "/etc/vitrina is missing — run provision.sh first"
[[ "$(stat -c '%U %a' /etc/vitrina)" == "root 700" ]] || fail "/etc/vitrina must be root-only (700)"

# The app's hostname, as provision.sh recorded it: production, or a rehearsal's.
app_host=$(site_app_host)
[[ "$app_host" =~ $HOSTNAME_RE ]] || fail "no APP_HOST in $SITE_ENV — run provision.sh first"
say "this server answers for https://$app_host"

configured=false
[[ -f "$API_ENV" ]] && configured=true

# --- storage -------------------------------------------------------------------

endpoint=$(env_get "$API_ENV" S3_ENDPOINT)
region=$(env_get "$API_ENV" AWS_DEFAULT_REGION)
bucket=$(env_get "$API_ENV" S3_BUCKET)
key_id=$(env_get "$API_ENV" AWS_ACCESS_KEY_ID)
key_secret=$(env_get "$API_ENV" AWS_SECRET_ACCESS_KEY)

ask() { # <prompt> <current> → stdout
	local v
	read -r -p "  $1${2:+ [$2]}: " v
	echo "${v:-$2}"
}

if ! $configured || $storage; then
	echo "== object storage (the values phase 1 tested; ~/.vitrina/storage.env on your Mac)"
	endpoint=$(ask "S3_ENDPOINT, e.g. https://nbg1.your-objectstorage.com" "$endpoint")
	region=$(ask "AWS_DEFAULT_REGION, e.g. nbg1" "$region")
	bucket=$(ask "S3_BUCKET" "$bucket")
	key_id=$(ask "AWS_ACCESS_KEY_ID" "$key_id")
	read -r -s -p "  AWS_SECRET_ACCESS_KEY${key_secret:+ [Enter keeps the current one]}: " v
	echo
	key_secret=${v:-$key_secret}
	unset v
fi
[[ "$endpoint" =~ ^https://[A-Za-z0-9.-]+$ ]] || fail "S3_ENDPOINT must be https://host, with no path"
[[ -n "$region" && -n "$bucket" && -n "$key_id" && -n "$key_secret" ]] || fail "every storage value is required"

status=$(s3_head_status "$endpoint" "$region" "$bucket" "$key_id" "$key_secret")
[[ "$status" == 200 ]] || fail "a signed HEAD on $bucket answered $status, not 200 — check the values; nothing written"
say "storage: the credentials open $bucket (HEAD 200)"

# --- the server secret -------------------------------------------------------------

secret=$(env_get "$API_ENV" VITRINA_SERVER_SECRET)
# How many accounts a new secret would lock out. Before phase 5's migrations
# the table does not exist: zero. Any other failure stops here — "could not
# ask" must never read as "nobody to lock out".
owners_table=$(sudo -u postgres psql -d vitrina -qtAc "SELECT to_regclass('public.owners') IS NOT NULL") ||
	fail "cannot query PostgreSQL to count accounts; nothing written"
owners=0
if [[ "$owners_table" == t ]]; then
	owners=$(sudo -u postgres psql -d vitrina -qtAc "SELECT count(*) FROM owners") || fail "cannot count accounts; nothing written"
fi

if [[ -n "$secret" ]]; then
	$restore && fail "a secret is already configured; --restore-secret is for a server that lost it"
	say "server secret: kept (generated once, never rotated)"
elif $restore; then
	read -r -s -p "  Paste the server secret from the password manager: " secret
	echo
	secret_ok "$secret" || fail "that is not base64url of at least 32 bytes"
	say "server secret: restored from its backup"
else
	[[ "$owners" == 0 ]] ||
		fail "$owners accounts exist and no secret is configured. A new one would lock them all out: use --restore-secret"
	secret=$(head -c 32 /dev/urandom | basenc --base64url | tr -d '=')
	secret_ok "$secret" || fail "generated secret failed validation"
	cat <<-EOF

		  The server secret. Store it NOW in your password manager, as its own entry
		  ("Vitrina server secret") — never beside a database backup:

		      $secret

		  Its only other copy will be this server's /etc/vitrina/api.env.
	EOF
	tries=0
	while :; do
		read -r -s -p "  Paste it back from the password manager, to prove the copy is right: " back
		echo
		[[ "$back" == "$secret" ]] && break
		tries=$((tries + 1))
		[[ $tries -lt 3 ]] || fail "three mismatches; nothing written. Run again for a new secret"
		say "that does not match; copy it again from the line above"
	done
	unset back
	say "server secret: generated and backed up. Clear this terminal's scrollback now (Cmd+K)"
fi

# --- write, atomically, root-only --------------------------------------------------

write_env() { # <dest> then lines on stdin
	local tmp
	tmp=$(mktemp /etc/vitrina/.tmp.XXXXXX)
	cat >"$tmp"
	chown root:root "$tmp"
	chmod 600 "$tmp"
	mv -f "$tmp" "$1"
}

write_env "$API_ENV" <<-EOF
	# Written by deploy/server/configure.sh. No HOST or PORT here: the unit sets
	# them in ExecStart, where nothing in this file can override them.
	CLIENT_ORIGIN=https://$app_host
	DATABASE_URL=$DATABASE_URL_PROD
	VITRINA_SERVER_SECRET=$secret
	S3_ENDPOINT=$endpoint
	S3_BUCKET=$bucket
	AWS_DEFAULT_REGION=$region
	AWS_ACCESS_KEY_ID=$key_id
	AWS_SECRET_ACCESS_KEY=$key_secret
EOF
unset secret key_secret
say "wrote $API_ENV"

if [[ -n "$allow" ]]; then
	list=$(printf '%s' "$allow" | tr -d '[:space:]')
	# The same rule config-check.sh applies and config.ts enforces at boot:
	# every field an address, so a stray comma cannot stop the API later.
	count=$(allowlist_ok "$list") || fail "--allow: every comma-separated entry must be an address (no empty ones)"
	write_env "$SIGNUP_ENV" <<-EOF
		# Who may create an account. Edit with \`sudoedit $SIGNUP_ENV\`, then
		# \`sudo systemctl restart vitrina-api\`. Empty or absent: nobody.
		SIGNUP_ALLOWLIST=$list
	EOF
	say "wrote $SIGNUP_ENV ($count address(es))"
elif [[ ! -f "$SIGNUP_ENV" ]]; then
	say "no $SIGNUP_ENV: signup is closed. Re-run with --allow to open it to you"
fi

# Restart only a service already running; before phase 5 there is nothing to run.
systemctl try-restart vitrina-api.service
echo
echo "done — from the Mac: deploy/server/check-config.sh <ip> $(logname 2>/dev/null || echo "${SUDO_USER:-<admin>}")"

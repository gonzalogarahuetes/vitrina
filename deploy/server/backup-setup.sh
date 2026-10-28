#!/usr/bin/env bash
#
# Phase 6, on the server: nightly encrypted database backups. Idempotent,
# interactive.
#
#   ssh -i … <admin>@<ip> rm -rf vitrina-server
#   scp -i … -r deploy/server <admin>@<ip>:vitrina-server
#   ssh -t -i … <admin>@<ip> sudo bash vitrina-server/backup-setup.sh
#
# Sets up:
#   - the user vitrina-backup, and a database role of the same name that can
#     read every table and change none (pg_read_all_data), over peer auth;
#   - /etc/vitrina/backup.env, root-only: the backup bucket, its credentials,
#     the age PUBLIC key, retention. Never the server secret: backup.sh refuses
#     to run if that is in its environment;
#   - vitrina-backup.service and .timer: nightly at 03:15 UTC.
#
# backup.sh itself ships with each release (ops/), so a release deployed
# after this script's commit must exist before the first backup can run.

set -euo pipefail
umask 077
here=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=lib.sh
. "$here/lib.sh"
cd /

BACKUP_ENV=/etc/vitrina/backup.env
fail() { echo "backup-setup: $*" >&2; exit 1; }
say() { echo "  $*"; }
ask() { local v; read -r -p "  $1${2:+ [$2]}: " v; echo "${v:-$2}"; }

[[ $EUID -eq 0 ]] || fail "run with sudo"
[[ -t 0 ]] || fail "needs a terminal: ssh -t"
[[ -f "$API_ENV" ]] || fail "no $API_ENV — phase 4 first"
media_bucket=$(env_get "$API_ENV" S3_BUCKET)

echo "== packages"
apt-get install -yq age >/dev/null
age --version

echo "== the backup user and its database role"
id -u vitrina-backup >/dev/null 2>&1 ||
	useradd --system --user-group --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin vitrina-backup
sudo -u postgres psql -qtAc "SELECT 1 FROM pg_roles WHERE rolname = 'vitrina-backup'" | grep -q 1 ||
	sudo -u postgres createuser --no-superuser --no-createdb --no-createrole vitrina-backup
# Reads every table, writes none: a stolen backup job cannot change the data it copies.
sudo -u postgres psql -q -d vitrina -c 'GRANT pg_read_all_data TO "vitrina-backup"'
say "vitrina-backup can read, and only read, the database"

echo "== the backup bucket"
endpoint=$(ask "BACKUP_S3_ENDPOINT, e.g. https://fsn1.your-objectstorage.com" "$(env_get "$BACKUP_ENV" BACKUP_S3_ENDPOINT)")
region=$(ask "BACKUP_S3_REGION, e.g. fsn1" "$(env_get "$BACKUP_ENV" BACKUP_S3_REGION)")
bucket=$(ask "BACKUP_BUCKET" "$(env_get "$BACKUP_ENV" BACKUP_BUCKET)")
key_id=$(ask "BACKUP_AWS_ACCESS_KEY_ID" "$(env_get "$BACKUP_ENV" BACKUP_AWS_ACCESS_KEY_ID)")
current_secret=$(env_get "$BACKUP_ENV" BACKUP_AWS_SECRET_ACCESS_KEY)
read -r -s -p "  BACKUP_AWS_SECRET_ACCESS_KEY${current_secret:+ [Enter keeps the current one]}: " v
echo
key_secret=${v:-$current_secret}
unset v current_secret
[[ "$endpoint" =~ ^https://[A-Za-z0-9.-]+$ ]] || fail "the endpoint must be https://host, with no path"
[[ -n "$region" && -n "$bucket" && -n "$key_id" && -n "$key_secret" ]] || fail "every bucket value is required"
[[ "$bucket" != "$media_bucket" ]] || fail "that is the media bucket; backups go to a separate one"

status=$(s3_head_status "$endpoint" "$region" "$bucket" "$key_id" "$key_secret")
[[ "$status" == 200 ]] || fail "a signed HEAD on $bucket answered $status, not 200; nothing written"
say "the backup credentials open $bucket"

# Can the API's own credentials reach the backups? If they can, a compromised
# API could delete them. Not fatal: a separate Hetzner project's keys prevent it.
api_status=$(s3_head_status "$endpoint" "$region" "$bucket" \
	"$(env_get "$API_ENV" AWS_ACCESS_KEY_ID)" "$(env_get "$API_ENV" AWS_SECRET_ACCESS_KEY)")
if [[ "$api_status" == 200 ]]; then
	say "NOTE the API's credentials can also open $bucket (same Hetzner project)"
else
	say "the API's credentials cannot open $bucket ($api_status): backups are out of the API's reach"
fi

echo "== encryption and retention"
recipient=$(ask "AGE_RECIPIENT (the age1… PUBLIC key; the private key stays offline)" "$(env_get "$BACKUP_ENV" AGE_RECIPIENT)")
[[ "$recipient" != AGE-SECRET-KEY-* ]] || fail "that is the PRIVATE key. It never comes to this server"
[[ "$recipient" =~ ^age1[02-9ac-hj-np-z]{58}$ ]] || fail "not an age recipient (age1…)"
retention=$(ask "RETENTION_DAYS — how long a removed photo's row survives in backups" "$(env_get "$BACKUP_ENV" RETENTION_DAYS)")
[[ "$retention" =~ ^[1-9][0-9]*$ ]] || fail "RETENTION_DAYS must be a positive integer"
keep=$(ask "KEEP_MIN — newest backups kept whatever their age" "$(env_get "$BACKUP_ENV" KEEP_MIN || true)")
keep=${keep:-7}
[[ "$keep" =~ ^[1-9][0-9]*$ ]] || fail "KEEP_MIN must be a positive integer"

echo "== the heartbeat (phase 7)"
current_hb=$(env_get "$BACKUP_ENV" BACKUP_HEARTBEAT_URL)
read -r -s -p "  BACKUP_HEARTBEAT_URL, the monitor's ping URL${current_hb:+ [Enter keeps the current one]}: " v
echo
heartbeat=${v:-$current_hb}
unset v current_hb
[[ -z "$heartbeat" || "$heartbeat" == https://?* ]] || fail "the heartbeat URL must be https"
[[ -n "$heartbeat" ]] || say "NOTE no heartbeat: nothing will tell you if a nightly backup stops"

tmp=$(mktemp /etc/vitrina/.tmp.XXXXXX)
cat >"$tmp" <<-EOF
	# Written by deploy/server/backup-setup.sh. Read by systemd for
	# vitrina-backup.service only. Holds no server secret, by design.
	DATABASE_URL=postgresql:///vitrina?host=/var/run/postgresql&user=vitrina-backup
	AGE_RECIPIENT=$recipient
	MEDIA_BUCKET=$media_bucket
	BACKUP_BUCKET=$bucket
	BACKUP_S3_ENDPOINT=$endpoint
	BACKUP_S3_REGION=$region
	BACKUP_AWS_ACCESS_KEY_ID=$key_id
	BACKUP_AWS_SECRET_ACCESS_KEY=$key_secret
	BACKUP_PREFIX=pg/
	RETENTION_DAYS=$retention
	KEEP_MIN=$keep
	BACKUP_HEARTBEAT_URL=$heartbeat
EOF
unset key_secret heartbeat
chown root:root "$tmp" && chmod 600 "$tmp" && mv -f "$tmp" "$BACKUP_ENV"
say "wrote $BACKUP_ENV"

echo "== the timer"
install -m 644 "$here/files/vitrina-backup.service" /etc/systemd/system/vitrina-backup.service
install -m 644 "$here/files/vitrina-backup.timer" /etc/systemd/system/vitrina-backup.timer
systemctl daemon-reload
systemctl enable --now vitrina-backup.timer >/dev/null
systemctl list-timers vitrina-backup.timer --no-pager | head -2

echo
if [[ -x /opt/vitrina/api/current/ops/backup.sh ]]; then
	echo "done — first backup now, from the Mac: deploy/backup/restore-test.sh <ip> <admin>"
else
	echo "done — but the running release has no ops/backup.sh yet: deploy once (deploy/release/deploy.sh), then restore-test.sh"
fi

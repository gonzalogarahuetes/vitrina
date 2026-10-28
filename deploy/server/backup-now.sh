#!/usr/bin/env bash
#
# Phase 6, on the server, as root — restore-test.sh uploads and runs it:
#   checks the backup setup, some by violation; runs one backup now, exactly as
#   the timer would; records the live row counts at that moment; and leaves
#   the newest backup — ciphertext — in /tmp for the Mac to fetch.
#
#   backup-now.sh <admin-user>
#
# Prints COUNTS, KEY and RESULT lines for restore-test.sh to read.

set -uo pipefail
ADMIN_USER=${1:?usage: backup-now.sh <admin-user>}
here=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=lib.sh
. "$here/lib.sh"
cd /
BACKUP_ENV=/etc/vitrina/backup.env
OPS=/opt/vitrina/api/current/ops
OUT=/tmp/vitrina-backup-latest.age
fails=0
pass() { echo "PASS $*"; }
bad() { echo "FAIL $*"; fails=$((fails + 1)); }
check() { local what=$1; shift; if "$@" >/dev/null 2>&1; then pass "$what"; else bad "$what"; fi; }
[[ $EUID -eq 0 ]] || { echo "run with sudo" >&2; exit 1; }

# --- the setup ------------------------------------------------------------------
check "backup.env is root-only (600)" test "$(stat -c '%U %G %a' "$BACKUP_ENV" 2>/dev/null)" = "root root 600"
check "backup.env holds no server secret" bash -c "! grep -q '^VITRINA_SERVER_SECRET=' '$BACKUP_ENV'"
check "backup.env holds an age PUBLIC key, not a private one" bash -c "grep -Eq '^AGE_RECIPIENT=age1' '$BACKUP_ENV' && ! grep -q 'AGE-SECRET-KEY' '$BACKUP_ENV'"
check "the backup bucket is not the media bucket" \
	test "$(env_get "$BACKUP_ENV" BACKUP_BUCKET)" != "$(env_get "$API_ENV" S3_BUCKET)"
check "vitrina-backup cannot read api.env (by violation)" bash -c "! sudo -u vitrina-backup cat '$API_ENV'"
check "vitrina-backup cannot read backup.env either (systemd hands the values over)" bash -c "! sudo -u vitrina-backup cat '$BACKUP_ENV'"
check "vitrina-backup can read the database and cannot write it (by violation)" bash -c "
	sudo -u vitrina-backup psql 'postgresql:///vitrina?host=/var/run/postgresql&user=vitrina-backup' -qtAc 'SELECT count(*) FROM schema_migrations' &&
	! sudo -u vitrina-backup psql 'postgresql:///vitrina?host=/var/run/postgresql&user=vitrina-backup' -qtAc 'DELETE FROM schema_migrations WHERE false'"
check "the release carries ops/backup.sh" test -x "$OPS/backup.sh"
# backup.sh's own guard, on the server: the server secret in its environment stops it.
check "backup.sh refuses an environment holding the server secret (by violation)" bash -c "
	out=\$(sudo -u vitrina-backup env -i PATH=/usr/local/bin:/usr/bin:/bin VITRINA_SERVER_SECRET=x \
		DATABASE_URL=x AGE_RECIPIENT=x MEDIA_BUCKET=a BACKUP_BUCKET=b BACKUP_S3_ENDPOINT=x BACKUP_S3_REGION=x \
		BACKUP_AWS_ACCESS_KEY_ID=x BACKUP_AWS_SECRET_ACCESS_KEY=x RETENTION_DAYS=30 '$OPS/backup.sh' 2>&1)
	[[ \$? -ne 0 && \"\$out\" == *'must not hold it'* ]]"
check "the timer is enabled and scheduled" bash -c "systemctl is-enabled vitrina-backup.timer && systemctl list-timers vitrina-backup.timer --no-legend | grep -q vitrina-backup"

# --- one backup, as the timer runs it --------------------------------------------
started=$(date +%s)
if systemctl start vitrina-backup.service; then pass "a backup ran as vitrina-backup.service"
else bad "vitrina-backup.service failed — journalctl -u vitrina-backup"; fi
result=$(journalctl -u vitrina-backup --since "@$started" -o cat --no-pager | grep '^backup ok' | tail -1)
echo "RESULT $result"

# The live row counts, straight after: restore-test.sh compares the restore to these.
echo "COUNTS $(sudo -u postgres psql -d vitrina -qtAc "
	SELECT json_object_agg(table_name, (xpath('/row/c/text()',
		query_to_xml(format('SELECT count(*) AS c FROM %I.%I', table_schema, table_name), false, true, '')))[1]::text::int)
	FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'")"

# --- the newest backup, ciphertext only, for the Mac ------------------------------
key=$(sed -n 's/.*key=\([^ ]*\).*/\1/p' <<<"$result")
if [[ -n "$key" ]]; then
	# s3.mjs reads its BACKUP_* variables from the environment; DATABASE_URL is
	# not passed (its '&' is why this file is not sourced).
	env -i PATH=/usr/local/bin:/usr/bin:/bin \
		BACKUP_S3_ENDPOINT="$(env_get "$BACKUP_ENV" BACKUP_S3_ENDPOINT)" \
		BACKUP_S3_REGION="$(env_get "$BACKUP_ENV" BACKUP_S3_REGION)" \
		BACKUP_BUCKET="$(env_get "$BACKUP_ENV" BACKUP_BUCKET)" \
		BACKUP_AWS_ACCESS_KEY_ID="$(env_get "$BACKUP_ENV" BACKUP_AWS_ACCESS_KEY_ID)" \
		BACKUP_AWS_SECRET_ACCESS_KEY="$(env_get "$BACKUP_ENV" BACKUP_AWS_SECRET_ACCESS_KEY)" \
		node "$OPS/s3.mjs" get "$key" "$OUT" &&
		chown "$ADMIN_USER" "$OUT" && pass "fetched $key from the backup bucket" || bad "could not fetch $key"
	[[ "$(head -c 21 "$OUT" 2>/dev/null)" == "age-encryption.org/v1" ]] && pass "it is age ciphertext" || bad "it is not age ciphertext"
	echo "KEY $key"
else
	bad "no 'backup ok' line from this run"
fi

echo
if [[ $fails -eq 0 ]]; then echo "server: all PASS"; else echo "server: $fails FAIL"; exit 1; fi

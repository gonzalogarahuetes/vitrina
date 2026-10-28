#!/usr/bin/env bash
#
# Disaster recovery, the server half, as root — recover.sh streams a decrypted
# backup into <admin>'s home and then runs this. Restores it into the empty
# `vitrina` database, as the `vitrina` role, so the API owns its tables exactly
# as migrations would have made them; then deletes the plaintext.
#
#   recover-server.sh <admin-user>
#
# Refuses a database that already has tables: recovery is onto a new server,
# before its first release runs any migration.

set -uo pipefail
ADMIN_USER=${1:?usage: recover-server.sh <admin-user>}
here=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=lib.sh
. "$here/lib.sh"
cd /
fail() { echo "recover-server: $*" >&2; exit 1; }
[[ $EUID -eq 0 ]] || fail "run with sudo"

home=$(getent passwd "$ADMIN_USER" | cut -d: -f6)
dump="$home/recover.dump"
# The plaintext goes whatever happens below.
trap 'shred -u "$dump" 2>/dev/null || rm -f "$dump"' EXIT
[[ -s "$dump" ]] || fail "no $dump — recover.sh streams it there first"
[[ "$(stat -c '%U %a' "$dump")" == "$ADMIN_USER 600" ]] || fail "$dump must be $ADMIN_USER's, mode 600"

tables=$(sudo -u postgres psql -d vitrina -qtAc "SELECT count(*) FROM pg_tables WHERE schemaname = 'public'") ||
	fail "cannot reach the vitrina database — provision.sh first"
[[ "$tables" == 0 ]] || fail "the vitrina database already has $tables tables; recovery restores only into an empty one"
if systemctl is-active --quiet vitrina-api; then fail "the API is running; recovery comes before the first release"; fi

start=$(date +%s%3N)
# As the API's own role, so every restored object is owned by it; the dump's
# owners and grants are not replayed (they name roles of the old server).
sudo -u vitrina pg_restore --exit-on-error --no-owner --no-acl --dbname "$DATABASE_URL_PROD" <"$dump" ||
	fail "pg_restore failed (above); the database may be partly restored — drop and recreate it before retrying"
end=$(date +%s%3N)

echo "restored in $((end - start)) ms"
echo "row counts:"
sudo -u postgres psql -d vitrina -qtAc "
	SELECT table_name || ' ' || (xpath('/row/c/text()',
		query_to_xml(format('SELECT count(*) AS c FROM %I.%I', table_schema, table_name), false, true, '')))[1]::text
	FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY 1" |
	sed 's/^/  /'
owner=$(sudo -u postgres psql -d vitrina -qtAc "SELECT DISTINCT tableowner FROM pg_tables WHERE schemaname = 'public'")
[[ "$owner" == vitrina ]] || fail "restored tables are owned by '$owner', not vitrina"
echo "every table is owned by vitrina; the plaintext is deleted"

# Sourced by configure.sh and config-check.sh, on the server.

API_ENV=/etc/vitrina/api.env
SIGNUP_ENV=/etc/vitrina/signup.env
# The two hostnames this server answers for, written once by provision.sh.
SITE_ENV=/etc/vitrina/site.env
HOSTNAME_RE='^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$'
site_app_host() { sed -n 's/^APP_HOST=//p' "$SITE_ENV" 2>/dev/null; }
site_api_host() { sed -n 's/^API_HOST=//p' "$SITE_ENV" 2>/dev/null; }
# Peer authentication over PostgreSQL's socket: no password exists to leak.
# Parsed identically by node-postgres (host, user, database) and by psql.
DATABASE_URL_PROD='postgresql:///vitrina?host=/var/run/postgresql&user=vitrina'
API_KEYS="CLIENT_ORIGIN DATABASE_URL VITRINA_SERVER_SECRET S3_ENDPOINT S3_BUCKET AWS_DEFAULT_REGION AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY"

# The value of KEY in an env file, or nothing. Values are written unquoted.
env_get() { # <file> <key>
	[[ -r "$1" ]] || return 0
	sed -n "s/^$2=//p" "$1" | tail -n 1
}

# The HTTP status of a SigV4-signed HEAD on the bucket — the same question the
# API's boot check asks. Credentials go to curl through a file descriptor,
# never its command line, so no process listing ever shows them.
s3_head_status() { # <endpoint> <region> <bucket> <key-id> <secret>
	curl -sS -o /dev/null -w '%{http_code}' --max-time 15 -I \
		--aws-sigv4 "aws:amz:$2:s3" \
		-H 'x-amz-content-sha256: e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855' \
		-K <(printf 'user = "%s:%s"\n' "$4" "$5") \
		"$1/$3" || echo "000"
}

# SIGNUP_ALLOWLIST as config.ts will read it: every comma-separated field,
# empty ones included, must be an address. Prints the count when it is.
allowlist_ok() { # <list>
	printf '%s\n' "$1" | awk -F, '{ for (i = 1; i <= NF; i++) if ($i !~ /^[^@[:space:]]+@[^@[:space:]]+$/) bad = 1 }
		END { if (bad || NF == 0) exit 1; print NF }'
}

# base64url, at least 32 bytes decoded — config.ts's rule, so a value this
# accepts is a value the API accepts.
secret_ok() { # <value>
	# Node's decoder, as config.ts's: basenc wants padding the secret does not have.
	# Through stdin, so the value is never an argument.
	[[ "$1" =~ ^[A-Za-z0-9_-]+$ ]] && printf '%s' "$1" | /usr/local/bin/node -e '
		let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () =>
			process.exit(Buffer.from(s, "base64url").length >= 32 ? 0 : 1));'
}

# sha256 of a value, for check-config.sh's repository scan on the Mac: the
# value never leaves the server, its fingerprint does. Through stdin.
fingerprint() { # <value>
	printf '%s' "$1" | sha256sum | cut -d' ' -f1
}

#!/usr/bin/env bash
#
# Recreate the offline age key file from the password manager, for recover.sh
# and restore-test.sh. Never `age-keygen -o` for this: that makes a NEW key,
# which decrypts no existing backup.
#
#   copy the password-manager entry "Vitrina backup key (age)", then at once:
#   deploy/backup/agekey.sh
#
# Reads the clipboard (pbpaste), or stdin when it is not a terminal. Keeps only
# the one AGE-SECRET-KEY-1… line — a paste often gains a title, a label or
# spaces — and writes it, mode 600, to AGE_IDENTITY_FILE (default
# ~/vitrina-backup.agekey). Refuses an existing file, a paste with no key or
# two, and a key whose public key differs from a "# public key:" line pasted
# with it. Prints the public key and never the secret; clears the clipboard
# after reading it. Delete the file when the task is done.

set -euo pipefail
out=${AGE_IDENTITY_FILE:-$HOME/vitrina-backup.agekey}
die() { echo "agekey: $*" >&2; exit 1; }

command -v age-keygen >/dev/null || die "brew install age"
[[ ! -e "$out" ]] || die "$out exists; rm it first if it is a bad paste"

if [[ -t 0 ]]; then
	command -v pbpaste >/dev/null || die "no pbpaste: pipe the key text in instead"
	text=$(pbpaste)
	pbcopy </dev/null
else
	text=$(cat)
fi

secrets=$(grep -oE 'AGE-SECRET-KEY-1[0-9A-Z]{58}' <<<"$text" | sort -u || true)
count=$(grep -c . <<<"$secrets" || true)
[[ $count -eq 1 ]] || die "found $count AGE-SECRET-KEY-1… keys in the paste, not one; copy the entry again"
claimed=$(grep -oE '# public key: age1[0-9a-z]+' <<<"$text" | head -n1 | sed 's/^# public key: //' || true)

(umask 077 && printf '%s\n' "$secrets" >"$out")
if ! public=$(age-keygen -y "$out" 2>/dev/null); then
	rm -f "$out"
	die "age-keygen rejects the key; copy the entry again"
fi
if [[ -n "$claimed" && "$claimed" != "$public" ]]; then
	rm -f "$out"
	die "the key's public key is $public, the paste says $claimed; nothing written"
fi
echo "wrote $out (600). Its public key:"
echo "$public"
echo "It must equal the entry's '# public key:' line and AGE_RECIPIENT in the server's backup.env."

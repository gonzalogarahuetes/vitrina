/*
 * Vitrina — 006: every recipient has a wrapping.
 *
 * Forward-only, and no transaction control: the runner wraps this file, so the
 * DDL and its schema_migrations row commit together or not at all.
 *
 * A QR invite's `key` was K_album, and a qr row held no wrapping: all six
 * wrap columns NULL. Since 19 October 2026 the QR carries K_invite, 32 random
 * bytes per recipient, and the relay stores K_album wrapped under it with
 * XChaCha20-Poly1305 and the AAD "vitrina-invite-wrap-v1" ‖ recipient_id
 * (encryption spec §6.1). So `wrapped` and `wrap_nonce` are required for both
 * kinds, and only the four KDF columns stay passphrase-only (schema §3).
 *
 * Existing qr rows are refused, never converted. The relay has no K_album to
 * wrap and no K_invite to wrap it under, so there is no correct conversion: a
 * qr row without a wrapping is an invite that no longer opens, and filling its
 * columns with anything would make it one that fails as an opaque AEAD error
 * on someone else's device instead. Hence the guard, as 003's: a migration
 * cannot tell a development database from any other, so it does not try. The
 * guard is for the message; the new CHECK would reject such a row regardless.
 *
 * Passphrase rows already satisfy both new constraints, which are validated
 * against them on ADD, not NOT VALID.
 *
 * CK_recipients_passphrase_columns is replaced under a new name: from here the
 * constraint is about wrap columns of both kinds, and a name that says
 * "passphrase" invites the next reader to put qr's NULLs back.
 */

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM recipients WHERE kind = 'qr') THEN
        RAISE EXCEPTION '006 cannot run on a database that holds QR recipients'
            USING HINT = 'A QR recipient now needs K_album wrapped under its invite key, and the relay has neither key, so existing QR invites cannot be converted and no longer open. On a dev volume, reset it; on any other database, stop.';
    END IF;
END
$$;

ALTER TABLE recipients DROP CONSTRAINT "CK_recipients_passphrase_columns";
ALTER TABLE recipients DROP CONSTRAINT "CHK_recipients_kdf_wrap_kind";

ALTER TABLE recipients ADD CONSTRAINT "CHK_recipients_wrap_columns"
    CHECK (
        wrapped IS NOT NULL AND wrap_nonce IS NOT NULL
        AND (
            (kind = 'qr'         AND kdf_salt IS NULL       AND kdf_memory_kib IS NULL
                                 AND kdf_iterations IS NULL AND kdf_parallelism IS NULL)
            OR
            (kind = 'passphrase' AND kdf_salt IS NOT NULL       AND kdf_memory_kib IS NOT NULL
                                 AND kdf_iterations IS NOT NULL AND kdf_parallelism IS NOT NULL)
        )
    );

ALTER TABLE recipients ADD CONSTRAINT "CHK_recipients_kdf_wrap_kind"
    CHECK (
            octet_length(wrap_nonce) = 24      -- XChaCha20-Poly1305 nonce
        AND octet_length(wrapped)    = 48      -- K_album (32) + Poly1305 tag (16)
        AND (kind = 'qr' OR (
                octet_length(kdf_salt) = 16    -- crypto_pwhash_SALTBYTES
            AND kdf_memory_kib  >= 16384       -- absolute floor, NOT the v1 value
            AND kdf_iterations  >= 2
            AND kdf_parallelism >= 1
        ))
    );

-- ---------------------------------------------------------------------------
-- Comments
-- ---------------------------------------------------------------------------

COMMENT ON CONSTRAINT "CHK_recipients_wrap_columns" ON "recipients" IS
$$Every recipient has a wrapping of K_album: `wrapped` and `wrap_nonce` are
NOT NULL for both kinds. For a qr recipient it is under K_invite, 32 random
bytes the invite carries in its fragment and the relay never sees (encryption
spec §6.1); for a passphrase recipient, under a KEK derived from the
passphrase (§6.2). The four KDF columns — `kdf_salt` and the three Argon2id
parameters — are present together for passphrase and absent together for qr,
which has no KDF: K_invite is uniformly random and used directly.

`wrap_nonce` is the one that gets forgotten, and without it the wrapping is
undecryptable (brief §9). Parameters live per row rather than hardcoded so they
can be raised later without invalidating existing invitations (§6.2).

Replaced CK_recipients_passphrase_columns in 006, which required all six
columns NULL for qr. That rule enforced the old §6.1, under which the QR
carried K_album itself; it does not, since 19 October 2026.

A stolen database yields wrappings under two kinds of key. The qr ones are
under 256-bit random keys and cannot be attacked offline; the passphrase ones
can, given a weak passphrase, which is why passphrases MUST be system-generated
(§6.3). The two modes are stronger against different things and neither
dominates (§6.5). Do not describe either as simply stronger.$$;

COMMENT ON CONSTRAINT "CHK_recipients_kdf_wrap_kind" ON "recipients" IS
$$Exact lengths encryption spec §6.1 and §6.2 fix for version 1 — 24-byte
nonce and 48-byte wrapping for both kinds, 16-byte salt for passphrase — and
FLOORS on the Argon2id parameters: 16384 KiB, t = 2, p = 1.

Re-created by 006 to pin the wrapping's lengths on qr rows too; until then it
began `kind = 'qr' OR`, because a qr row had no wrapping to measure.

The floors are 002's. 001 shipped `>= 65536` and `>= 3`, the v1 CHOSEN values,
where floors belong: a client may post higher parameters, which is the entire
reason they are stored per row, and a constraint pinned to today's chosen values
rejects every invite created after the defaults are raised. See
CHK_owner_keys_kdf_for_password for the full argument.

The 48 is coupled to version 1 of both wrap formats. If §6.1 or §6.2 ever
changes, this constraint must change with it — which is a feature: it forces
the format change to be deliberate rather than silent.$$;

COMMENT ON COLUMN "recipients"."id" IS
$$Client-generated; no default, deliberately. It is an input to both wrap
AADs — "vitrina-invite-wrap-v1" ‖ recipient_id for qr (encryption spec §6.1)
and "vitrina-wrap-v1" ‖ recipient_id for passphrase (§6.2) — and to
K_label(recipient_id) (§2), so the client must know this value before it can
compute `wrapped` or `label`.

A DEFAULT gen_random_uuid() here would produce wrappings that cannot be
unwrapped, for either kind of recipient, and would fail as an opaque AEAD
authentication error (brief §9.3, schema doc §1).

Rewritten by 006: 001's text said a default would work fine for QR recipients,
which stored no wrapping until then.$$;

/*
 * Vitrina — 003: album titles and recipient labels become ciphertext.
 *
 * Forward-only, and the first file under the runner's rule that a migration
 * carries no transaction control: the runner wraps this file, so the DDL and
 * its schema_migrations row commit together or not at all.
 *
 * albums.title and recipients.label were plaintext on the relay — a child's
 * name and a family member's name in a database whose premise is that it can
 * read nothing (encryption spec §10). From here both are ciphertext under keys
 * derived from K_album (encryption spec §2), and the relay stores bytes it
 * cannot open.
 *
 * The columns are dropped and re-added, never converted. The relay cannot
 * encrypt what it already holds, so there is no correct conversion: an
 * `ALTER COLUMN … TYPE bytea USING convert_to(title, 'UTF8')` would store
 * plaintext in a column whose every reader assumes ciphertext, and any title
 * of 41 bytes or more would pass the length check and fail on a client as an
 * opaque decryption error. Hence the guard: this file refuses to run on a
 * database that holds any album. Checking albums covers recipients, whose
 * album_id is NOT NULL with a foreign key. The guard is for the message; the
 * NOT NULL additions below would fail on a non-empty table regardless.
 *
 * Dropping a column drops 002's COMMENT ON text with it, which said
 * "PLAINTEXT"; the replacements are at the foot of this file.
 */

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM albums) THEN
        RAISE EXCEPTION '003 cannot run on a database that holds albums'
            USING HINT = 'albums.title and recipients.label become ciphertext, and the relay cannot encrypt what is already stored. On a dev volume, reset it; on any other database, stop.';
    END IF;
END
$$;

ALTER TABLE albums DROP COLUMN "title";
ALTER TABLE albums ADD "title" bytea NOT NULL, ADD CONSTRAINT "CHK_albums_title_len" CHECK (octet_length(title) >= 41);

ALTER TABLE recipients DROP COLUMN "label";
ALTER TABLE recipients ADD "label" bytea NOT NULL, ADD CONSTRAINT "CHK_recipients_label_len" CHECK (octet_length(label) >= 41);

-- ---------------------------------------------------------------------------
-- Comments
-- ---------------------------------------------------------------------------

COMMENT ON COLUMN "albums"."title" IS
$$The album title as ciphertext: nonce (24 bytes) ‖ XChaCha20-Poly1305
ciphertext ‖ tag (16 bytes), in one field, under
K_title(album_id) = BLAKE2b-256(key = K_album, msg = "vitrina-title-v1" ‖ album_id)
with an empty AAD (encryption spec §2). The relay cannot read it, and no route
may carry the key that made it (brief §6 #16).

Under K_album rather than K_master because recipients read it as well as owners
(api-sketch §9.4), and recipients never hold K_master. Owner and recipient
receive the same bytes, which is why §9.4's response is one shape for both.

Replaced rather than converted by 003: the plaintext column could not be
encrypted by the relay, so 003 refuses to run on a database holding any album.

The bound is in bytes, and only its floor is here (CHK_albums_title_len). The
1024-byte ceiling is enforced at the route. The 200-character limit belongs to
the client: the relay cannot count characters inside ciphertext.$$;

COMMENT ON CONSTRAINT "CHK_albums_title_len" ON "albums" IS
$$41 bytes: nonce (24), one byte of plaintext, tag (16). Floor only,
deliberately. A constraint belongs in the database where getting it wrong is
unrecoverable: a short blob is one no client can open, discovered at decrypt
time on someone else's device. The 1024 ceiling is relay policy — an oversized
blob still decrypts, the cost is storage, and it is enforced at the route where
it can move without a migration. Do not complete the pair.$$;

COMMENT ON COLUMN "recipients"."label" IS
$$The recipient label as ciphertext — albums.title's construction under
K_label(recipient_id) = BLAKE2b-256(key = K_album, msg = "vitrina-label-v1" ‖ recipient_id)
with an empty AAD (encryption spec §2). Typically a family member's name; the
relay cannot read it, and no route may carry the key that made it
(brief §6 #16).

Under K_album rather than K_master because api-sketch §11.4 returns the label to
the recipient it names, as the input to the client-side watermark (brief §5),
and recipients never hold K_master. recipients.id was already client-generated
for the wrap AAD, so the owner holds it before encrypting the label.

Replaced rather than converted by 003, for the reason on albums.title.

The bound is in bytes, and only its floor is here (CHK_recipients_label_len).
The 1024-byte ceiling is enforced at the route; any character limit belongs to
the client.$$;

COMMENT ON CONSTRAINT "CHK_recipients_label_len" ON "recipients" IS
$$41 bytes: nonce (24), one byte of plaintext, tag (16). Floor only,
deliberately. A constraint belongs in the database where getting it wrong is
unrecoverable: a short blob is one no client can open, discovered at decrypt
time on someone else's device. The 1024 ceiling is relay policy — an oversized
blob still decrypts, the cost is storage, and it is enforced at the route where
it can move without a migration. Do not complete the pair.$$;

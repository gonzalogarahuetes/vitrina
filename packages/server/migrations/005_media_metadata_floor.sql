/*
 * Vitrina — 005: a database floor on media.metadata.
 *
 * Forward-only, and no transaction control: the runner wraps this file, so the
 * DDL and its schema_migrations row commit together or not at all.
 *
 * The route already refuses a metadata envelope under 81 bytes (api-sketch
 * §9.6). This is 003's rule applied to the one ciphertext column it did not
 * reach: a constraint belongs in the database where getting it wrong is
 * unrecoverable, and a short envelope is one no client can open.
 *
 * Validated, not NOT VALID. ADD CONSTRAINT checks every existing row, and a
 * row under the floor makes this file fail and record nothing. Rows created
 * through §9.6 already satisfy it. One that does not is an envelope no client
 * can open, and the migration should stop on it rather than step around it.
 */

ALTER TABLE media
    ADD CONSTRAINT "CHK_media_metadata_len" CHECK (octet_length(metadata) >= 81);

-- ---------------------------------------------------------------------------
-- Comments
-- ---------------------------------------------------------------------------

COMMENT ON CONSTRAINT "CHK_media_metadata_len" ON "media" IS
$$81 bytes: the 64-byte header, one byte of plaintext, the 16-byte tag — the
smallest object encryption spec §3.2 admits, since plaintext_length 0 is
invalid. Floor only, deliberately. A constraint belongs in the database where
getting it wrong is unrecoverable: a short blob is one no client can open,
discovered at decrypt time on someone else's device. The 4096 ceiling is relay
policy — an oversized blob still decrypts, the cost is storage, and it is
enforced at the route where it can move without a migration. Do not complete
the pair.$$;

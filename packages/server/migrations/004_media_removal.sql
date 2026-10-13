/*
 * Vitrina — 004: an owner can remove one media row (api-sketch §9.11).
 *
 * Forward-only, and no transaction control: the runner wraps this file, so the
 * DDL and its schema_migrations row commit together or not at all.
 *
 * Two columns, both on media, and no change to the status ladder: removal is
 * not a stage of ingest, so non-negotiable #9's sequence stays as written and
 * `removed_at` sits beside it rather than in it.
 *
 * Removal hides first and erases second. Setting removed_at is the owner's
 * intent taking effect — every read stops serving the row from that commit —
 * and deleting the two objects and then the row is the erasure, which can be
 * retried. Deleting the row first would orphan ciphertext nothing can find
 * (api-sketch §4.2); deleting the objects first would leave a `ready` row whose
 * objects are gone.
 */

ALTER TABLE media
    ADD "removed_at" timestamptz NULL,
    ADD "uploads_in_flight" smallint NOT NULL DEFAULT 0,
    ADD CONSTRAINT "CHK_media_uploads_in_flight" CHECK (uploads_in_flight >= 0);

-- ---------------------------------------------------------------------------
-- Comments
-- ---------------------------------------------------------------------------

COMMENT ON COLUMN "media"."removed_at" IS
$$When the owner removed this row (api-sketch §9.11). NULL means live. Once set,
no route serves or accepts the row, and it is never unset: the only way out of
this state is the row's deletion, after both objects are confirmed absent from
the store.

Erasure covers what the relay holds. It does not reach a copy any recipient
already retrieved, and a Postgres backup holds the row until that backup
rotates.$$;

COMMENT ON COLUMN "media"."uploads_in_flight" IS
$$Uploads (api-sketch §9.7) that have started on this row and not yet ended.
beginUpload increments it in the statement that admits the upload; endUpload
decrements it, on every exit path, after the store has answered the PUT.

Removal may delete the row only at zero. Above zero an object may still land,
and erasing then would report a removal complete while ciphertext arrives
behind it — the false confirmation §4.2 exists to prevent.

A process that dies mid-upload leaves this above zero, and the row's removal
answers 202 until something intervenes. That is deliberate: a counter that
stalls says so, and a time-limited lease in its place would eventually allow a
204 while a late write can still land (brief §6 #17). A stale counter is told
from a live one by updated_at, which beginUpload moves forward; that is the
column a Phase 2 sweep reads, and no timestamp column is needed for it.$$;

/*
 * Vitrina — initial schema.
 *
 * PROVISIONAL. Phase 1 is expected to change this schema, and that is the plan
 * rather than a failure: `owners` in particular has nothing to authenticate
 * against yet because the owner account model is still an open decision
 * (brief §9.2, §12).
 *
 * Derived from vitrina-project-brief.md §9 (data model, §9.1–§9.3) plus
 * vitrina-encryption-spec.md §6–§7 (recipient key wrapping, metadata storage).
 * Those documents are authoritative. If this file and they disagree, this file
 * is the one that is wrong — fix it deliberately and note which changed
 * (schema doc §0).
 *
 * Column-level reasoning is attached with COMMENT ON at the foot of this file
 * rather than as `--` comments, so that it survives into the live database and
 * shows up in `\d+` and `pg_dump`.
 */

BEGIN;

CREATE TABLE owners (
    "id" uuid NOT NULL default gen_random_uuid(),
    "created_at" TIMESTAMP WITH TIME ZONE NOT NULL default now(),
    CONSTRAINT "PK_owners" PRIMARY KEY ("id")
);

CREATE TABLE owner_tokens (
    "id" uuid NOT NULL default gen_random_uuid(),
    "owner_id" uuid NOT NULL,
    "token_hash" bytea NOT NULL,
    "expires_at" TIMESTAMP WITH TIME ZONE NOT NULL,
    "revoked_at" TIMESTAMP WITH TIME ZONE NULL,
    "created_at" TIMESTAMP WITH TIME ZONE NOT NULL default now(),
    CONSTRAINT "PK_owner_tokens" PRIMARY KEY ("id"),
    CONSTRAINT "UQ_owner_tokens_token_hash" UNIQUE ("token_hash"),
    CONSTRAINT "FK_owner_token_owner" FOREIGN KEY ("owner_id") REFERENCES "owners" ("id") ON DELETE CASCADE,
    CONSTRAINT "CHK_owner_tokens_token_hash_len" CHECK (octet_length(token_hash) = 32)
);

CREATE TABLE albums (
    "id" uuid NOT NULL default gen_random_uuid(),
    "owner_id" uuid NOT NULL,
    "title" text NOT NULL,
    "created_at" TIMESTAMP WITH TIME ZONE NOT NULL default now(),
    CONSTRAINT "PK_albums" PRIMARY KEY ("id"),
    CONSTRAINT "FK_album_owner" FOREIGN KEY ("owner_id") REFERENCES "owners" ("id") ON DELETE CASCADE
);

CREATE TABLE media (
    "id" uuid NOT NULL,
    "album_id" uuid NOT NULL,
    "kind" text NOT NULL CHECK (kind IN ('photo','video')),
    "status" text NOT NULL default 'pending' CHECK (status IN ('pending','processing','ready','failed')),
    "byte_size" bigint NULL,
    "metadata" bytea NULL,
    "created_at" TIMESTAMP WITH TIME ZONE NOT NULL default now(),
    "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL default now(),
    CONSTRAINT "PK_media" PRIMARY KEY ("id"),
    CONSTRAINT "FK_media_album" FOREIGN KEY ("album_id") REFERENCES "albums" ("id") ON DELETE CASCADE
);

CREATE TABLE recipients (
    "id" uuid NOT NULL,
    "album_id" uuid NOT NULL,
    "kind" text NOT NULL CHECK (kind IN ('qr','passphrase')),
    "label" text NOT NULL,
    "token_hash" bytea NOT NULL,
    "wrapped" bytea NULL,
    "wrap_nonce" bytea NULL,
    "kdf_salt" bytea NULL,
    "kdf_memory_kib" integer NULL,
    "kdf_iterations" integer NULL,
    "kdf_parallelism" integer NULL,
    "revoked_at" TIMESTAMP WITH TIME ZONE NULL,
    "created_at" TIMESTAMP WITH TIME ZONE NOT NULL default now(),

    CONSTRAINT "PK_recipients" PRIMARY KEY ("id"),
    CONSTRAINT "UQ_recipients_token_hash" UNIQUE ("token_hash"),
    CONSTRAINT "FK_recipients_album" FOREIGN KEY ("album_id") REFERENCES "albums" ("id") ON DELETE CASCADE,
    CONSTRAINT "CK_recipients_passphrase_columns" CHECK (
        num_nonnulls(wrapped, wrap_nonce, kdf_salt,
                    kdf_memory_kib, kdf_iterations, kdf_parallelism)
        = CASE kind WHEN 'passphrase' THEN 6 ELSE 0 END
    ),
    CONSTRAINT "CHK_recipients_token_hash_len" CHECK (octet_length(token_hash) = 32),
    CONSTRAINT "CHK_recipients_kdf_wrap_kind"
    CHECK (
        kind = 'qr' OR (
                octet_length(kdf_salt)   = 16      -- crypto_pwhash_SALTBYTES
            AND octet_length(wrap_nonce) = 24      -- XChaCha20-Poly1305 nonce
            AND octet_length(wrapped)    = 48      -- K_album (32) + Poly1305 tag (16)
            AND kdf_memory_kib  >= 65536     
            AND kdf_iterations  >= 3
            AND kdf_parallelism >= 1
    )
)
);

CREATE TABLE access_log (
    "id" bigint GENERATED ALWAYS AS IDENTITY,
    "recipient_id" uuid NOT NULL,
    "media_id" uuid NULL,
    "event" text NOT NULL CHECK (event IN ('album_opened','asset_viewed')),
    "occurred_at" TIMESTAMP WITH TIME ZONE NOT NULL default now(),

    CONSTRAINT "PK_access_log" PRIMARY KEY ("id"),
    CONSTRAINT "FK_access_log_recipient" FOREIGN KEY ("recipient_id") REFERENCES "recipients" ("id") ON DELETE CASCADE,
    CONSTRAINT "FK_access_log_media" FOREIGN KEY ("media_id") REFERENCES "media" ("id") ON DELETE CASCADE
);

CREATE INDEX "IDX_recipient_album_id" ON "recipients" ("album_id");
CREATE INDEX "IDX_media_album_id" ON "media" ("album_id");
CREATE INDEX "IDX_album_owner_id" ON "albums" ("owner_id");
CREATE INDEX "IDX_access_log_recipient_id" ON "access_log" ("recipient_id", occurred_at DESC);
CREATE INDEX "IDX_access_log_media_id" ON "access_log" ("media_id");
CREATE INDEX "IDX_owner_token_owner_id" ON "owner_tokens" ("owner_id");

COMMENT ON COLUMN "owner_tokens"."token_hash" IS
$$SHA-256 of a 32-byte random token, stored as raw bytes (schema doc §1) —
deliberately NOT Argon2id. There is nothing to brute-force in 256 bits of CSPRNG
entropy, so a password hash here would buy no security and would cost a KDF on
every authenticated request (brief §9.3).

The inverse holds too, and that is why this is written down rather than left to
be rediscovered: recipients.wrapped IS protected by Argon2id, precisely because a
human-transcribable passphrase is brute-forceable (encryption spec §6.3). This
schema holds three different kinds of hash and they are not interchangeable — do
not "optimise" either into the other. An owner password, if brief §12's account
model turns out to need one, needs Argon2id as well.

Hashed rows with an expiry, not server-side sessions (non-negotiable #6,
brief §6). Several live rows per owner is normal — one per signed-in device.$$;

COMMENT ON COLUMN "albums"."title" IS
$$Stored as PLAINTEXT on the relay. This is a deliberate choice for now and NOT
settled design — encryption spec §10 records it as an open limitation, and brief
§9.2 and schema doc §5 list it as unresolved. An album title is typically a
child's name ("Sofía's first birthday"), so it is readable by whoever operates
the relay, in a product whose pitch is that the relay can read nothing.

It is not simply fixed because encrypting the title means an owner cannot see
their own album list without holding K_album, which requires first answering how
an owner retains K_album across sessions and devices (brief §11). Encryption
spec §10: the two decisions are coupled and must be made together. Decided-for-
now, not never-considered.$$;

COMMENT ON COLUMN "recipients"."label" IS
$$Stored as PLAINTEXT on the relay — the same open question as albums.title, and
the same coupling. Encryption spec §6.1 says the server holds "a label" for each
recipient; §10 records that a label is a family member's name ("María") sitting
readable in the database. A deliberate current choice under the accident-not-
adversary threat model (brief §2), not a settled decision: see schema doc §5 and
brief §11.$$;

COMMENT ON COLUMN "media"."id" IS
$$Client-generated, and it IS the 16-byte asset_id carried at offset 36 of the
envelope header (encryption spec §3.1). A UUIDv4 the client creates from a
CSPRNG before it starts encrypting (encryption spec §2), so it cannot be
server-assigned — which is why this column deliberately has no default
(brief §9.3, schema doc §1).

Asset and thumbnail object keys are derived from this value rather than stored,
so there is no object-key column and no second value that can drift
(brief §9.2).$$;

COMMENT ON COLUMN "media"."byte_size" IS
$$A denormalised cache, kept so that answering "how much is this owner storing"
does not require enumerating a bucket — owner quota and storage accounting.
Object storage is authoritative; this column is not (brief §9.2). Nullable
because the row exists before the object does.$$;

COMMENT ON COLUMN "media"."metadata" IS
$$The encrypted metadata envelope for this asset — filenames, capture
timestamps, dimensions, serialized as JSON and encrypted under
K_meta(asset_id) = BLAKE2b-256(key = K_album, msg = "vitrina-meta-v1" ‖
asset_id) using the ordinary envelope format (encryption spec §2, §7).

Held as a binary column rather than as an object in the bucket, deliberately and
against the general rule that ciphertext goes to object storage: a metadata
envelope is a few hundred bytes, is never range-requested, and is always fetched
together with its whole album, so opening a hundred-photo album would otherwise
mean a hundred proxied storage fetches. Encryption spec §7 states the trade-off
and its cost. Not an oversight — do not move it to the bucket.

Nullable because it does not exist until ingest completes.$$;

COMMENT ON COLUMN "media"."updated_at" IS
$$Maintained by packages/server on every write, deliberately NOT by a database
trigger. Stated explicitly so that nobody "fixes" the apparent omission by
adding one: a trigger plus the application code would be two writers to the same
column. One writer, in the application.$$;

COMMENT ON COLUMN "recipients"."id" IS
$$Client-generated; no default, deliberately. It is an input to the key-wrap
AAD ("vitrina-wrap-v1" ‖ recipient_id, encryption spec §6.2), so the client must
know this value before it can compute `wrapped` for a passphrase recipient.

A DEFAULT gen_random_uuid() here would produce a blob that cannot be unwrapped,
would work fine for QR recipients — which store no wrapped key at all — and
would fail as an opaque AEAD authentication error (brief §9.3, schema doc §1).$$;

COMMENT ON COLUMN "recipients"."token_hash" IS
$$SHA-256 of a 32-byte random token, stored as raw bytes — the same choice as
owner_tokens.token_hash and for the same reason: 256 bits of CSPRNG entropy
leaves nothing to brute-force, so Argon2id here would be pure per-request cost.
Not interchangeable with recipients.wrapped in this same table, which needs
Argon2id exactly because a passphrase does not have that entropy (brief §9.3,
encryption spec §6.3). Do not "optimise" either into the other.

This is the recipient's invite ACCESS token, a separate secret from K_album, and
that separation is what makes revocation work (encryption spec §6.4). The token
lets its holder FETCH ciphertext, and the server holds only this hash so it can
invalidate the token instantly. K_album lets them DECRYPT, and the server never
has it. Revoking sets revoked_at: it prevents all future access to ciphertext and
does nothing about anything already retrieved. Server-enforced, not
cryptographic.

Recipients have no account and no separate token table. There is deliberately no
access_tokens table — a single shared token table invites treating owner account
auth and album access as one mechanism, which is the easiest way to leak album
access (brief §9.1).$$;

COMMENT ON CONSTRAINT "CK_recipients_passphrase_columns" ON "recipients" IS
$$Enforces encryption spec §6.1: a QR recipient stores NO wrapped key
server-side in any form. K_album travels inside the invite payload and the relay
never holds it, so that a full database theft yields ciphertext and nothing that
helps decrypt it.

All six passphrase columns are therefore present together or absent together —
`wrapped`, `wrap_nonce`, `kdf_salt` and the three Argon2id parameters, which are
the four conceptual items of encryption spec §6.2. `wrap_nonce` is the one that
gets forgotten, and without it the wrapped blob is undecryptable (brief §9).
Parameters live per row rather than hardcoded so they can be raised later
without invalidating existing invitations (encryption spec §6.2).$$;

COMMENT ON TABLE "access_log" IS
$$Powers the "María viewed this" feature (brief §9). Granularity is per asset
opened, never per chunk fetched — a hundred-photo album is roughly twelve
hundred chunk requests, which answers no question anyone has and makes the table
unusable (brief §9.3). media_id is NULL for album_opened.

Revoking a recipient sets recipients.revoked_at and does NOT delete the
recipients row, so a revoked recipient's history is preserved here. The
ON DELETE CASCADE on recipient_id fires only on an actual DELETE of the
recipient, which in v1 happens only when their album or owner is deleted — and
at that point this history should go too (schema doc §5).

Revocation is enforced by the server refusing to serve ciphertext, not by
mathematics: it stops future fetches and does nothing about anything already
retrieved (encryption spec §6.4, brief §8).

Viewing behaviour is personal data; retention is a Phase 2 GDPR item
(schema doc §3, brief §11).$$;

COMMIT;
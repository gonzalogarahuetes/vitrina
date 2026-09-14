/*
 * Vitrina — Phase 1 migration: the owner account.
 *
 * Forward-only. 001_initial_schema.sql has applied and is never edited; where
 * this file corrects it, the correction is a statement here, not a change
 * there. Three kinds of change:
 *
 *   1. New. `owners` gains `email` and `auth_hash`; `owner_keys` is created;
 *      `albums` gains the K_album wrapping. Together these are what
 *      POST /v1/signup, POST /v1/login/params and POST /v1/albums write
 *      (api-sketch §7.5, §8, §9.2). No route can exist without them.
 *
 *   2. Corrections to applied DDL. `albums.id` loses its default — it is inside
 *      the album-wrap AAD (encryption spec §2), so the client generates it.
 *      `media.metadata` becomes NOT NULL — the envelope is posted at media
 *      create (api-sketch §9.6). And `recipients`' KDF constraint is dropped
 *      and re-added with FLOORS rather than the v1 CHOSEN values: 001 shipped
 *      `>= 65536` and `>= 3`, which is the bug schema §0 says to name — the
 *      migration was wrong, the document was right (schema §3, recipients).
 *
 *   3. Corrections to COMMENT ON text. Comments are live data in the database,
 *      so editing 001's file would not reach them even if editing an applied
 *      migration were allowed. Several are now false: the owner account model
 *      was decided on 20 August 2026 (brief §12 — email and password); an owner
 *      password does NOT need Argon2id on the relay (encryption spec §6.6.1);
 *      and the title/label encryption question is no longer coupled to owner
 *      key retention (brief §11). Each is rewritten below in full.
 *
 * 001's own header still says the owner account model is open. That is a file
 * comment, not database state, and it stays as history; this header is what
 * supersedes it.
 *
 * Column-level reasoning is attached with COMMENT ON at the foot of this file,
 * as in 001, so that it survives into the live database and shows up in `\d+`
 * and `pg_dump`.
 */

BEGIN;

ALTER TABLE owners ADD "email" text NOT NULL, ADD CONSTRAINT "UQ_owners_email" UNIQUE ("email");
ALTER TABLE owners ADD "auth_hash" bytea NOT NULL, ADD CONSTRAINT "CHK_owners_auth_hash_len" CHECK (octet_length(auth_hash) = 32);

CREATE TABLE owner_keys (
    "id" uuid NOT NULL default gen_random_uuid(),
    "owner_id" uuid NOT NULL,
    "kind" text NOT NULL CHECK (kind IN ('password','recovery')),
    "wrapped_master" bytea NOT NULL,
    "wrap_nonce" bytea NOT NULL,
    "kdf_salt" bytea NULL,
    "kdf_memory_kib" integer NULL,
    "kdf_iterations" integer NULL,
    "kdf_parallelism" integer NULL,
    "created_at" TIMESTAMP WITH TIME ZONE NOT NULL default now(),
    CONSTRAINT "PK_owner_keys" PRIMARY KEY ("id"),
    CONSTRAINT "FK_owner_keys_owners" FOREIGN KEY ("owner_id") REFERENCES "owners" ("id") ON DELETE CASCADE,
    CONSTRAINT "CHK_owner_keys_wrapped_master_len" CHECK (octet_length(wrapped_master) = 48),
    CONSTRAINT "CHK_owner_keys_wrap_nonce_len" CHECK (octet_length(wrap_nonce) = 24),
    CONSTRAINT "CHK_owner_keys_kdf_for_password" CHECK (
                                                            kind <> 'password' OR (
                                                                    kdf_salt IS NOT NULL
                                                                AND octet_length(kdf_salt) = 16
                                                                AND kdf_memory_kib IS NOT NULL
                                                                AND kdf_iterations IS NOT NULL
                                                                AND kdf_parallelism IS NOT NULL
                                                                AND kdf_memory_kib >= 16384
                                                                AND kdf_iterations >= 2 AND kdf_parallelism >= 1
                                                            )
                                                        )
);
CREATE UNIQUE INDEX "UQ_owner_keys_one_password" ON "owner_keys" ("owner_id") WHERE kind = 'password';
CREATE INDEX "IDX_owner_key_owner_id" ON "owner_keys" ("owner_id");

ALTER TABLE albums ALTER COLUMN "id" DROP DEFAULT;
ALTER TABLE albums ADD "wrapped_key" bytea NOT NULL, ADD CONSTRAINT "CHK_albums_wrapped_key_len" CHECK (octet_length(wrapped_key) = 48);
ALTER TABLE albums ADD "wrap_nonce" bytea NOT NULL, ADD CONSTRAINT "CHK_albums_wrap_nonce_len" CHECK (octet_length(wrap_nonce) = 24);

ALTER TABLE media ALTER COLUMN metadata SET NOT NULL;

ALTER TABLE recipients DROP CONSTRAINT "CHK_recipients_kdf_wrap_kind";
ALTER TABLE recipients ADD CONSTRAINT "CHK_recipients_kdf_wrap_kind" 
                            CHECK (
                                kind = 'qr' OR (
                                        octet_length(kdf_salt)   = 16      -- crypto_pwhash_SALTBYTES
                                    AND octet_length(wrap_nonce) = 24      -- XChaCha20-Poly1305 nonce
                                    AND octet_length(wrapped)    = 48      -- K_album (32) + Poly1305 tag (16)
                                    AND kdf_memory_kib  >= 16384     
                                    AND kdf_iterations  >= 2
                                    AND kdf_parallelism >= 1
                                )
                            );

-- ---------------------------------------------------------------------------
-- New objects
-- ---------------------------------------------------------------------------

COMMENT ON COLUMN "owners"."email" IS
$$The NORMALISED address — NFC, trimmed of Unicode White_Space, unconditional
lowercase — as computed by the one normalisation function in packages/server
(api-sketch §8.2, address normalisation). The as-typed spelling is not retained
anywhere. Clients MUST NOT normalise before sending (encryption spec §6.6): a
second implementation of the rule is a second thing that can disagree.

Deliberately plain `text`, not `citext`, and with no `lower()` CHECK. Either
would be a database-level fold applying its own rules — citext's, or the
collation's — beside the relay's unconditional mapping, and the two disagree in
cases nobody finds until an owner cannot log in. The rule is simple because it
has exactly one implementation; this column holds its output and does not
re-derive it.

UQ_owners_email is what POST /v1/signup's 409 fires on, raised from the
constraint violation inside the same transaction as the insert — never from a
SELECT beforehand, which is a race admitting two accounts for one address
(api-sketch §7.5). The 409 reveals that an address is registered; that is a
recorded limitation (brief §11, encryption spec §10), not something this schema
can hide.$$;

COMMENT ON COLUMN "owners"."auth_hash" IS
$$HMAC-SHA-256(pepper, "vitrina-auth-pepper-v1" ‖ proof), 32 bytes, where
`proof` is the 32-byte login proof the client derives from its Argon2id root
(encryption spec §6.6.1, api-sketch §8.2). Compared in constant time on
POST /v1/login — the one place in this system where two 32-byte values are
compared rather than looked up.

This is the THIRD kind of hash in this schema and it is neither of the other
two (brief §9.3, constraints a migration cannot express). It looks identical to
owner_tokens.token_hash — both 32 high-entropy bytes — but only one of them is
KNOWN to be. The relay mints its own tokens, so their entropy is a fact and a
plain SHA-256 is safe. A proof's entropy is a claim about what a client did with
Argon2id, which the relay cannot check, so a plain fast hash here would be safe
exactly as long as every client implementation stays correct. The pepper is what
answers that: without it the comparison value cannot be computed at all,
whatever the client did.

Nor is it Argon2id. The relay never sees a password, so there is nothing for a
KDF to protect that the pepper does not already; Argon2id over the proof would
only slow an attacker holding the pepper, and would make the dummy verification
on login a memory-allocation vector. Hence no auth_salt and no server-side KDF
columns — there is nothing per-account to parameterise (schema §3, owners).

The pepper is one server secret, domain-separated from the decoy salt
(api-sketch §8.2), effectively permanent, backed up as reliably as this database
and NOT in the same artifact. Absent at boot is a hard failure, never a generated
substitute (brief §6 #17): generate-if-missing works perfectly on an empty
deployment and breaks every login once accounts exist.$$;

COMMENT ON TABLE "owner_keys" IS
$$N wrappings of one K_master, one row per credential (brief §11, decided
20 August 2026). K_master is 32 random bytes generated client-side at signup;
every K_album the owner has is wrapped under it (encryption spec §2, §6.6). The
relay holds K_master only as ciphertext, in wrapped_master, under a key derived
from a credential it never sees.

Several rows per owner is the point of a table rather than a column. v1 has
exactly one, kind = 'password'. Phase 2's recovery key is an INSERT with no
migration and no re-encryption; a password change re-wraps K_master once and
updates the password row, and no album key is touched, because K_album is
WRAPPED by K_master rather than derived from it. A single master_key_wrapped
column on owners would have chosen no-recovery permanently.

Recovery is out of v1 and the consequence is not softenable: forgetting the
password loses every album. The relay cannot re-wrap what it cannot read.

The owners row and the first row here are written in ONE transaction
(api-sketch §7.5). An owner with no wrapping can authenticate and decrypt
nothing, and no route can repair that state.$$;

COMMENT ON COLUMN "owner_keys"."kind" IS
$$Which credential wraps K_master in this row. 'password' is the only value v1
writes; 'recovery' is Phase 2. Two routes select by it — POST /v1/login/params
and GET /v1/owner/key both read THE password row — which is why
UQ_owner_keys_one_password exists rather than leaving "exactly one" as prose.$$;

COMMENT ON INDEX "UQ_owner_keys_one_password" IS
$$Exactly one row of kind = 'password' per owner, enforced. Stated in two
documents as prose and given a mechanism here: a `SELECT … LIMIT 1` without the
kind predicate works until the second row exists (api-sketch §7.5,
/login/params). Recovery rows are not covered by this index — several may exist
if Phase 2 wants them.$$;

COMMENT ON COLUMN "owner_keys"."wrapped_master" IS
$$K_master under the password-derived KEK: XChaCha20-Poly1305, 48 bytes —
K_master (32) plus the Poly1305 tag (16). Ciphertext, not key material: it may
be posted (POST /v1/signup) and returned (GET /v1/owner/key, always with
Cache-Control: no-store); the key that wrapped it and the password it was derived
from may never reach the relay (brief §6 #16).

The length is enforced exactly because a wrong length is not a style problem —
it is a blob that cannot be unwrapped, discovered at unwrap time as an opaque
AEAD failure with no diagnostic (encryption spec §6.2, §9.1). Same rule as
recipients.wrapped and albums.wrapped_key.$$;

COMMENT ON COLUMN "owner_keys"."wrap_nonce" IS
$$24-byte XChaCha20-Poly1305 nonce for wrapped_master, fresh per wrapping. The
column that gets forgotten (brief §9, schema §3): without it the wrapped blob is
undecryptable.$$;

COMMENT ON COLUMN "owner_keys"."kdf_salt" IS
$$16 bytes — crypto_pwhash_SALTBYTES — random and client-generated at signup.
The salt for the SINGLE client-side Argon2id run whose root yields both the KEK
and the login proof by keyed hash with distinct domain strings (encryption spec
§6.6.1). Returned verbatim by POST /v1/login/params for the address it belongs
to. NULL for kinds that need no password KDF; required for 'password' by
CHK_owner_keys_kdf_for_password.$$;

COMMENT ON COLUMN "owner_keys"."kdf_memory_kib" IS
$$Argon2id memory, KiB, per row. READ BEFORE RAISING THIS FOR ONE ACCOUNT.

Decoy indistinguishability at POST /v1/login/params holds only while every row's
three kdf_* values agree. The route answers 200 for every address and, on a
miss, returns a deterministic decoy salt with the v1 chosen parameters; a decoy
has nothing to distinguish itself from only because every real row carries
those same parameters. The moment one account's values differ, a real row is
distinguishable from a decoy by its parameters alone, and the property degrades
for that account (encryption spec §6.6.1, api-sketch §7.5).

Per-row storage exists precisely so these CAN be raised without invalidating
existing accounts, so this is a cost to know about rather than a rule against
raising — but whoever raises them is reading this column, not the documents.
The other place this warning lives is the one function that inserts an
owner_keys row (api-sketch §8.1); there must be exactly one.

v1 chosen value: 65536 (64 MiB), normative since 14 September 2026 (encryption
spec §6.2, brief §12). Floor enforced by CHK_owner_keys_kdf_for_password:
16384. The floor is NOT the chosen value — see that constraint's comment.$$;

COMMENT ON COLUMN "owner_keys"."kdf_iterations" IS
$$Argon2id iterations (t), per row. v1 chosen value 3; floor 2. See
kdf_memory_kib before raising this for one account — the decoy warning there
applies to all three kdf_* columns together.$$;

COMMENT ON COLUMN "owner_keys"."kdf_parallelism" IS
$$Argon2id parallelism (p), per row. v1 chosen value 1; floor 1. See
kdf_memory_kib before raising this for one account — the decoy warning there
applies to all three kdf_* columns together.$$;

COMMENT ON CONSTRAINT "CHK_owner_keys_kdf_for_password" ON "owner_keys" IS
$$For kind = 'password': the salt is present and 16 bytes, all three Argon2id
parameters are present, and each is at or above its FLOOR — 16384 KiB, t = 2,
p = 1 (api-sketch §8.1). Other kinds are unconstrained here: a recovery key is
high-entropy random and needs no password KDF, the same shape as recipients'
QR rows.

The floors are floors, not the v1 chosen values (65536 / 3 / 1). The distinction
is the specific bug 001 shipped on recipients and this migration corrects: a
client is PERMITTED to post higher parameters — that is the entire reason they
are stored per row — and a constraint pinned to today's chosen values rejects
every account created after Phase 2 raises them. POST /v1/signup validates
against these same floors, never against the chosen values.

What the floor protects against is degradation to something pointless — a bug
or careless client setting memory to a few hundred KiB, which makes the offline
attack against wrapped_master effectively free. If the chosen value ever needs
to go BELOW this floor, do not relax the floor: that would mean Argon2id cannot
run at meaningful strength on target hardware, which is a question about whether
the design is viable, not a constraint to loosen quietly (schema §3,
recipients).$$;

COMMENT ON COLUMN "albums"."id" IS
$$Client-generated; default dropped by 002, deliberately. It is inside the
album-wrap AAD — "vitrina-album-wrap-v1" ‖ album_id, the 16 raw UUID bytes
(encryption spec §2) — so the client must hold it before it can compute
wrapped_key. The third client-generated id after media.id and recipients.id,
and one rule rather than three exceptions: every id that sits inside an AAD is
client-generated, because a value the AAD authenticates must exist before the
thing it authenticates is computed (brief §9.3).

A DEFAULT gen_random_uuid() here would store a wrapping computed under one id
against a row carrying another; the unwrap fails as an opaque AEAD error and the
album is unopenable from any second device. POST /v1/albums returns 409 on a
duplicate id because a collision is a client retrying a create whose response it
lost, and a fresh id would orphan the wrapping already computed under the old
one (api-sketch §9.2).$$;

COMMENT ON COLUMN "albums"."wrapped_key" IS
$$K_album under K_master: XChaCha20-Poly1305, 48 bytes — K_album (32) plus the
Poly1305 tag (16) — with the album id bound in the AAD (encryption spec §2).
Required at POST /v1/albums and returned for every album by GET /v1/albums
(Cache-Control: no-store), which is how an owner recovers their album keys on a
second device after unwrapping K_master (api-sketch §9.2).

Ciphertext, not key material (brief §6 #16). NOT NULL because an album row with
no wrapping is an album its owner can never re-open elsewhere — the same
unrepairable shape as an owner with no owner_keys row, one level down. The
binding of album_id buys failure at the right layer: a wrapping moved between
two albums unwraps fine without it, yielding the wrong K_album, after which
every asset fails to decrypt several layers from the cause.

Storing this does NOT change the property encryption spec §6.1 protects for QR
recipients. It is wrapped under a key derived from the owner's password, so a
stolen database yields an offline attack against that password — the cost brief
§11 accepted, stated plainly, for a K_master that works across devices.$$;

COMMENT ON COLUMN "albums"."wrap_nonce" IS
$$24-byte XChaCha20-Poly1305 nonce for wrapped_key, fresh per album. The column
that gets forgotten; without it the wrapped blob is undecryptable.$$;

COMMENT ON TABLE "owners" IS
$$Parent accounts. Email and password (brief §12, decided 20 August 2026); the
password never reaches the relay, which holds only auth_hash and, in owner_keys,
K_master wrapped under a key it cannot derive.

CASCADE IS NOT ERASURE. Every foreign key below this table cascades, so
`DELETE FROM owners` tidily removes albums, media rows, recipients and log
entries — and leaves every encrypted photograph in object storage indefinitely,
while destroying the only record of which objects existed, because media.id IS
the object key. That is storage paid for forever and a right-to-erasure request
reported as satisfied without deleting the images. Deleting an owner or an album
MUST be an application operation that removes storage objects first and rows
second (brief §9.3, schema §5.1, api-sketch §4.2). ON DELETE CASCADE here is a
referential-integrity safety net for rows, not the mechanism of erasure. The
same applies to `DELETE FROM albums`.$$;

-- ---------------------------------------------------------------------------
-- Corrections to comments 001 applied, now false
-- ---------------------------------------------------------------------------

COMMENT ON COLUMN "owner_tokens"."token_hash" IS
$$SHA-256 of a 32-byte random token, stored as raw bytes (schema §1, §6) —
deliberately NOT Argon2id. There is nothing to brute-force in 256 bits of CSPRNG
entropy, so a password hash here would buy no security and would cost a KDF on
every authenticated request (brief §9.3).

This schema holds THREE kinds of hash and they are not interchangeable — do not
"optimise" any into another:

  - token_hash, here and on recipients: SHA-256 of a relay-minted random token.
    Its entropy is a fact, so a fast hash is safe.
  - recipients.wrapped: protected by Argon2id, because a human-transcribable
    passphrase IS brute-forceable (encryption spec §6.3).
  - owners.auth_hash: HMAC(pepper, proof) — a keyed fast hash, neither of the
    above. The relay never sees a password and applies no KDF (encryption spec
    §6.6.1). See that column's comment.

001's version of this comment said an owner password would need Argon2id on the
relay. It does not, and the reasoning is on owners.auth_hash.

Hashed rows with an expiry, not server-side sessions (non-negotiable #6,
brief §6). Several live rows per owner is normal — one per signed-in device.
POST /v1/logout revokes the presented token only; /logout/all revokes every
row for the owner including the caller's (api-sketch §7.5).$$;

COMMENT ON COLUMN "albums"."title" IS
$$Stored as PLAINTEXT on the relay. A recorded limitation (encryption spec §10;
schema §5), not a settled design: an album title is typically a child's name
("Sofía's first birthday"), readable by whoever operates the relay, in a product
whose pitch is that the relay can read nothing.

001's comment said this question was coupled to how an owner retains K_album
and could not be decided alone. That coupling is GONE: brief §11 closed the
owner-key question on 20 August 2026 in the direction that dissolves it — an
owner who unwraps K_master at login can decrypt their own titles. The question
is still open, but no longer blocked. Note that deferring is not free: the relay
cannot re-encrypt what it cannot read, so shipping plaintext means a client-side
lazy migration later.

Bounded to 200 characters by the route schema, not by this column.$$;

COMMENT ON COLUMN "recipients"."label" IS
$$Stored as PLAINTEXT on the relay — the same recorded limitation as
albums.title, and the same correction: 001's comment said the two were coupled to
the owner-key question, and that coupling is gone (brief §11, 20 August 2026).
Encryption spec §10 records that a label is a family member's name ("María")
sitting readable in the database. A deliberate current choice under the
accident-not-adversary threat model (brief §2); still open, no longer blocked
(schema §5).$$;

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

NOT NULL since 002. 001 said "nullable because it does not exist until ingest
completes"; that was never how the API works. The envelope is posted at
POST /v1/albums/{album_id}/media, before any object exists, because dimensions
and the rest are known from the decoded original before encryption begins
(api-sketch §9.6). No media row ever exists without its envelope, and the
nullability admitted a state no route produces (brief §6 #8, corrected
14 September 2026).$$;

COMMENT ON CONSTRAINT "CK_recipients_passphrase_columns" ON "recipients" IS
$$All six passphrase columns are present together or absent together —
`wrapped`, `wrap_nonce`, `kdf_salt` and the three Argon2id parameters, which are
the four conceptual items of encryption spec §6.2. `wrap_nonce` is the one that
gets forgotten, and without it the wrapped blob is undecryptable (brief §9).
Parameters live per row rather than hardcoded so they can be raised later
without invalidating existing invitations (encryption spec §6.2).

For QR recipients the six are NULL: K_album travels inside the invite payload and
the relay never holds it in any form (encryption spec §6.1), so for THOSE
recipients a full database theft yields ciphertext and nothing that helps
decrypt it.

001's version of this comment stated that property for the table as a whole.
That overclaimed. For a passphrase recipient the wrapped key sits in this row and
is offline-attackable by design — which is exactly why passphrases MUST be
system-generated at ≥ 64 bits (encryption spec §6.3). The two modes are stronger
against different things — direct mode against a stolen database, passphrase
mode against a forwarded or captured invite — and neither dominates (encryption
spec §6.5). Do not describe either as simply stronger.$$;

COMMENT ON CONSTRAINT "CHK_recipients_kdf_wrap_kind" ON "recipients" IS
$$Exact lengths encryption spec §6.2 fixes for version 1 — 16-byte salt,
24-byte nonce, 48-byte wrapping — and FLOORS on the Argon2id parameters:
16384 KiB, t = 2, p = 1.

Re-created by 002. 001 shipped `>= 65536` and `>= 3`, the v1 CHOSEN values,
where floors belong. That looks like weakening a constraint and is not: a client
may post higher parameters, which is the entire reason they are stored per row,
and a constraint pinned to today's chosen values rejects every invite created
after the defaults are raised. The same floors apply to owner_keys; see
CHK_owner_keys_kdf_for_password for the full argument.

The 48 is coupled to version 1 of the wrap format. If §6.2 ever changes, this
constraint must change with it — which is a feature: it forces the format change
to be deliberate rather than silent.$$;

COMMIT;

# Vitrina — Encryption Envelope Specification

**Version:** 1 (envelope format version `0x01`)
**Status:** Draft for review · last updated 11 August 2026 · §2, §7, §8 and §10 revised during C.1 and B.5
**Companion to:** `vitrina-project-brief.md` §6–§8

---

## 0. How to read this document

This specification is normative and self-contained. An implementer should be able to produce a conforming implementation in Rust, TypeScript, Swift, or Kotlin from this document alone, without reading any existing Vitrina source code. If you find yourself needing to consult the reference implementation to resolve an ambiguity, **that is a bug in this document** — fix the document.

MUST, MUST NOT, SHOULD, and MAY carry their usual RFC 2119 meanings.

**This format is effectively permanent.** The relay server cannot decrypt, therefore the relay server cannot migrate its own stored data. A format change means either lazy client-side re-encryption on next access (complex, and only reaches assets someone actually opens) or asking every user to re-upload everything. Treat changes here with more care than any other part of the system.

---

## 1. Primitives

| Purpose                        | Algorithm          | Notes                                                       |
| ------------------------------ | ------------------ | ----------------------------------------------------------- |
| Authenticated encryption       | XChaCha20-Poly1305 | 24-byte nonce, 16-byte tag                                  |
| Key derivation from keys       | BLAKE2b-256, keyed | libsodium `crypto_generichash` with a key                   |
| Key derivation from passphrase | Argon2id           | Parameters in §6                                            |
| Randomness                     | CSPRNG             | `crypto.getRandomValues`, `getrandom`, `SecRandomCopyBytes` |

All integers in this format are **little-endian**.

### 1.1 Forbidden alternatives

These are not stylistic preferences. Each one breaks something specific.

- **`crypto_secretstream_xchacha20poly1305` MUST NOT be used.** It is the obvious libsodium choice for chunked data and it requires sequential decryption from the start of the stream. That makes video seeking impossible and defeats the entire purpose of §3.
- **ChaCha20-Poly1305 (IETF, 12-byte nonce) MUST NOT be used.** The nonce derivation in §4 relies on a 24-byte nonce. With a 12-byte nonce, splitting it into a random prefix and a counter leaves too little entropy in the prefix, and nonce collision across assets becomes a realistic risk. Nonce reuse in a stream cipher is catastrophic, not degraded.
- **AES-GCM SHOULD NOT be used.** Its performance depends on hardware acceleration that is unevenly available across the browsers and phones in our target audience, and its nonce is 96 bits.
- **Compression MUST NOT be applied before encryption.** It leaks information through ciphertext length, and JPEG and H.264 payloads do not compress meaningfully anyway.

---

## 2. Key hierarchy

```
K_master (32 bytes, random, one per owner)          ← §6.6
    │
    └── wraps K_album, one wrapping per album
            │
K_album  (32 bytes, random, one per album)
    │
    ├── K_asset(id) = BLAKE2b-256(key = K_album, msg = "vitrina-asset-v1" ‖ asset_id)
    ├── K_thumb(id) = BLAKE2b-256(key = K_album, msg = "vitrina-thumb-v1" ‖ asset_id)
    └── K_meta(id)  = BLAKE2b-256(key = K_album, msg = "vitrina-meta-v1"  ‖ asset_id)
```

`asset_id` is a **UUIDv4**, generated client-side from a CSPRNG, and appears in the envelope header as its 16 raw bytes. Six of those bits are fixed by the UUID version and variant fields, so it carries 122 bits of entropy rather than 128. Collision remains negligible at any scale this system will reach, so a relay MAY use it as a global identifier and as an object key — but that is a property of how it is generated, not a constraint a client can verify.

**`base_nonce` is not a UUID and MUST NOT be made one for consistency.** It is 16 fully random bytes. The nonce-collision argument in §4.1 depends on all 128 bits, and spending six of them on version and variant markers would weaken it for no benefit — a nonce is not an identifier.

The domain-separation strings are ASCII, without a null terminator, and are part of the format. Changing one is a breaking change.

**`K_album` is wrapped by `K_master`, never derived from it.** A derived key cannot be re-wrapped, which would make password change, recovery keys and rotation permanently impossible (brief §11). Wrapping costs 32 bytes per album. Note that this is a **key-management** relationship, not a format one: the envelope has no idea where `K_album` came from, so §3 through §5 are untouched by it.

### 2.1 Why derive per-asset keys at all

`K_album` could encrypt everything directly. Deriving per-asset keys costs one hash and buys three things: a nonce-reuse mistake is confined to a single asset rather than an entire album; the full image, its thumbnail, and its metadata are cryptographically separated, so a future feature could grant access to thumbnails alone; and each asset gets a fresh keyspace, which makes the nonce argument in §4.1 simpler to reason about.

### 2.2 What the server never sees

`K_album` and every derived key MUST NEVER be transmitted to the relay, in any form, by any path. This includes error reports, crash dumps, telemetry, analytics, and log lines. Implementations SHOULD make key material a type that does not implement debug-printing (in Rust, a newtype without `Debug`; in TypeScript, avoid placing keys on objects that get serialized).

---

## 3. Envelope layout

Every encrypted object — a photo, a thumbnail, a metadata blob, and in Phase 3 a video — uses this identical layout. There is one format, not a family of formats.

```
┌──────────────────────────────────────┐
│  Header (64 bytes, plaintext)        │
├──────────────────────────────────────┤
│  Chunk 0   (chunk_size + 16 bytes)   │
│  Chunk 1   (chunk_size + 16 bytes)   │
│  ...                                 │
│  Chunk n-1 (remainder  + 16 bytes)   │
└──────────────────────────────────────┘
```

### 3.1 Header

| Offset | Size | Field              | Value                                |
| ------ | ---- | ------------------ | ------------------------------------ |
| 0      | 4    | `magic`            | ASCII `VTRN` (`0x56 0x54 0x52 0x4E`) |
| 4      | 1    | `version`          | `0x01`                               |
| 5      | 1    | `cipher`           | `0x01` = XChaCha20-Poly1305          |
| 6      | 2    | `reserved`         | MUST be `0x0000`                     |
| 8      | 16   | `base_nonce`       | Random, per asset                    |
| 24     | 4    | `chunk_size`       | u32, plaintext bytes per chunk       |
| 28     | 8    | `plaintext_length` | u64, total plaintext bytes           |
| 36     | 16   | `asset_id`         | The asset's 16-byte identifier       |
| 52     | 12   | `padding`          | MUST be zero                         |

Total: 64 bytes.

The header is **plaintext but authenticated** — it appears in full in the AAD of every chunk (§5), so any modification to it invalidates every chunk in the asset.

`chunk_size` is in the header rather than fixed by the version so that a future asset can use a different chunk size without a format version bump. Version 1 writers MUST write `262144` (256 KiB).

### 3.2 Derived quantities

```
ciphertext_chunk_size = chunk_size + 16
chunk_count           = ceil(plaintext_length / chunk_size)
last_chunk_plaintext  = plaintext_length - (chunk_count - 1) × chunk_size
total_object_size     = 64 + (chunk_count - 1) × ciphertext_chunk_size
                           + last_chunk_plaintext + 16
```

`plaintext_length` of 0 is invalid; `chunk_count` MUST be at least 1.

### 3.3 Random access — the reason for this design

Because the header is a fixed size and every chunk except the last is a fixed size, the byte range of chunk _i_ is arithmetic:

```
start(i) = 64 + i × ciphertext_chunk_size
end(i)   = start(i) + (i == chunk_count-1
                       ? last_chunk_plaintext + 16
                       : ciphertext_chunk_size) - 1
```

This is what makes an HTTP `Range` request sufficient to fetch and independently decrypt any chunk of an asset stored as a **single** object. It is why video seeking in Phase 3 requires no format change, and why storage is one object per asset rather than one per chunk.

An implementation MUST be able to decrypt chunk _i_ given only `K_asset`, the 64-byte header, and the bytes of chunk _i_. If your implementation cannot do that, it is not conforming, and video will not work later.

---

## 4. Nonce derivation

```
nonce(i) = base_nonce (16 bytes) ‖ u64_le(i)
```

Producing the 24 bytes XChaCha20-Poly1305 requires.

### 4.1 Why this is safe

Nonce reuse under a fixed key is catastrophic for a stream cipher, so this argument matters more than most.

Within one asset, `i` is a monotonic counter and never repeats. Across assets, each asset has both a distinct `K_asset` (derived from a distinct `asset_id`, §2) _and_ an independently random 128-bit `base_nonce`. Reuse would require both a key collision and a nonce collision. With 128 bits of `base_nonce` entropy, the birthday bound sits above 2^64 assets.

**`base_nonce` MUST be freshly generated from a CSPRNG for every asset.** It MUST NOT be derived from the file contents, a hash, a timestamp, a counter, or the `asset_id`. Deriving it deterministically means re-encrypting the same photo produces the same nonce under the same key, which is exactly the failure this section exists to prevent.

---

## 5. Additional authenticated data

```
AAD(i) = header (all 64 bytes) ‖ u64_le(i)
```

That is the entire definition. It is deliberately simple, and it defends against four distinct attacks at once:

| Attack                                             | Blocked by                       |
| -------------------------------------------------- | -------------------------------- |
| Reordering chunks                                  | `i` in the AAD                   |
| Truncating the asset                               | `plaintext_length` in the header |
| Splicing chunks between assets under one album key | `asset_id` in the header         |
| Downgrading to an older format version             | `version` in the header          |

A tempting simplification is to authenticate only the chunk index. It blocks the first attack and none of the others, and the resulting vulnerabilities are silent — decryption succeeds and returns wrong data. Authenticate the whole header.

---

## 6. Key wrapping

There are two ways a recipient obtains `K_album`. The QR path is the default, but the two modes are **not ordered on a single axis** — see §6.5 before describing either as simply stronger.

### 6.1 QR / link recipients (default)

`K_album` travels inside the invite payload (see `vitrina-invite-spec.md`). **No wrapped key is stored server-side in any form.** The server holds only a recipient row — a label, a hashed access token, and `revoked_at`.

If the server database is stolen in its entirety, the attacker has ciphertext and nothing that helps decrypt it. This is the property worth protecting.

**Any future feature that causes a wrapped `K_album` to be stored for a direct-mode album voids this property for that album**, and MUST be treated as a change to the album's security posture rather than as a convenience. The specific candidate is a recipient "saving" a shared album into their own account (brief §11): wrapping `K_album` under a key derived from that recipient's account password reintroduces the offline attack §6.3 exists to manage, against a human-chosen secret that §6.3 forbids for exactly this reason. The owner chose direct mode; a recipient must not be able to undo that choice silently.

### 6.2 Passphrase recipients

For when a QR cannot be delivered — read aloud over the phone, written on a card.

```
KEK     = Argon2id(passphrase, salt, params) → 32 bytes
wrapped = XChaCha20-Poly1305(
              key   = KEK,
              nonce = wrap_nonce (24 random bytes),
              msg   = K_album,
              aad   = "vitrina-wrap-v1" ‖ recipient_id)
```

**The AAD's byte form is normative.** `"vitrina-wrap-v1"` is the 15 ASCII bytes, with no null terminator and no length prefix. `recipient_id` is the **16 raw UUID bytes**, never its 36-character text form and never any other encoding. The AAD is therefore exactly 31 bytes. This is the same convention §2 uses for `asset_id` in the envelope header, and it is stated here because §2's rule is written about §2's own domain-separation strings and does not reach this one. A disagreement between two implementations here is an opaque AEAD failure at unwrap time with no diagnostic — see §9.1.

The server stores `salt`, the Argon2id parameters, `wrap_nonce`, and `wrapped`. It never sees the passphrase or `KEK`.

**Exact lengths for version 1.** Every one of these is fixed, and a reader or a database MAY enforce them:

| Value        | Bytes | Why                                                                    |
| ------------ | ----- | ---------------------------------------------------------------------- |
| `salt`       | 16    | libsodium's `crypto_pwhash` requires exactly `crypto_pwhash_SALTBYTES` |
| `wrap_nonce` | 24    | XChaCha20-Poly1305 nonce                                               |
| `KEK`        | 32    | Argon2id output length                                                 |
| `wrapped`    | 48    | `K_album` (32) plus the Poly1305 tag (16)                              |

The salt length deserves particular attention, because it is the one that **will not fail in Rust**. RustCrypto's `argon2` accepts salts from 8 to 64 bytes, so a 32-byte salt passes every test in `crates/envelope` and is then rejected by libsodium in the browser. Confirm the constant against libsodium directly during C.8 rather than trusting this table.

**Argon2id parameters for version 1:** memory 64 MiB, iterations 3, parallelism 1.

Parameters are stored per recipient, not hardcoded, so they can be raised later without invalidating existing invitations. 64 MiB is a floor chosen for mobile browsers running libsodium under WASM — libsodium's `MODERATE` preset (256 MiB) risks failing on the low-end Android devices in our audience. **Verify on real target devices before shipping**, not in a desktop browser.

### 6.3 Passphrases MUST be system-generated

Because the server stores `wrapped`, anyone with database access can mount an offline attack against the passphrase at their leisure. A user-chosen passphrase loses that attack.

- Generate from a wordlist of at least 7,776 words
- Minimum 5 words → ≥ 64 bits of entropy
- The user MUST NOT be permitted to supply their own
- Words MUST come from a wordlist in the **recipient's** language, selected per invite by the owner (brief §15.2) — a grandparent reading a passphrase aloud over the phone transcribes their own language reliably and a foreign one badly. This is a correctness concern, not a localisation nicety.

**Wordlist construction is constrained beyond word count.** A list MUST contain no homophones and no pairs of words differing only by a diacritic, because the normalisation below collapses both. EFF's English long list has these properties by construction; a scraped frequency list does not. A language without a list meeting this bar MUST NOT be offered for passphrases, even if the UI is translated into it.

**Normalisation is normative and identical on both sides.** The generator and the entry path MUST apply the same transformation before the string reaches Argon2id:

1. Unicode NFKD
2. Remove all combining marks
3. Lowercase
4. Collapse runs of whitespace to a single `U+0020`, and trim

So `Café  Roble` and `cafe roble` derive the same KEK. **A mismatch here is not a usability bug — it is an unwrappable blob**, discovered as an opaque AEAD failure with no diagnostic. This belongs in the C.8 test vectors: at least one vector whose passphrase contains diacritics, mixed case and irregular spacing, asserting it unwraps identically to its normalised form.

### 6.4 The access token is a separate secret from the key

This distinction is easy to blur and it is what makes revocation work.

- `K_album` lets a recipient **decrypt**. The server never has it and can never withdraw it.
- The **access token** lets a recipient **fetch ciphertext**. The server stores its hash and can invalidate it instantly.

They travel together in one invite payload but are independent secrets serving different parties. Revocation invalidates the token. That prevents all future access to ciphertext, which is real and useful — and it is enforced by the server's behaviour, not by mathematics.

**The UI MUST NOT imply that revocation prevents decryption of anything already retrieved.** True cryptographic revocation requires re-encrypting the album under a new `K_album` and redistributing it to the remaining recipients. That may be worth building later; it is not what the revoke button does today.

---

### 6.5 The two modes are stronger against different things

Earlier drafts of this document called the QR path "strictly stronger." That is wrong, and the correction matters because it changes which mode you would reach for against which risk.

**Direct mode is stronger against a stolen database.** No wrapped key exists server-side, so a full database compromise yields ciphertext and nothing that helps decrypt it (§6.1). Passphrase mode stores `wrapped`, which is offline-attackable given a weak passphrase — hence §6.3.

**Passphrase mode is stronger against a forwarded or captured invite**, for two reasons, and the first needs nothing built.

**The link alone is insufficient.** `key` is absent from the payload (invite spec §4), so someone who forwards, photographs or steals the link holds ciphertext they cannot decrypt — the passphrase travelled by a separate channel. Direct mode hands over everything in one artifact: whoever photographs the QR has both secrets, permanently, and no server behaviour retracts the key half.

**And the relay participates in every unwrap**, because the client must fetch the wrapped blob to derive `K_album`. That gives the relay a lever it does not have in direct mode — it could count unwraps, rate-limit them, bind them to a device, or refuse after the first. None of that is in v1; the point is that the mode leaves it possible.

Neither mode dominates. Direct mode remains the default because database theft is the threat this architecture exists to defeat, and because delivery by QR is what makes the product usable by a grandparent with no account. But if invite sharing ever becomes the concern that matters most, the mode that keeps the server in the loop is the one with a lever to pull.

### 6.6 Owner key wrapping

**Not yet fully specified. The shape is decided (brief §11, 20 August 2026); the exact derivation is not, and MUST be settled with conformance vectors per §9.1 before Phase 1.**

An owner holds `K_master`, 32 random bytes, generated client-side at signup. Every `K_album` they own is wrapped under it and stored server-side. `K_master` itself is wrapped once per credential and stored in `owner_keys` — one row for the password today, one for a recovery key in Phase 2, potentially one per device later.

**Two constraints, and only the first is about database theft.**

**The password MUST NEVER leave the device.** The client derives the login proof locally and sends only that. This is not a hardening preference — the KEK is derived from the password, so a relay that receives the password can compute the KEK itself, which would make it _able_ to unwrap while merely choosing not to. §2.2 forbids transmitting derived keys; transmitting the input they are derived from is the same thing by another route.

**The login proof and the KEK MUST be independently derived.** If the value the relay stores to verify a login is also the value that unwraps `K_master`, a stolen database yields both the wrapped blob and its unwrapping key, and the password protects nothing.

The two are separate defences against separate adversaries — the first against a compromised or coerced relay, the second against a database thief. Satisfying one does not satisfy the other.

**A consequence that shapes the login route: it is two round trips.** Deriving the proof client-side requires the salt and Argon2id parameters before anything can be computed, so the client fetches them first. **Decided 20 August 2026.**

The alternative — deriving the salt from the email to save a round trip — was rejected for two reasons.

**It is incompatible with per-row KDF parameters.** Parameters live on `owner_keys` precisely so they can be raised without invalidating existing accounts, and the schema calls that load-bearing. The client needs them before deriving, so it must fetch them regardless; deriving the salt removes one lookup from a call that still has to happen. The only way to reach a single round trip is to make parameters a global constant, which forfeits the property. The two designs are not a symmetric trade — one silently reopens a decision made elsewhere.

**And its failure mode is §9.1's class at the worst severity in this system.** "A hash of the normalised address" hides a specification: Unicode in the local part, IDN in the domain, and case-folding rules that differ between languages. That rule would have to agree byte-for-byte across Rust, TypeScript, Swift and Kotlin, permanently. Disagreement yields a different salt, a different KEK, and a `K_master` that will not unwrap — an account nobody can open, retroactively, for every wrapping already made. Every other row in §9.1's table costs an invite, which a parent can reissue. This one costs an entire album collection.

**Clients MUST send the address exactly as typed and MUST NOT normalise it at all** — not trimming, not `toLowerCase()`, nothing. Any client-side transformation reintroduces the agreement problem in a weaker form: a client that lowercases differently from the relay produces a lookup miss rather than an unopenable account. Recoverable, and there is no reason to have it.

**The asymmetry that settles it is where the complexity lives.** Normalisation is still required under the chosen design — the relay must normalise before looking up an email and before computing a decoy — but it happens **entirely server-side and crosses no client boundary.** If the relay's normalisation is wrong it holds the addresses in plaintext and can migrate. Four disagreeing clients cannot be repaired. Same operation, opposite recoverability.

The predictable-salt objection is real and minor: per-email uniqueness still defeats cross-account amortisation, and what is lost is the requirement that an attacker steal the database before beginning work on a known target.

### 6.6.1 The parameter-fetch route

A distinct route, not a phase flag inside login, so the property below has somewhere to be asserted:

- **Always answers `200`.** An unknown address returns decoy values indistinguishable from real ones.
- **Decoys are deterministic per address** — `HMAC(server_secret, normalised_email)` truncated to 16 bytes — so repeated attempts return the same salt. A varying salt is itself an oracle.
- **Decoy parameters equal the real ones.** Free in v1, where every row carries the same values, so a decoy has nothing to distinguish itself from. **The property degrades the moment parameters differ between accounts**, which is the cost of the per-row storage that made them changeable. Worth writing down before that happens rather than discovering it.
- **The lookup runs unconditionally** and the substitution happens on miss. Branching before the query is a timing oracle.
- **Rate-limited on the same IP basis as login.** An oracle that cannot be distinguished but can be queried without limit is still a harvesting surface.
- **The server secret is effectively permanent, and belongs in the same operational category as the database.** Rotating it moves every decoy salt while real salts, being stored, stay put — so anyone comparing responses across the rotation learns which addresses exist. It must be backed up alongside Postgres.
- **Absent at boot MUST be a hard error.** The ordinary implementation — read from the environment, generate a random one if missing — silently destroys the property on every restart, and nothing fails while it happens. See brief §6 non-negotiable #17.

**The indistinguishability requirement now spans two routes, and is one rule, not two:** no credential route may reveal whether an account exists — not by status, not by code, not by response shape, and not by timing.

**Signup is outside that rule, and cannot be brought inside it in v1.** Registration must reject a duplicate address, and with no email sending there is no way to respond identically and deliver the difference out of band. The property is therefore _credential-route indistinguishability_, not account-existence secrecy. Recorded as a limitation in §10 rather than assumed away.

**Server-side parameters are a separate choice from §6.2's.** §6.2's Argon2id figures were sized for a mobile WASM heap on a low-end Android phone. An owner password is verified by a server under concurrency, where the same figure becomes a per-request allocation an unauthenticated caller can trigger — see the api-sketch's rate-limit reasoning, which is deliberately written to hold whatever the number turns out to be. Choose it for the server; do not inherit it.

**Recovery is out of v1**, and the consequence is not softenable: forgetting the password loses every album. The relay cannot re-wrap what it cannot read. This is why the `owner_keys` table exists as a table rather than a column — Phase 2 adds recovery by inserting a row, with no migration and no re-encryption.

### 6.6.2 Account creation

`K_master` is generated **client-side** at signup, 32 random bytes from a CSPRNG. The client derives the KEK from the password, wraps `K_master`, and posts the wrapping. The relay receives:

- the address as typed, unnormalised (§6.6)
- the login proof — **never the password**
- the KDF salt and parameters, which become the `owner_keys` row
- `wrapped_master` and `wrap_nonce`

**This is the second route that accepts wrap material**, alongside recipient creation. The distinction the route-table audit must encode: **a wrapped blob is ciphertext and may be posted; the key that wrapped it and the secret that derived that key may never be.** Both routes carry the first and neither may carry the second. This one wraps the key every album in the account hangs off, which makes it the highest-consequence body in the system.

The account and its first `owner_keys` row are created in one transaction. An owner with no wrapping is an account that can authenticate and decrypt nothing.

**Signup reveals whether an address is already registered**, and cannot be made not to in v1 — see §10.

## 7. Metadata

Filenames, capture timestamps, dimensions, and (Phase 3) duration are serialized as JSON and encrypted under `K_meta(asset_id)` using this same envelope format. There is no separate format for metadata.

**Storage location: a binary column on the `media` row, not an object in the bucket.** A metadata envelope is a few hundred bytes, is never range-requested, and is always fetched together with its album rather than individually. Clients SHOULD fetch all metadata for an album in a single request — and that requirement is only cheap if a single query returns all of them. Held as objects instead, opening a hundred-photo album would mean a hundred storage fetches proxied through the API on every load.

_This is a judgement call with a real cost, recorded so it is not mistaken for an oversight: it means the object bucket alone is not a complete backup. Losing the database loses filenames and capture dates even though every photograph survives. The database was never disposable — it also holds album membership, recipients, and the access log — so this changes the recovery story less than it first appears. Asset and thumbnail ciphertext still goes to object storage, one object per asset._

The relay learns nothing about filenames or image dimensions either way. The cost that remains is that a client must fetch and decrypt metadata before it can lay out a grid, since it does not know aspect ratios in advance.

**Plaintext filenames MUST NEVER reach the server**, including as object keys. Object keys are random identifiers. `IMG_20260612_bathtime.jpg` describes a child's routine to anyone who reads a bucket listing.

**All EXIF and embedded metadata MUST be stripped before encryption**, not merely omitted from the metadata JSON. Stripping happens client-side, before the bytes are encrypted, and applies to GPS coordinates, camera serial numbers, and timestamps. GPS in a photograph of a child identifies their home and their school. This failure is invisible when it happens.

---

## 8. Reader validation and version negotiation

A reader MUST refuse to decrypt and surface a clear error if any of the following holds:

| Condition                                                                        | Reason                                                     |
| -------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| Input shorter than 64 bytes                                                      | No complete header                                         |
| `magic` ≠ `VTRN`                                                                 | Not a Vitrina envelope                                     |
| `version` is not one the reader implements                                       | Unknown format                                             |
| `cipher` is not one the reader implements — version 1 readers accept only `0x01` | Unknown algorithm                                          |
| `reserved` ≠ `0x0000`                                                            | Reserved space in use by a format the reader does not know |
| `padding` is not all zero                                                        | As above                                                   |
| `plaintext_length` = 0                                                           | §3.2 — a zero-length asset is invalid                      |
| `chunk_size` = 0                                                                 | Would make `chunk_count` undefined                         |

In no case may a reader attempt best-effort parsing or partial recovery.

**`cipher` is documentation, not agility.** Version 1 defines exactly one cipher. The byte exists so that a reader meeting a future object fails with "unsupported cipher" rather than an opaque authentication failure. Introducing a second cipher value breaks every existing reader and MUST be treated with the same care as a version increment — it is not a way to avoid one.

- Writers always write the current version. There is no downgrade path.
- Adding, removing, or reinterpreting any header field requires a version increment.
- Adding a permitted value to `version` or `cipher` is likewise a breaking change.

---

## 9. Conformance and test vectors

The reference Rust implementation MUST ship known-answer test vectors as JSON in `spec/vectors/`, and every other implementation MUST pass them unchanged. This is the mechanism — the only mechanism — that keeps the browser, iOS, and Android implementations from silently diverging.

**`spec/vectors/` is not scoped to the envelope format.** It carries two classes: envelope conformance (the ten categories below) and the protocol-level byte agreements in §9.1. Both belong in one file because the mechanism is what matters, not which document defines the value — and a second vectors directory for the same purpose is precisely the duplication this project keeps engineering against. CI MUST run every vector against every implementation, not only against the Rust crate.

Each vector supplies hex-encoded `K_album`, `asset_id`, `base_nonce`, `chunk_size`, and plaintext, and the expected full envelope bytes.

Required coverage:

1. Single chunk, plaintext shorter than `chunk_size`
2. Plaintext exactly equal to `chunk_size`
3. Plaintext exactly `chunk_size + 1` (two chunks, second is 1 byte)
4. Multiple full chunks plus a partial final chunk
5. Key derivation: `K_album` + `asset_id` → each of `K_asset`, `K_thumb`, `K_meta`
6. Argon2id wrap and unwrap round trip with fixed salt and parameters
7. **Negative:** tampered ciphertext byte → decryption fails
8. **Negative:** chunks 0 and 1 swapped → decryption fails
9. **Negative:** final chunk removed and `plaintext_length` adjusted → decryption fails
10. **Negative:** `version` byte altered → rejected

The negative cases matter as much as the positive ones. An implementation that accepts reordered chunks will pass every positive test and be broken.

Implementations SHOULD additionally carry a property test asserting round-trip identity for random plaintext lengths from 1 byte to several times `chunk_size`, and SHOULD cross-check §1 primitive outputs against libsodium directly.

### 9.1 The rule this section generalises

**Any value that two implementations must compute identically needs a known-answer vector, not a prose description.**

**Corollary, and it can change a design rather than just test one: prefer the option whose byte-level agreement stays on one side of a client boundary.** A rule the relay applies alone is recoverable — it holds the inputs and can migrate. A rule four clients must apply identically, forever, is not. §6.6's rejection of email-derived salts turns on exactly this, and the same question is worth asking of any future construction before reaching for a vector to police it. Prose says what should happen; a vector says whether it did. Where the two disagree the failure is usually total and silent — an authentication tag that will not verify, a blob that will not unwrap, an invite that never works — with no diagnostic pointing at the cause.

Four instances have already been found by review rather than by test, which is why this is now a rule rather than an observation:

| Value                                           | How it fails                                                                                                        |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Argon2id salt length                            | RustCrypto accepts 8–64 bytes, libsodium requires exactly 16 — passes every Rust test, rejected in the browser      |
| Passphrase normalisation (§6.3)                 | Generator and entry path must transform identically; a mismatch is an unwrappable blob                              |
| `cipher` byte rejection (§8)                    | Reader behaviour on an unknown value was undefined                                                                  |
| Token hashing (`vitrina-schema.md` §6)          | SHA-256 over raw bytes versus over the base64url string; every invite fails identically                             |
| base64url canonicality (`vitrina-schema.md` §6) | Four 43-character strings decode to the same 32 bytes; "43 chars decoding to 32 bytes" does not pin a unique string |
| Wrap AAD composition (§6.2)                     | `recipient_id` as 16 raw bytes versus 36-character text; opaque AEAD failure at unwrap                              |

Only two of these are envelope concerns. The rest are protocol-adjacent and belong in `spec/vectors/` regardless, per the scope note above.

**Required protocol vectors**, in addition to §9's ten envelope categories:

1. A token in both forms — 32 raw bytes and its canonical 43-character base64url — with the expected SHA-256 of the raw bytes
2. A non-canonical 43-character spelling of that same token, asserted to be **rejected** rather than accepted
3. A passphrase containing diacritics, mixed case and irregular whitespace, with its normalised form and the expected KEK under a fixed salt and parameters
4. A `recipient_id` with the expected 31-byte AAD, hex-encoded
5. An Argon2id wrap using a 16-byte salt, asserted to succeed, and one using a 32-byte salt, asserted to be rejected before it reaches the KDF

---

## 10. Accepted limitations

Recorded honestly so they are not mistaken for oversights.

**Ciphertext length reveals approximate plaintext length.** Since all images are downscaled to a 1600 px long edge before encryption, the variance is modest, but an observer with the object sizes can distinguish a photograph from a thumbnail and make coarse guesses about content complexity. Padding to size buckets would mitigate it and is not specified in version 1.

**Access patterns are visible to the relay.** The server sees which recipient fetched which object and when. This powers the "María viewed this" feature, so it is partly intentional — but it means the relay learns viewing behaviour even though it cannot see content.

**The number of assets in an album is visible**, as is upload timing.

**Account existence is discoverable through signup.** The credential routes are indistinguishable by design (§6.6.1), but registration must reject a duplicate address and v1 has no email sending, so there is no way to answer identically and deliver the difference out of band. What is protected is that an attacker cannot learn which addresses exist _by attacking the login path_; they can still learn it by attempting to register one.

**An invite can be forwarded, and nothing in v1 prevents or detects it.** A recipient who passes their QR or passphrase to someone else grants that person the same access, and the relay cannot distinguish them. Revocation removes both at once or neither. Options and their trade-offs are in `vitrina-invite-spec.md` §8; none is in v1.

**Album titles and recipient labels are stored in plaintext.** §6.1 says the relay holds "a label" for each recipient, and albums carry a title the owner can read back without holding a key. This is intended, and it is also the sharpest inconsistency in the product: _"Sofía's first birthday"_ and _"María"_ are a child's name and a family member's name sitting readable in a database whose entire pitch is that it cannot read anything.

It is a defensible trade under the accident-not-adversary threat model — the names alone are not the harm the product exists to prevent, and encrypting them costs real usability.

**The dependency that parked this is gone as of 20 August 2026.** It was not simply fixed because encrypting a title means the owner cannot see their own album list without holding the album key — and how an owner retains keys was unresolved. Brief §11 now answers it: `K_master` is unwrapped at login and every `K_album` hangs off it, so an owner can decrypt their own titles. **This is now open on its own merits rather than blocked.**

Two things bear on deciding it. **Encrypting later is a client-side lazy migration**, because the relay cannot re-encrypt what it cannot read — so plaintext titles would persist in two states indefinitely, with clients migrating on access. That is §7's problem in miniature and makes "ship plaintext, fix in Phase 2" more expensive than it sounds. And the natural split is **`albums.title` under `K_album`**, so a recipient can see what they are looking at, and **`recipients.label` under `K_master`**, since it is owner-only.

**Client-side watermarking is bypassable** by editing the JavaScript. See brief §5 for why this is the correct trade and why it must not be "fixed" by moving watermarking server-side.

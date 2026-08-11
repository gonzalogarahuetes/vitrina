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
K_album  (32 bytes, random, one per album)
    │
    ├── K_asset(id) = BLAKE2b-256(key = K_album, msg = "vitrina-asset-v1" ‖ asset_id)
    ├── K_thumb(id) = BLAKE2b-256(key = K_album, msg = "vitrina-thumb-v1" ‖ asset_id)
    └── K_meta(id)  = BLAKE2b-256(key = K_album, msg = "vitrina-meta-v1"  ‖ asset_id)
```

`asset_id` is 16 random bytes from a CSPRNG, generated client-side. It MUST be unique within an album. Because it is 128 random bits, collision across albums is negligible at any scale this system will reach, so a relay MAY use it as a global identifier and as an object key — but note that this is a property of how it is generated, not a constraint a client can verify.

The domain-separation strings are ASCII, without a null terminator, and are part of the format. Changing one is a breaking change.

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

## 6. Recipient key wrapping

There are two ways a recipient obtains `K_album`. The QR path is the default because it is strictly stronger.

### 6.1 QR / link recipients (default)

`K_album` travels inside the invite payload (see `vitrina-invite-spec.md`). **No wrapped key is stored server-side in any form.** The server holds only a recipient row — a label, a hashed access token, and `revoked_at`.

If the server database is stolen in its entirety, the attacker has ciphertext and nothing that helps decrypt it. This is the property worth protecting.

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

The server stores `salt`, the Argon2id parameters, `wrap_nonce`, and `wrapped`. It never sees the passphrase or `KEK`.

**Argon2id parameters for version 1:** memory 64 MiB, iterations 3, parallelism 1.

Parameters are stored per recipient, not hardcoded, so they can be raised later without invalidating existing invitations. 64 MiB is a floor chosen for mobile browsers running libsodium under WASM — libsodium's `MODERATE` preset (256 MiB) risks failing on the low-end Android devices in our audience. **Verify on real target devices before shipping**, not in a desktop browser.

### 6.3 Passphrases MUST be system-generated

Because the server stores `wrapped`, anyone with database access can mount an offline attack against the passphrase at their leisure. A user-chosen passphrase loses that attack.

- Generate from a wordlist of at least 7,776 words
- Minimum 5 words → ≥ 64 bits of entropy
- The user MUST NOT be permitted to supply their own
- Words SHOULD come from a Spanish or Catalan wordlist for this audience — a grandparent reading a passphrase aloud over the phone will transcribe words in their own language far more reliably than English ones. This is a correctness concern, not a localisation nicety.

### 6.4 The access token is a separate secret from the key

This distinction is easy to blur and it is what makes revocation work.

- `K_album` lets a recipient **decrypt**. The server never has it and can never withdraw it.
- The **access token** lets a recipient **fetch ciphertext**. The server stores its hash and can invalidate it instantly.

They travel together in one invite payload but are independent secrets serving different parties. Revocation invalidates the token. That prevents all future access to ciphertext, which is real and useful — and it is enforced by the server's behaviour, not by mathematics.

**The UI MUST NOT imply that revocation prevents decryption of anything already retrieved.** True cryptographic revocation requires re-encrypting the album under a new `K_album` and redistributing it to the remaining recipients. That may be worth building later; it is not what the revoke button does today.

---

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

---

## 10. Accepted limitations

Recorded honestly so they are not mistaken for oversights.

**Ciphertext length reveals approximate plaintext length.** Since all images are downscaled to a 1600 px long edge before encryption, the variance is modest, but an observer with the object sizes can distinguish a photograph from a thumbnail and make coarse guesses about content complexity. Padding to size buckets would mitigate it and is not specified in version 1.

**Access patterns are visible to the relay.** The server sees which recipient fetched which object and when. This powers the "María viewed this" feature, so it is partly intentional — but it means the relay learns viewing behaviour even though it cannot see content.

**The number of assets in an album is visible**, as is upload timing.

**Album titles and recipient labels are stored in plaintext.** §6.1 says the relay holds "a label" for each recipient, and albums carry a title the owner can read back without holding a key. This is intended, and it is also the sharpest inconsistency in the product: _"Sofía's first birthday"_ and _"María"_ are a child's name and a family member's name sitting readable in a database whose entire pitch is that it cannot read anything.

It is a defensible trade under the accident-not-adversary threat model — the names alone are not the harm the product exists to prevent, and encrypting them costs real usability. But the reason it is not simply fixed is worth stating: encrypting an album title means the owner cannot see their own album list without holding the album key, which requires solving how an owner retains `K_album` across sessions and devices — an unresolved question (brief §11). **The two decisions are coupled and must be made together.** Until then, treat this as a recorded limitation rather than a settled design.

**Client-side watermarking is bypassable** by editing the JavaScript. See brief §5 for why this is the correct trade and why it must not be "fixed" by moving watermarking server-side.

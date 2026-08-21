# Vitrina — Project Brief

**Status:** Draft v0.1 · last updated 11 August 2026 · §10.1 and §12 added
**Purpose of this document:** the single canonical description of what Vitrina is, what it promises, and the constraints every implementation decision must respect. Paste this into any new chat or Claude Code session before asking for work.

> `Vitrina` is a working codename, not a decision. Naming is an open item.

---

## 1. What it is

Vitrina lets a parent share photos (later, video) of their children with a small, explicitly invited audience — grandparents, aunts, close friends — in a way where **the images do not become files on other people's devices or in other companies' clouds.**

Recipients receive an invitation (QR code or passphrase), open a viewer, and see the images. They do not download them, do not accumulate them in a camera roll, and cannot forward them with one tap. The host cannot read them either.

## 2. Who it is for, and what they actually fear

The user is a parent living away from family who currently shares photos over WhatsApp or Telegram and is uneasy about it. Their unease is **not** "grandma will maliciously leak my child's photo." It is:

- The photo auto-saves to the recipient's camera roll
- Their phone syncs it to Google Photos or iCloud
- They forward it to a 40-person extended-family group
- The messaging company holds a copy indefinitely
- Years later there are images of a five-year-old in places nobody chose
- Geolocation metadata reveals where the child lives and goes to school

**Every item on that list is an accident of default behaviour, not an attack.**

This is the most important sentence in this document, because it sets the design target. Friction reliably defeats accident. Friction never defeats determination. Vitrina is built to defeat accident.

## 3. What we promise, and what we must never claim

### We promise (all of these are real and achievable)

- No image is ever written to the recipient's filesystem, camera roll, or downloads folder
- Therefore nothing enters their cloud backup
- There is no file object to forward. **The invitation is a different matter — see below**
- All location and camera metadata is stripped before anything leaves the parent's device
- The relay server stores only ciphertext it cannot decrypt
- Access is revocable
- Only people the parent explicitly invited can view

### We must never claim

- That screenshots are impossible
- That photographing the screen with another phone is impossible
- That a technically sophisticated recipient cannot extract what is displayed
- That the images are "un-copyable" or "DRM-protected"

**This is a product rule, not just an ethical one.** Overclaiming invites a betrayal-of-trust incident the first time a user discovers a screenshot, and in the EU it is a marketing claim we cannot substantiate. Onboarding copy must state the limit plainly and frame the value correctly: _nothing lands on their device, nothing syncs to a cloud, no photo forwards with a tap, and you can revoke it._

**"No photo forwards with a tap" is exact, and the earlier wording "nothing forwards with a tap" was an overclaim.** The invitation itself forwards with a tap, and possession of it is possession of the whole album until an owner revokes. That is recorded as a known problem in §11 and it constrains B.7: copy may promise that the images do not travel, and must not imply that access cannot.

## 4. Architecture: blind relay

```
Parent device                Relay server              Recipient browser
(encrypts locally)  ──────►  (ciphertext only)  ─────►  (decrypts in memory)
       │                                                        ▲
       └──────────── access key: QR or passphrase ──────────────┘
                     (never touches the relay)
```

The parent's device encrypts before upload. The relay stores and forwards opaque blobs. The key travels out of band. Because the relay only ever holds ciphertext, the choice of hosting provider is a low-stakes decision.

**Rejected alternative:** serving directly from the parent's phone. Correct instinct about trust, wrong architecture — mobile operating systems kill background networking, so the parent's device would need to be awake and online at the exact moment a grandparent in another timezone opens the link.

**Rejected alternative:** server-side rendering with per-viewer forensic watermarking. This would require a trusted host that can decrypt. It is the right design against an adversarial viewer, and the wrong one here — see §5.

## 5. Watermarking: client-side and visible

Each rendered image carries a visible overlay: recipient name and date, e.g. _"Shared privately with María · 6 Aug 2026."_

This is generated **client-side, after decryption.** That means it is bypassable by anyone who opens DevTools and edits the JavaScript. This is an accepted trade, and the reasoning must be preserved so nobody "fixes" it later:

- The watermark's purpose is **social, not forensic.** It survives a screenshot and makes the screenshot feel wrong to forward onward.
- The audience is non-adversarial. María will not open DevTools.
- Server-side watermarking would require the server to decrypt, destroying the strongest guarantee in the product.

**Never move watermarking server-side. It would trade a real guarantee for a fake one.**

## 6. Non-negotiables

These exist because they are cheap now and expensive or impossible later. Any implementation that violates one is wrong even if it works.

### Encryption format

1. **Chunked encryption for every asset, from day one.** Fixed 256 KB plaintext chunks, each independently decryptable. A photo is 2 chunks; a video is 4,000. Same format, same code path. This is the single most important item on this list — see §7 on why encrypted data cannot be migrated.
2. **A version byte at the start of every envelope**, and a written spec (§8) precise enough to reimplement in Kotlin without reading the TypeScript.
3. **Do not use `crypto_secretstream`.** It is the obvious libsodium choice and it requires sequential decryption from the beginning of the stream, which makes video seeking impossible.

### Portability across clients

4. **libsodium everywhere** — WASM in the browser, native bindings in Swift and Kotlin. Not Web Crypto: it is browser-only and lacks Argon2id.
5. **A real HTTP API boundary.** Access-control and key-wrapping logic must live in a layer the web framework merely _calls_, never inside page-rendering routes. The web app is one client of the API, not the API's owner.
6. **Token-based auth, not cookie-session auth.** The server contract assumes a stateless, untrusted client. This clause originally allowed a cookie to carry the token in the browser. That allowance is now narrowed: **the transport is `Authorization: Bearer` and cookies are not used**, because a cookie confines you to a single origin or else requires `SameSite=None`, CORS `credentials`, and CSRF protection that a bearer header does not. Since brief §11 keeps separate client and API origins available as a bundle-integrity mitigation, the bearer header is the choice that keeps both options open.
7. **A structured invite payload** — relay URL, album ID, key material as a defined serializable object. It renders into a URL fragment, a QR code, or an iOS universal link. Do not let "a link with a fragment" become the abstraction.

### Forward compatibility

8. **The domain object is `media`, not `photos`** — in the schema, API routes, and types. With a `kind` discriminator and a nullable metadata column.
9. **Asynchronous ingest with a status field:** `pending → processing → ready → failed`. For photos this resolves in 200 ms and feels like pointless machinery. It exists so that video, which takes minutes, does not require touching every UI surface that assumed "uploaded means viewable."
10. **A renderer interface**, with a single photo implementation behind it.

### Privacy hygiene

11. **Strip all EXIF and metadata client-side, before encryption.** GPS coordinates in a photo of a child reveal their home and school. This is non-optional and easy to forget because it is invisible when it fails.
12. **Filenames never leave the device in plaintext.** `IMG_20260612_bathtime.jpg` leaks. Randomise or encrypt.
13. **Thumbnails are generated client-side and encrypted** like any other asset. A plaintext thumbnail defeats the entire design.
14. **Never transmit full resolution.** Downscale to a viewing size (long edge ~1600 px) before encryption. What a recipient can capture is then a screen-quality render, not the original. This is the strongest anti-copying lever available on the web and the one most often skipped.
15. **No error response ever echoes request content.** A validation error that helpfully returns the offending value is how key material reaches a response body and then a log. This is #16 pointed outward, and it is easy to violate with a well-meaning error handler.
16. **No endpoint accepts key material in any parameter, header, or body.** Not `K_album`, not `K_master`, not a derived key, not a password or passphrase. A **wrapped blob is ciphertext and may be posted** — recipient creation and account creation both carry one (encryption spec §6.2, §6.6.2) — but the key that wrapped it, and the secret that key was derived from, may never be. Fastify's per-route JSON Schema is what makes this auditable by a test that walks the route table.
17. **A default must never leave a security property silently absent.** Where the safe behaviour cannot be made structural, absence must be a hard failure — not a fallback, not a generated substitute, not a plausible guess. Three instances so far, and in each the ordinary implementation is the one that breaks it quietly: a presigned URL that forgets `ResponseCacheControl` works perfectly with no `no-store`; an unmapped framework status falling through to a sensible-looking `400` mis-reports the failure; and a decoy secret generated when absent from the environment destroys login indistinguishability on every restart while nothing fails. The test is not "does it work without this" — it is "does it work, **wrongly**, without this".

## 7. Why the encryption format cannot be fixed later

Ordinarily a bad schema decision is repaired with a migration script. **Vitrina's server cannot decrypt, therefore Vitrina's server cannot migrate.** Changing the envelope format later means either lazy client-side re-encryption on next access — complex, and only works for assets someone opens — or asking users to re-upload everything.

Format decisions in §6 items 1–3 are effectively permanent. Everything else is refactorable.

## 8. Encryption spec (draft — to be hardened before first line of crypto code)

- **Cipher:** XChaCha20-Poly1305 (AEAD)
- **Content key:** 256-bit random, one per album
- **Chunking:** 256 KB plaintext chunks
- **Nonce:** 16 random bytes per asset (`base_nonce`) ‖ 8-byte little-endian chunk index = 24-byte XChaCha nonce. `base_nonce` must be unique per asset.
- **AAD per chunk:** `asset_id ‖ chunk_index ‖ total_chunks`. Without this an attacker can reorder, truncate, or splice chunks between assets. Easy to omit, and the failure is silent.
- **Key derivation (passphrase recipients):** Argon2id → key-encryption key → wraps the album content key. Server stores the wrapped blob, salt, and parameters; never the passphrase.
- **Passphrases must be system-generated, high entropy** (4–5 words, diceware-style). Because the server holds the wrapped key, a user-chosen weak passphrase is offline-brute-forceable. Do not let users pick their own.
- **QR recipients:** key material lives only in the QR. Never on the server in any form. This is the default — but **not because it is stronger in every respect.** It is stronger against a stolen database and weaker against a forwarded or captured invite, since the QR carries `K_album` while a passphrase invite does not. The full asymmetry is in encryption spec §6.5, and the default is chosen for the threat this architecture exists to defeat rather than for a general ordering.

### Revocation is server-enforced, not cryptographic

Once a recipient holds a key, that key cannot be un-given. Revoking a recipient means **the server refuses to serve them ciphertext.** That is a real and useful control, but it depends on the server behaving, not on mathematics. True cryptographic revocation requires re-encrypting the album under a new key and redistributing it.

State this accurately in the UI. "Revoked" must not imply "they can no longer decrypt what they already downloaded."

## 9. Data model sketch

| Table          | Notes                                                                                                                                                                                                                                                    |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `owners`       | Parent accounts                                                                                                                                                                                                                                          |
| `owner_keys`   | Wrappings of `K_master`, one row per credential — password now, recovery key in Phase 2. §11                                                                                                                                                             |
| `owner_tokens` | Owner auth tokens — hashed rows with expiry, not server-side sessions (non-negotiable #6)                                                                                                                                                                |
| `albums`       | Owner, title, created, status                                                                                                                                                                                                                            |
| `media`        | Album, `kind`, `status`, byte size, encrypted metadata blob                                                                                                                                                                                              |
| `recipients`   | Album, label, hashed access token, `revoked_at`; plus `wrapped`, `salt`, `wrap_nonce` and Argon2id params **for passphrase recipients only** — spec §6.2, all four; `wrap_nonce` is the one that gets forgotten and without it the blob is undecryptable |
| `access_log`   | Recipient, media, event, timestamp — powers "María viewed this"                                                                                                                                                                                          |

### 9.1 Two auth mechanisms, deliberately not one table

Owners hold account auth tokens. Recipients hold a long-lived invite access token and have no account at all (encryption spec §6.4, invite spec §1.1). These are different mechanisms, and a single shared token table would invite treating them as one — which is the easiest way to leak album access. Recipient tokens live hashed on the `recipients` row and are revoked by setting `revoked_at`; there is no separate recipient token table.

**Recipient tokens carry no expiry**, only `revoked_at`, and that asymmetry with `owner_tokens` is deliberate. An owner can always log in again; a recipient has no account, no password and no email, so an expired token would mean permanent lockout whose only recovery is the parent minting a new invite. Invite spec §3 deliberately values the opposite property — a printed QR with no expiry beyond revocation is how a grandparent is given access at a family lunch with no account and no app install. If expiry ever arrives it should be **per-invite and opt-in** (Phase 2's invite-sharing item, or Phase 5 time-limited albums), never a global default.

Since §10.1 settles v1 on proxying, revocation is checked per request and there is no URL lifetime to outlive it. The revocation latency question that a signed-URL design would have raised does not exist in v1.

### 9.2 What is deliberately not stored

**`base_nonce` and `chunk_count` are not columns.** Both already live in the authenticated 64-byte envelope header, which every chunk's AAD covers. A database copy cannot be authenticated against anything, so if the two ever disagree the header wins and the row is simply lying. The server never decrypts and therefore never needs either value; the client fetches the header regardless.

**`byte_size` is a denormalised convenience** for owner quota and storage accounting, so that answering "how much is this owner storing" does not require enumerating a bucket. Object storage is authoritative; treat the column as a cache.

**No column ever holds a plaintext filename**, and none holds key material. `recipients.wrapped_key` holds a wrapped blob for passphrase recipients; QR recipients store nothing at all (encryption spec §6.1).

**No object-key column.** `media.id` _is_ the 16-byte `asset_id`, and encryption spec §7 requires object keys to be random identifiers — which `asset_id` already is. Asset and thumbnail object keys are derived from it rather than stored, so there is no second value that can drift. See encryption spec §2 on why relying on it as a global identifier is safe.

**`albums.status` is not in the initial migration.** It appeared in earlier sketches with no enumerated values, unlike `media.status`, and v1 has no state an album moves through. Add it when something needs it — a plausible future use is Phase 5 time-limited albums.

**`owners` stays minimal.** §12 still lists the owner account model as undecided — email required, or invite-only. A migration is not the place to resolve an open decision, so the initial table carries only what login demonstrably needs.

### 9.3 Constraints a migration cannot express

The migration is the canonical column list — this section records only what DDL cannot state.

**`media.id` and `recipients.id` are client-generated and MUST NOT carry a database default.** `media.id` _is_ the envelope's `asset_id`, which the client creates before encrypting. `recipients.id` is inside the wrap AAD (encryption spec §6.2: `"vitrina-wrap-v1" ‖ recipient_id`), so the client needs it before it can compute `wrapped`. A server-assigned default breaks unwrapping, works fine for QR recipients, and fails as an opaque AEAD error. Every other `id` is server-assigned.

**Every timestamp is `timestamptz`.** The canonical user story spans Spain and Argentina; `timestamp without time zone` looks right in development and misorders the access log in production.

**Three different kinds of hash, and they are not interchangeable.** `token_hash` columns hold SHA-256 of a 32-byte random token — there is nothing to brute-force in 256 bits of entropy, and a password hash there would be pure per-request cost. `recipients.wrapped` is protected by Argon2id because a human-transcribable passphrase _is_ brute-forceable (§6.3). `owners.auth_hash` is **neither** — it is `HMAC(pepper, proof)`, a keyed fast hash. The relay never sees a password and applies no KDF (encryption spec §6.6).

That last one is the subtle case, and the distinction from `token_hash` is worth spelling out in the migration comments because the two look identical. Both hold 32 high-entropy bytes; only one of them is _known_ to. The relay mints its own tokens, so their entropy is a fact. A proof's entropy is a claim about what a client did with Argon2id, and the relay cannot check it — so a fast hash there would be safe exactly as long as every client implementation stays correct. Encryption spec §6.6.

**Every identifier is a UUIDv4** (decided 11 August 2026), stored in `uuid` columns and carried in the envelope header as 16 raw bytes. Encryption spec §2 has been amended accordingly: 122 bits of entropy rather than 128, which is irrelevant at any scale this system reaches. `base_nonce` is explicitly **not** a UUID — it stays 16 fully random bytes, because §4.1's nonce argument needs all 128 of them.

**`access_log` granularity is per asset opened, not per chunk fetched.** A hundred-photo album is roughly twelve hundred chunk requests; logging those answers no question anyone has and makes the table unusable. `event` needs a CHECK constraint like `kind` and `status`, or it drifts into three spellings of "viewed" within a month.

**Every foreign key is `ON DELETE CASCADE`** (decided 11 August 2026), including both of `access_log`'s. An earlier version of this line claimed cascading into `access_log` would destroy an audit trail evidencing erasure; that was wrong — the log records views, not deletions, and is itself personal data subject to erasure. Cascade is also forced: with `albums → recipients` cascading, a non-cascading `recipients → access_log` would make albums undeletable.

**But cascade is not erasure.** A database cascade removes rows and leaves every encrypted object in the bucket, while destroying the only record of which objects existed — `media.id` _is_ the object key. The result is storage you pay for forever and a right-to-erasure request you have reported as satisfied without deleting the images. **Deleting an album or an owner must therefore be an application operation that removes storage objects first and rows second.** Recorded as a B.6 requirement; see schema doc §5.1.

**`owners` is deferred, not designed.** With only `id` and `created_at` there is nothing to authenticate against, so the Phase 1 owner flow cannot start without adding to it. That is acceptable in a provisional migration and should be labelled as such. A password column would not resolve §12 — both candidate account models need one.

## 10. Web friction layer

All of the following are bypassable. They are included because they defeat accident, which is the threat model.

- Render into `<canvas>`; never an `<img src>` pointing at a fetchable URL
- Revoke blob URLs immediately after draw
- Suppress `contextmenu`, `dragstart`, `selectstart`
- `Cache-Control: no-store` on all ciphertext responses. **Set as object metadata at upload time, not as a per-request signed override** — see §10.1. Note that `no-store` is a request clients and intermediaries honour, not enforcement, and it is not a confidentiality control on its own
- Short-lived signed URLs for chunk fetches — Phase 3 only, per §10.1

### 10.1 Ciphertext delivery: proxied in v1, signed URLs deferred to video

**Decided 11 August 2026.** Photos and thumbnails are **proxied through the API**. Signed URLs direct to object storage are deferred to Phase 3, for video only.

The reasoning, because the shape of it matters more than the choice:

- **Phase 1 gets one mechanism, not two.** Photos-only means no signed-URL code exists in v1 at all — one auth path, one revocation story, one logging semantics.
- **The access log becomes honest for free.** A proxied fetch _is_ a retrieval, so `asset_viewed` can be recorded on an asset's first chunk request. With signed URLs the server sees _issuance_, and a client that requests forty URLs when an album opens would log forty views of which three were real. A feature that reports viewing while measuring something else is the same failure as overclaiming about screenshots (§3), and it would ship silently because the number looks plausible.
- **Revocation is instant and the UI may say so.** Checked per request, no URL lifetime to outlive it. One less hedged sentence in the copy.
- **`Cache-Control: no-store` (§10) is directly enforceable**, rather than depending on an object store honouring a signed header override.
- **It is additive, not a refactor.** A later per-asset URL endpoint sits alongside the chunk endpoint rather than replacing it, so deferring costs nothing.

The cost is paid in Phase 3, where the roadmap already notes that video storage and egress will dominate the bill, and where proxying every seek through the API is worse in both cost and latency. That decision joins the transcoding fork already scheduled for the start of that phase, by which point real egress numbers will exist.

**`Cache-Control` mechanism, verified against SeaweedFS 4.41 in B.4 (11 August 2026).** Both available mechanisms work, so the store does not force the choice — and the choice matters. A per-request signed override (`response-cache-control`) is honoured on both `200` and `206`, and tampering with or stripping it from a signed URL is correctly rejected with `403 SignatureDoesNotMatch`. But it must be remembered on every URL the code issues, and **a path that forgets it produces a perfectly working URL carrying no `no-store` at all** — verified by baseline probe as `cache-control: null`, `200 OK`. That is the same failure shape as `?` where `#` belongs: silently correct-looking and wrong.

**Therefore `Cache-Control` is set as object metadata at upload time** (`CacheControl` on `PutObject`), which is unforgettable by construction and also survives range requests. This applies when signed URLs arrive in Phase 3; in v1 the proxying API sets the header directly.

**Accepted consequence:** `no-store` means a recipient re-downloads every thumbnail on every album open — a couple of megabytes for a hundred-photo album, on the mediocre connection Phase 1 explicitly targets. This follows from §10 rather than from proxying, and it is a real tension between the friction layer and usability for the audience least able to absorb it.

## 11. Known problems not yet solved

These are real and will need answers. Recorded here so they are not discovered late.

**Accessibility of canvas rendering.** Canvas breaks screen readers, browser zoom quality, and pinch-to-zoom. Our core audience includes grandparents with imperfect eyesight. Explicit zoom and pan controls are a requirement, not a nicety.

**Mobile Safari memory limits.** Decrypting large assets in a mobile browser tab can crash it. Chunking helps; this needs real device testing before v1 ships.

**Key loss.** If a recipient loses their passphrase, nobody can recover it — that is the design working correctly. The recovery path is the parent re-inviting them. This must be explained in onboarding.

**Abuse, and the consequence of being blind.** An architecture that hides content from the host and resists copying is also attractive for distributing illegal imagery of children, and by design we cannot detect it. If Vitrina is only ever self-hosted for one family, this is moot. **If it is ever offered as a public service, it stops being moot and becomes a serious legal and moral exposure** — terms of service, abuse reporting, jurisdiction-dependent reporting obligations, and possibly client-side scanning before encryption. This must be resolved _before_ any public launch, not after. It also interacts with EU regulatory debate on this exact class of service.

**GDPR.** Operating this for anyone beyond yourself makes you a data controller processing images of minors in the EU. Privacy policy, lawful basis, retention, right to erasure. Phase 2 at the latest.

**Account existence is discoverable through signup.** The credential routes are indistinguishable by design — `POST /login/params` always answers `200` with deterministic decoys for unknown addresses, and login failure is identical for a wrong password and an unknown account. But registration must reject a duplicate address, and v1 has no email sending, so there is no way to answer identically and deliver the difference out of band.

What is protected is that an attacker cannot learn which addresses hold accounts _by attacking the login path_. They can still learn it by attempting to register one. This constrains owner-facing copy and any privacy claim about what the relay reveals — it does **not** touch B.7, which is recipient-facing and involves no account. Recorded here as well as in encryption spec §10 because that is the envelope's limitations list, and whoever writes a privacy claim will be reading this section.

**The invitation is a forwardable bearer credential for a whole album.** The images do not become forwardable files — that promise holds. But the invite link does forward with a tap, and whoever holds it holds album access permanently until the owner revokes. Forwarding it into a forty-person family group is exactly the accident §2 exists to defeat, and the friction layer in §10 defends the photographs while nothing defends the link.

Three consequences. The recipient-facing UI MUST say plainly that the invite is like a house key (invite spec §3). B.7's copy must not imply access cannot be passed on. And the mitigation options — device-bound redemption, per-invite device counts — are recorded in invite spec §8 with the reasoning for why hard single-use is not obviously right; none is in v1. Note that passphrase mode is materially better here, because the link alone is not enough (encryption spec §6.5).

**Recipients will become owners, and the two roles must not look separate to the user.** Many recipients will create their own account. The auth _mechanisms_ stay separate — an account token and an invite bearer token have different lifetimes and revocation semantics, and §9.1's warning about one shared token table stands. But the _identity_ separation must not reach the UI: someone logged in who still needs a bookmark to see their granddaughter's album is a bad product. Expect "my albums" and "shared with me".

Permissions are not the difficulty. Authorisation is per album and derived from the relationship — `albums.owner_id` gives owner rights, a `recipients` row gives view rights, and one person holding both to different albums is unremarkable. The schema cost is a nullable FK from `recipients` to `owners`, which is additive with no format change.

**The difficulty is the entry below wearing a different hat**, and that reframing matters: `K_album` retention is not only an owner-convenience question, it is the gate on "shared with me" existing at all.

**How does an owner retain `K_album`?** The invite spec says precisely how a recipient obtains an album key. Nothing says how the _owner_ keeps it. An owner needs `K_album` every time they add photos to an existing album or mint a new invite, so a memory-only key means losing your own album on a page refresh. This blocks Phase 1, interacts with the owner account model in §12, and is coupled to whether album titles can be encrypted (encryption spec §10). **Not a Phase 0 blocker; decide it before the upload flow is built.**

**Decided 20 August 2026: a server-stored `K_master`, wrapped, with no recovery in v1.**

Two of the three candidates are ruled out rather than merely less attractive. **Device-local storage** breaks the ordinary case of a parent with a phone and a laptop. **A password-derived master key** — meaning `K_album = KDF(K_master, album_id)` — contradicts encryption spec §2, which states `K_album` is 32 random bytes, and forecloses permanently: a derived key can never be re-wrapped, so no password change, no recovery key and no rotation are possible afterwards. Per §7 that class of decision cannot be migrated.

**The structural rules that follow, and they are what make this reversible:**

- **Wrap, never derive.** `K_album` stays random per encryption spec §2 and is _wrapped_ under `K_master`. Wrapping costs 32 bytes per album and keeps every future option open.
- **Store N wrappings, not one column.** An `owner_keys` table holds several wrappings of the same `K_master`, one per credential. Adding a recovery key in Phase 2 is then an `INSERT` rather than a migration; a password change re-wraps `K_master` once and leaves album keys untouched; "shared with me" becomes another row shape rather than a redesign. A single `master_key_wrapped` column on `owners` would choose no-recovery permanently.
- **The login proof and the key-encryption key MUST be independently derived from the password.** If the value the server stores to verify a login is also the value that unwraps `K_master`, a database thief needs no password at all. The derivation is specified in encryption spec §6.6 and needs conformance vectors per §9.1 before Phase 1.

**Accepted cost, stated plainly:** forgetting the password loses every album, and no reset recovers them. Email restores _login_, which the server owns; it cannot restore _keys_, which the server was never allowed to hold. Onboarding must say so rather than let it be discovered. The recovery-key option is Phase 2 and needs no migration.

The three candidates as originally recorded, since the reasoning against two of them is worth keeping:

- **Device-local storage** (IndexedDB). Nothing reaches the relay, so encryption spec §6.1 holds exactly. Lost when the device changes. Also the cheap answer for claiming.
- **Password-derived master key.** No stored blob, but every album key must be derivable from the password, which constrains the key hierarchy.
- **Server-stored blob wrapped under a password-derived key.** Works across devices and buys "shared with me" as well — at a real cost. It reintroduces the offline attack §6.3 exists to manage, this time against a **human-chosen** password, which is precisely the secret §6.3 forbids for passphrases on exactly that reasoning. Applied to a claimed album it also silently voids §6.1 for that album, and **the person accepting the risk is not the person taking it** — the owner chose direct mode, the recipient's claim changes the exposure, and the owner is never told. If this is ever built, claiming must be a per-album permission the owner grants, with visibility to the owner when it happens (invite spec §8.5's philosophy).

**Storage economics and retention.** Encrypted blobs accumulate. Who pays, and do albums expire?

**The delivered bundle cannot be verified against the source.** This is the fundamental soft spot in all browser-based end-to-end encryption, and it limits exactly the trust argument that publishing the source is meant to buy. A user can read this repository and confirm that `K_album` never reaches the relay — but they cannot confirm that the JavaScript their browser _actually received_ is the code in the repository. A compromised or coerced server could serve a modified bundle to one targeted recipient, and nothing in the client would reveal it.

Partial mitigations, in increasing order of strength: subresource integrity on the WASM module; reproducible builds with published hashes; serving the client from a separate origin or CDN from the relay API, so that compromising the relay does not compromise the code; and ultimately the Phase 4 native apps, where the binary is distributed and signed through app stores rather than fetched fresh on every visit.

None of these fully solve it, and no browser-based product has solved it. **State the limit honestly rather than letting "open source" imply a guarantee it does not provide.** It is also a real argument for the native apps beyond screenshot blocking — one worth remembering when Phase 4 gets prioritised.

## 12. Open decisions

| Decision                | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Product name            | `Vitrina` is a placeholder                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Framework               | **Decided 11 August 2026.** TypeScript throughout. **SvelteKit** on the client — the API boundary (non-negotiable #5) means the framework does almost none of the work a full-stack framework normally does, which makes the choice unusually low-stakes. **Fastify** on the server, chosen after the §10.1 proxy decision: proxying ciphertext wants mature Node streaming, and Fastify's per-route JSON Schema makes "no endpoint accepts key material" auditable by a test that walks the route table. Hono was the runner-up and becomes interesting again if the server ever stops touching ciphertext bytes. tRPC is **excluded** — Swift and Kotlin cannot consume it, so it would foreclose Phase 4 while looking like good engineering.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Hosting                 | **Decided 20 August 2026: EU, and Hetzner.** VPS in Falkenstein or Helsinki with Hetzner Object Storage alongside it — one German entity, one bill. **Acceptance condition: run B.4's test against the real provider before committing** — write an object, fetch a byte range through a presigned URL, assert the bytes. Hetzner's S3 compatibility is described as limited relative to AWS, which is exactly what that test catches. **Why same-provider matters:** §10.1 proxying means every byte travels bucket → server → client, so co-locating makes the first hop internal and turns doubled egress back into a single charge. Verify the internal-traffic terms explicitly. **What EU hosting actually buys:** the relay holds ciphertext, so a US legal request would yield nothing readable — what it would yield is metadata (addresses, album structure, access logs, timing). EU providers protect the metadata; the architecture already protects the content. **No CDN is needed** — `no-store` makes nothing cacheable and proxying puts the API in the path regardless, so the usual Cloudflare role does not apply. Alternative if managed Postgres is wanted: Scaleway, at €0.01/GB egress. Considered and not chosen: Cloudflare R2 (zero egress, but US-headquartered). |
| Owner account model     | **Decided 20 August 2026.** Email and password. Email is a memorable username, not a recovery channel — the key decision lives in §11. **No key recovery in v1**, structured so it can be added without a migration. The owner password's Argon2id parameters remain open and are a single **client-side** set sized for the weakest phone — the relay applies a peppered fast hash rather than a KDF (encryption spec §6.6), so no server-side figure exists. The number comes from phase-0-plan §8's V.1 measurement, which needs C.10.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Monetisation            | Unaddressed; affects the abuse question in §11                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Licensing               | Repo starts with **no LICENSE file** — deliberately, which means all rights reserved and nobody may legally use it yet. Per-component when decided: `crates/envelope/` → MIT OR Apache-2.0 (Rust convention, patent grant, maximises reuse); `spec/` → CC BY 4.0 (prose, and wide reimplementation is the goal); `packages/` → AGPL-3.0 vs MIT. **AGPL keeps commercial dual-licensing open** for the institutional direction below, and source availability is itself a product feature for a privacy tool. **Real deadline: before the first external pull request**, not before the first commit — sole copyright holder can relicense freely, a contributor's code in the tree cannot be relicensed without their permission. If dual-licensing matters, a CLA is needed from day one of accepting contributions. Dependencies impose no constraint (RustCrypto MIT/Apache, libsodium ISC, sharp Apache-2.0), and publishing open-source cryptography is broadly exempt from EU dual-use export controls.                                                                                                                                                                                                                                                                                  |
| Institutional direction | Nurseries and schools have this problem acutely and, unlike individual parents, have budget. Promoted to §14 as a research hypothesis. Not a v1 concern                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |

## 13. Out of scope for v1

Video · native mobile apps · screenshot detection or blocking · forensic or steganographic watermarking · comments, reactions, or any social feature · multi-owner albums · album sharing between parents.

---

## 14. Institutional direction — a hypothesis, not a plan

_Added 10 August 2026. Recorded at this length because the reasoning is worth preserving, not because anything here is decided. **Nothing in this section is scheduled.** It does not change Phase 0 or Phase 1, and per roadmap sequencing rule 3 it sits behind Phase 2's abuse resolution._

### 14.1 The thesis

Nurseries and primary schools share photographs of children with parents constantly, and they currently do it through tools built for something else — Google Classroom, WhatsApp groups, commercial nursery apps. They have the problem Vitrina solves, they have it acutely, and unlike individual parents they have budget.

The regulatory backdrop is documented rather than speculative. Denmark banned Google Workspace in schools in 2022 over insufficient data-protection guarantees. The Netherlands ran a DPIA identifying high privacy risks in education. France's CNIL recommended against Google and Microsoft cloud services in educational settings, and the Ministry of National Education issued guidance discouraging both in primary and secondary schools. Multiple German states have restricted use.

The most instructive data point is subtler. Finland's Supreme Administrative Court held that a statutory obligation can serve as a lawful basis for a school using Google Workspace, _provided the specific service is shown to be necessary and proportionate_. A blanket ban would send schools stampeding toward whatever alternative already has market presence. A necessity-and-proportionality test instead creates sustained demand for options a school can defend on paper — which is a market rather than a stampede, and a better one to enter late.

**The blind relay is an unusually strong procurement position.** "We process ciphertext we cannot decrypt" is a claim no incumbent can match, and it is the kind of claim that makes a data protection officer's job easier rather than harder.

### 14.2 What the architecture permits, and what it forbids

**No encryption format change is required.** Per-child access can be built from per-child albums alongside a shared class album, with photographs encrypted under both keys where they appear in both. That costs storage and nothing else. This matters more than it sounds: it means this entire direction stays genuinely deferrable, since the only irreversible decisions in the system are format decisions.

**The relay cannot identify children, by design.** Any feature of the form "photographs where my child appears" therefore requires tagging, and tagging has exactly two implementations:

- **Face recognition is excluded.** It is biometric processing of children's data under GDPR Article 9, it requires explicit consent, it is precisely what these institutions are moving away from, and it would destroy the "not feeding AI models, not building digital identities for children" proposition that makes the product worth buying.
- **Manual tagging by staff, client-side, with encrypted tags.** Needs no new cryptography.

**The primary risk here is labour, not engineering.** A nursery uploading forty photographs a day now has a member of staff tagging forty photographs a day. If tagging is tedious it will be done sloppily or abandoned, and every feature built on top of it degrades. Any serious version of this product lives or dies on how cheap tagging is to do.

### 14.3 The download-request flow

Proposed shape: a parent requests a photograph in which their child appears; the school approves; the parent may then download it.

This appears to contradict the entire product and does not, because the rights structure differs. Parent→grandparent is an owner sharing with an audience that has no claim to accumulate copies. School→parent is a custodian holding images of someone else's child, and that parent has a genuine claim — arguably a GDPR right of access — to a photograph of their own child.

It is therefore coherent **in this context only**, and must be built so it cannot leak into the consumer product as a general "download" toggle:

- Per photograph, never per album
- Watermarked and metadata-stripped, never the original file
- Logged on both sides, visible to the school
- Onboarding copy stating plainly that **once approved, the photograph is an ordinary file on the parent's phone and Vitrina's guarantees end at that boundary**

That last point is non-negotiable for the same reason as §3: a guarantee described as extending further than it does is worse than no guarantee.

### 14.4 The genuinely hard part is consent

A class photograph contains other people's children. Schools handle this today with a paper form in September and optimism.

- Some parents refuse permission, and refusal must be enforced at the point of sharing rather than remembered
- What happens to a photograph where one child's parents consented and another's did not?
- What happens when consent is withdrawn months after distribution?

**If Vitrina makes this tractable — per-child consent records, enforcement at share time, an audit trail a school can hand an inspector — that is the product.** The encryption is table stakes. The consent ledger is the thing worth paying for. This is a meaningful reframe of what would actually be built, and it is mostly organisational logic rather than cryptography.

### 14.5 What changes, legally and commercially

**You become a processor, not a controller** (GDPR Article 28). That means a Data Processing Agreement with every institution, sub-processor disclosure, breach notification within 72 hours, records of processing, and security questionnaires from procurement staff who may ask for ISO 27001. For a solo developer this administrative load plausibly exceeds the software.

**It reduces the abuse exposure in §11.** Customers become identifiable legal entities under contract rather than anonymous public signups. The institutional route may be the _safer_ commercial path, not merely the more lucrative one — which is a genuine argument for it over consumer public launch.

**The sharpest objections, recorded so they are not rediscovered enthusiastically:**

- Google Classroom is free and bundled. Schools use it for that reason, not because they evaluated it.
- Privacy is not currently a budget line in most schools. It has to become one, or the sale requires a regulator's letter.
- Sales cycles run six to eighteen months against budgets tied to the academic year.
- Multi-tenant accounts, staff roles, parent accounts, consent records, audit trails and approval workflows amount to a different product sharing an encryption layer — several times the scope of Phase 1.

### 14.6 Open questions — research, not code

The cheap validating action is to **talk to two or three nurseries.** Not to sell; to find out whether the problem is felt. A few hours, no code, and it separates a good hypothesis from a good market. If two of three shrug, a year has been saved.

1. Do they experience photo sharing as a problem, or only we?
2. What do they use today, and who chose it?
3. Has anyone — parent, inspector, regulator — ever questioned them on it?
4. Would staff realistically tag photographs? What is the true daily volume?
5. How is consent handled now, and what happens when a parent refuses or withdraws?
6. Who holds the budget, and what does the decision process look like?
7. **Spain specifically:** what does AEPD guidance actually say about schools sharing images of minors?
8. Does a Spanish or EU competitor already occupy this space?
9. What would they pay, and on what unit — per child per year, or per institution?
10. Is the download-request flow answering a real need, or did we invent it?

Question 10 deserves suspicion. It was designed before anyone asked for it.

---

## 15. Language and localisation

_Added 11 August 2026. Placed at the end to avoid renumbering; logically it belongs alongside §3._

**Target languages: English, Spanish, Catalan, French, Italian.** German is a candidate, gated on §15.3.

### 15.1 The API is locale-agnostic

No route reads `Accept-Language`, and no response contains user-facing prose. Error responses carry a stable machine-readable `code`; the **client** maps it to displayed text in the language the user chose. Putting translation server-side would mean shipping i18n into the API and knowing the caller's locale on every request, for no benefit — the client already knows its own language better than a header does.

**Language is an explicit user setting, never inferred from IP geolocation.** A Catalan speaker in France gets French only if they ask for it.

`albums.title` and `recipients.label` are owner-authored free text in whatever language the owner typed. No localisation applies, and none would if they were later encrypted (encryption spec §10).

### 15.2 Passphrase language is per invite, not per app locale

Encryption spec §6.3 requires passphrase words to come from the _recipient's_ language, because a grandparent transcribing words aloud over the phone gets their own language right and a foreign one wrong. That is a correctness requirement, not a nicety — so the owner selects the wordlist **when creating the invite**, defaulting to their own display language and freely changeable. A Spanish parent inviting a German aunt needs a German passphrase.

**Passphrase languages are a subset of UI languages.** A UI translation needs a translator; a wordlist needs 7,776 words that are phonetically distinct with no homophones and no pairs differing only by a diacritic. See encryption spec §6.3 — offering a passphrase language without a vetted list is worse than not offering it.

### 15.3 A language ships only when a speaker has read the guarantee copy

_The reference text this gate applies to is **§16**._

B.7's onboarding copy states a guarantee **and its limit**. §3 makes overclaiming a product rule rather than a preference, and a machine-translated guarantee is exactly how it gets violated without anyone noticing — the English stays careful while a translation quietly promises more, or drops the screenshot caveat because it reads awkwardly.

So: no language reaches users until someone fluent has read the three sentences and confirmed they neither overclaim nor hedge into meaninglessness. This is a real review burden per language, and it is the strongest practical argument for keeping the copy to three sentences.

---

## 16. Recipient onboarding copy — the reference text

_B.7, completed 20 August 2026. This is what a recipient reads after opening an invite. It is the reference text: brief §15.3 gates every translation on a fluent speaker confirming that both the guarantee **and its limit** survive._

> Someone has opened a window to share something with you: you have been given access to an album of their choice, and you can visit it as many times as you want.
>
> Nothing is automatically saved to your phone or laptop. There is no file to forward. Pictures are unreadable on our servers.
>
> The link is the key: keep it to yourself. Screenshots leave marks, and all invitations are revocable.

### Why each clause is worded as it is

Recorded because every one of these was a correction, and a future edit that "improves" the copy will otherwise reintroduce a claim that took several drafts to remove.

| Clause                                                   | Why not something stronger                                                                                                                                                                                                                                                                                                                                                                 |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| "Nothing is automatically saved to your phone or laptop" | Not _"pictures never land on any device"_ — they land on the owner's, and on the relay as ciphertext. The true and useful claim is about the **recipient's** device: no camera roll, therefore no cloud backup                                                                                                                                                                             |
| "There is no file to forward"                            | Not _"you cannot download them"_. A determined recipient can extract what is rendered; §3 forbids implying otherwise. What is true is that nothing saves by default and there is no file object to pass on                                                                                                                                                                                 |
| "Pictures are unreadable on our servers"                 | Not _"nothing is stored on a server"_. The ciphertext is stored; the relay cannot read it                                                                                                                                                                                                                                                                                                  |
| **"The link is the key: keep it to yourself"**           | The load-bearing sentence. §11 records the invite as a forwardable bearer credential for a whole album and nothing defends it. Without this line a recipient reasonably treats a link as a link                                                                                                                                                                                            |
| "Screenshots leave marks"                                | Not _"screenshots leave traces"_, which implies detection that does not exist on the web. A **mark** is on the artifact: the client-side watermark carries the recipient's name into any capture. Deliberately **not** _"shared screenshots leave marks"_ — that would license a private screenshot, which lands in a camera roll and syncs to a cloud, the exact leak §3 promises against |
| "all invitations are revocable"                          | Impersonal and true. Revocation stops future access and does nothing about what has already been retrieved (encryption spec §6.4); the copy claims no more                                                                                                                                                                                                                                 |

**Nothing here says the product prevents copying**, and no future edit may add it. Note that every draft correction _removed_ a claim rather than adding one — the final text is shorter than the first and says more, because none of it has to be defended.

**This is recipient-facing only.** Owner-facing copy is a separate artifact and carries different obligations, including §11's note that account existence is discoverable through signup.

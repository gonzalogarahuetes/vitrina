# Vitrina — Project Brief

**Status:** Draft v0.1 · last updated 11 August 2026
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
- There is no file object to forward
- All location and camera metadata is stripped before anything leaves the parent's device
- The relay server stores only ciphertext it cannot decrypt
- Access is revocable
- Only people the parent explicitly invited can view

### We must never claim

- That screenshots are impossible
- That photographing the screen with another phone is impossible
- That a technically sophisticated recipient cannot extract what is displayed
- That the images are "un-copyable" or "DRM-protected"

**This is a product rule, not just an ethical one.** Overclaiming invites a betrayal-of-trust incident the first time a user discovers a screenshot, and in the EU it is a marketing claim we cannot substantiate. Onboarding copy must state the limit plainly and frame the value correctly: _nothing lands on their device, nothing syncs to a cloud, nothing forwards with a tap, and you can revoke it._

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
6. **Token-based auth, not cookie-session auth.** A cookie may carry the token in the browser; the server contract assumes a stateless, untrusted client.
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
- **QR recipients:** key material lives only in the QR. Never on the server in any form. This is the stronger path and should be the default.

### Revocation is server-enforced, not cryptographic

Once a recipient holds a key, that key cannot be un-given. Revoking a recipient means **the server refuses to serve them ciphertext.** That is a real and useful control, but it depends on the server behaving, not on mathematics. True cryptographic revocation requires re-encrypting the album under a new key and redistributing it.

State this accurately in the UI. "Revoked" must not imply "they can no longer decrypt what they already downloaded."

## 9. Data model sketch

| Table          | Notes                                                                                                                                                                                                                                                    |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `owners`       | Parent accounts                                                                                                                                                                                                                                          |
| `owner_tokens` | Owner auth tokens — hashed rows with expiry, not server-side sessions (non-negotiable #6)                                                                                                                                                                |
| `albums`       | Owner, title, created, status                                                                                                                                                                                                                            |
| `media`        | Album, `kind`, `status`, byte size, encrypted metadata blob                                                                                                                                                                                              |
| `recipients`   | Album, label, hashed access token, `revoked_at`; plus `wrapped`, `salt`, `wrap_nonce` and Argon2id params **for passphrase recipients only** — spec §6.2, all four; `wrap_nonce` is the one that gets forgotten and without it the blob is undecryptable |
| `access_log`   | Recipient, media, event, timestamp — powers "María viewed this"                                                                                                                                                                                          |

### 9.1 Two auth mechanisms, deliberately not one table

Owners hold account auth tokens. Recipients hold a long-lived invite access token and have no account at all (encryption spec §6.4, invite spec §1.1). These are different mechanisms, and a single shared token table would invite treating them as one — which is the easiest way to leak album access. Recipient tokens live hashed on the `recipients` row and are revoked by setting `revoked_at`; there is no separate recipient token table.

The "short-lived" property that a session table would provide for recipients is instead delivered by short-lived signed URLs for chunk fetches (§10). Confirm the expiry deliberately in the API sketch — it _is_ the revocation latency.

### 9.2 What is deliberately not stored

**`base_nonce` and `chunk_count` are not columns.** Both already live in the authenticated 64-byte envelope header, which every chunk's AAD covers. A database copy cannot be authenticated against anything, so if the two ever disagree the header wins and the row is simply lying. The server never decrypts and therefore never needs either value; the client fetches the header regardless.

**`byte_size` is a denormalised convenience** for owner quota and storage accounting, so that answering "how much is this owner storing" does not require enumerating a bucket. Object storage is authoritative; treat the column as a cache.

**No column ever holds a plaintext filename**, and none holds key material. `recipients.wrapped_key` holds a wrapped blob for passphrase recipients; QR recipients store nothing at all (encryption spec §6.1).

**No object-key column.** `media.id` _is_ the 16-byte `asset_id`, and encryption spec §7 requires object keys to be random identifiers — which `asset_id` already is. Asset and thumbnail object keys are derived from it rather than stored, so there is no second value that can drift. See encryption spec §2 on why relying on it as a global identifier is safe.

**`albums.status` is not in the initial migration.** It appeared in earlier sketches with no enumerated values, unlike `media.status`, and v1 has no state an album moves through. Add it when something needs it — a plausible future use is Phase 5 time-limited albums.

**`owners` stays minimal.** §12 still lists the owner account model as undecided — email required, or invite-only. A migration is not the place to resolve an open decision, so the initial table carries only what login demonstrably needs.

## 10. Web friction layer

All of the following are bypassable. They are included because they defeat accident, which is the threat model.

- Render into `<canvas>`; never an `<img src>` pointing at a fetchable URL
- Revoke blob URLs immediately after draw
- Suppress `contextmenu`, `dragstart`, `selectstart`
- `Cache-Control: no-store` on all ciphertext responses
- Short-lived signed URLs for chunk fetches

## 11. Known problems not yet solved

These are real and will need answers. Recorded here so they are not discovered late.

**Accessibility of canvas rendering.** Canvas breaks screen readers, browser zoom quality, and pinch-to-zoom. Our core audience includes grandparents with imperfect eyesight. Explicit zoom and pan controls are a requirement, not a nicety.

**Mobile Safari memory limits.** Decrypting large assets in a mobile browser tab can crash it. Chunking helps; this needs real device testing before v1 ships.

**Key loss.** If a recipient loses their passphrase, nobody can recover it — that is the design working correctly. The recovery path is the parent re-inviting them. This must be explained in onboarding.

**Abuse, and the consequence of being blind.** An architecture that hides content from the host and resists copying is also attractive for distributing illegal imagery of children, and by design we cannot detect it. If Vitrina is only ever self-hosted for one family, this is moot. **If it is ever offered as a public service, it stops being moot and becomes a serious legal and moral exposure** — terms of service, abuse reporting, jurisdiction-dependent reporting obligations, and possibly client-side scanning before encryption. This must be resolved _before_ any public launch, not after. It also interacts with EU regulatory debate on this exact class of service.

**GDPR.** Operating this for anyone beyond yourself makes you a data controller processing images of minors in the EU. Privacy policy, lawful basis, retention, right to erasure. Phase 2 at the latest.

**How does an owner retain `K_album`?** The invite spec says precisely how a recipient obtains an album key. Nothing says how the _owner_ keeps it. An owner needs `K_album` every time they add photos to an existing album or mint a new invite, so a memory-only key means losing your own album on a page refresh. The options are a password-derived master key, device-local storage (lost when the device changes), or a server-stored blob wrapped under a password-derived key — which reintroduces the offline-attack surface that encryption spec §6.3 exists to manage, this time against the owner's own password. This blocks Phase 1, interacts with the owner account model in §12, and is coupled to whether album titles can be encrypted (encryption spec §10). **Not a Phase 0 blocker; decide it before the upload flow is built.**

**Storage economics and retention.** Encrypted blobs accumulate. Who pays, and do albums expire?

**The delivered bundle cannot be verified against the source.** This is the fundamental soft spot in all browser-based end-to-end encryption, and it limits exactly the trust argument that publishing the source is meant to buy. A user can read this repository and confirm that `K_album` never reaches the relay — but they cannot confirm that the JavaScript their browser _actually received_ is the code in the repository. A compromised or coerced server could serve a modified bundle to one targeted recipient, and nothing in the client would reveal it.

Partial mitigations, in increasing order of strength: subresource integrity on the WASM module; reproducible builds with published hashes; serving the client from a separate origin or CDN from the relay API, so that compromising the relay does not compromise the code; and ultimately the Phase 4 native apps, where the binary is distributed and signed through app stores rather than fetched fresh on every visit.

None of these fully solve it, and no browser-based product has solved it. **State the limit honestly rather than letting "open source" imply a guarantee it does not provide.** It is also a real argument for the native apps beyond screenshot blocking — one worth remembering when Phase 4 gets prioritised.

## 12. Open decisions

| Decision                | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Product name            | `Vitrina` is a placeholder                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Framework               | TypeScript recommended; SvelteKit vs Next.js undecided                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Hosting                 | Low-stakes given blind relay; still unanswered                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Owner account model     | Email required, or invite-only/self-hosted?                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Monetisation            | Unaddressed; affects the abuse question in §11                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Licensing               | Repo starts with **no LICENSE file** — deliberately, which means all rights reserved and nobody may legally use it yet. Per-component when decided: `crates/envelope/` → MIT OR Apache-2.0 (Rust convention, patent grant, maximises reuse); `spec/` → CC BY 4.0 (prose, and wide reimplementation is the goal); `packages/` → AGPL-3.0 vs MIT. **AGPL keeps commercial dual-licensing open** for the institutional direction below, and source availability is itself a product feature for a privacy tool. **Real deadline: before the first external pull request**, not before the first commit — sole copyright holder can relicense freely, a contributor's code in the tree cannot be relicensed without their permission. If dual-licensing matters, a CLA is needed from day one of accepting contributions. Dependencies impose no constraint (RustCrypto MIT/Apache, libsodium ISC, sharp Apache-2.0), and publishing open-source cryptography is broadly exempt from EU dual-use export controls. |
| Institutional direction | Nurseries and schools have this problem acutely and, unlike individual parents, have budget. Promoted to §14 as a research hypothesis. Not a v1 concern                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |

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

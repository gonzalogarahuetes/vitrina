# Vitrina — Roadmap

**Status:** Draft v0.1 · last updated 11 August 2026 · Phase 3 signed-URL note
**Companion to:** `vitrina-project-brief.md` (canonical; this document defers to it on any conflict)

Resolution decreases deliberately as phases advance. Phase 1 is specified because you are about to build it. Phase 4 is a sketch because specifying it now would be fiction. **Do not sharpen the later phases prematurely** — the point of the non-negotiables in the brief is that they let you leave the future blurry without being trapped by it.

---

## Phase 0 — Decide and specify

_No application code. Roughly one to two weeks. Skipping this is the most expensive shortcut available._

- [ ] Settle framework and hosting
- [ ] Harden the encryption spec (brief §8) into a standalone document — chunking, nonce derivation, AAD, envelope header layout, version byte
- [ ] Define the invite payload object and its three serialisations (URL fragment, QR, universal link)
- [ ] Sketch the API surface: routes, auth model, error shapes
- [ ] Repository skeleton, CI, linting, test harness
- [ ] Write the honest onboarding copy _now_, before building. If you cannot describe the guarantee truthfully in three sentences, the product is not clear yet.

**Exit criterion:** someone could implement the crypto layer in a language of their choice from your spec alone.

**Delegation note:** the encryption spec is yours. It is the one artifact where a subtle error is unrecoverable, and writing it is how you come to understand your own system. Hand the CI and repo skeleton to Claude Code.

---

## Phase 1 — v1: web, photos only

_The goal is a working private album you would actually send to your own mother. Not a product. Not signups. One real use._

### Owner flow

- [ ] Account creation and login (token-based, per brief §6 #6)
- [ ] Create album
- [ ] Select photos, strip metadata, downscale, generate thumbnail, encrypt, upload — all client-side
- [ ] Upload progress and failure recovery
- [ ] Add recipient → generate QR and passphrase
- [ ] Recipient list with revoke
- [ ] "María viewed 12 photos" access log view

### Recipient flow

- [ ] Open invite via QR or link, or enter passphrase
- [ ] Unwrap key, fetch chunks, decrypt in memory
- [ ] Grid of thumbnails → full view
- [ ] Visible client-side watermark
- [ ] Zoom and pan controls (brief §11 — not optional)
- [ ] Friction layer (brief §10)
- [ ] Works on a five-year-old Android phone with a mediocre connection

### Cross-cutting

- [ ] Real-device testing on iOS Safari for memory limits
- [ ] Onboarding copy stating the screenshot limitation plainly

**Exit criterion:** a family member who is not technical successfully views an album without needing you on the phone.

**What v1 deliberately does not have:** password reset, email notifications, album editing after creation, multiple albums per recipient, any styling ambition. Add them when they hurt.

**Delegation note:** the crypto layer, key wrapping, and the invite payload are yours to write — they are the product. The upload progress UI, the thumbnail grid, and the test suite are good Claude Code work.

---

## Phase 2 — Harden

_Triggered by: v1 works and you want a second family using it._

- Password reset and recipient re-invitation flows
- Rate limiting, abuse basics, upload size caps
- Error handling that a non-technical user can act on
- GDPR: privacy policy, lawful basis, retention policy, erasure
- Accessibility audit — real one, with a real elderly user
- Storage lifecycle and retention decisions
- **Invite sharing:** decide whether to surface per-invite device counts to the owner. Invite spec §8 — the reasoning is recorded, including why hard single-use is not obviously the right answer
- Observability: know when uploads fail without being told
- **Resolve the abuse question (brief §11) if there is any path to public availability.** This gates public launch, not Phase 3.

---

## Phase 3 — Video

_Triggered by: photos are solid and you have users asking. Assume this phase is roughly the size of Phase 1._

The encryption format already supports it if Phase 0 was done properly. What is missing is everything around it:

- Server-side transcoding worker (ffmpeg) — the first component that must decrypt, so it needs its own trust analysis, or must run client-side
- Bitrate ladder decisions, or a single sensible profile to start
- Chunked encrypted playback via Media Source Extensions
- **Signed URLs direct to object storage**, deferred here from v1 (brief §10.1). Proxying every seek through the API is worse in both cost and latency, and by this phase real egress numbers exist. The trade returning with it: revocation latency equals URL lifetime, and the access log measures issuance rather than viewing unless URLs are issued lazily per asset. The `Cache-Control` mechanism is already settled and verified — object metadata at upload, not a per-request override (brief §10.1)
- Seeking against independently-decryptable chunks
- Poster frame extraction
- Duration and size limits
- Genuine cost modelling — video storage and egress will dominate your bill

**Open question to resolve at the start of this phase, not now:** does transcoding happen on the parent's device (preserves blindness, slow, battery-hungry, browser-limited) or on a server (fast, requires breaking the blind-relay property for that step)? This is a real fork with product consequences, and deciding it early would be guessing.

---

## Phase 4 — Native mobile

_Triggered by: users asking for stronger guarantees, or the web viewer proving too awkward on phones._

If the brief's non-negotiables held, this is a client rewrite against an unchanged API rather than a re-architecture.

- iOS and Android viewers sharing the API and the libsodium primitives
- Android: `FLAG_SECURE` — the only real screenshot _blocking_ available anywhere in this product
- iOS: screenshot _detection_ → notify the parent. Worth reframing as a feature rather than a control: "María took a screenshot" is exactly the accountability a nervous parent wants
- Push notification on new album
- Native owner-side capture and upload

**Strategic note carried forward:** do not assume native replaces web. Asking a 74-year-old to install an app is the kind of friction that kills adoption, whereas "scan this QR, it opens in your browser" does not. The likely end state is web as the default viewer and native as an optional high-assurance mode — which means the web client stays a first-class citizen forever, not a legacy path.

---

## Phase 5 — Possible directions

_Speculative. Recorded so the options are not forgotten, not because they are planned._

**Institutional.** Nurseries and schools share photos of children with parents and are under real regulatory pressure doing it. They have the problem acutely and, unlike individual parents, they have budget. This would require multi-tenant accounts, staff roles, consent records, and audit trails — a different product wearing the same architecture.

Developed at length in **brief §14**, including what the blind relay forbids (face recognition), what it permits at no format cost (per-child access), why the consent ledger is probably the real product, and the open research questions. **The validating action is talking to two or three nurseries, and it is available now** — it needs no code and does not touch Phase 0.

**Self-hosting as a product.** A packaged deployment for the privacy-motivated, which also sidesteps the abuse exposure in brief §11 entirely.

**Time-limited albums.** Auto-expiry as a first-class feature rather than a retention policy.

---

## Sequencing rules

1. **Nothing from Phase 3 or 4 gets built early.** The non-negotiables exist precisely so that waiting costs nothing.
2. **Nothing from Phase 0 gets skipped.** It is the only phase whose omissions are unrecoverable.
3. **Public availability is gated on Phase 2's abuse resolution**, independent of feature readiness.
4. When a phase tempts you to violate a non-negotiable, the non-negotiable wins or the brief gets amended deliberately — never silently.

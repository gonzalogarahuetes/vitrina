# Vitrina — Phase 0 Detailed Plan

**Status:** Draft v0.1 · last updated 13 September 2026
**Supersedes:** the Phase 0 section of `vitrina-roadmap.md`
**Companion to:** `vitrina-project-brief.md`, `vitrina-encryption-spec.md`, `vitrina-invite-spec.md`

---

## 1. Why Phase 0 exists

Every other phase is recoverable. This one is not, and the reason is specific rather than general:

**The relay cannot decrypt, therefore the relay cannot migrate its own data.** A bad table design gets fixed with a migration script. A bad encryption envelope gets fixed by asking every user to re-upload every photo. Phase 0 is the phase where you are making permanent decisions, so it is the phase that deserves disproportionate care.

Secondarily, Phase 0 is where the project's structural commitments get _built in_ rather than written down. Non-negotiable #5 — a real API boundary — is a rule you have to remember if the repo doesn't have a separate `packages/server`, and a fact you can't easily violate if it does. The same is true of the `media`-not-`photos` naming and the async status field. Phase 0 turns discipline into structure.

## 2. What changed from the roadmap

The roadmap said Phase 0 was "decide and specify — no application code." That was wrong in one respect.

**Phase 0 now ends with a working, tested `crates/envelope`.** A specification that has never been implemented is a hypothesis, not a specification. Building it is how the ambiguities surface, and the resulting corrections are worth more than any amount of review. The crate is also not application code in the sense that mattered — it has no UI, no server, no database.

Consequently the Rust learning track sits **inside** Phase 0 rather than awkwardly before it.

## 3. Objectives

Each of these earns its place; none is ceremony.

1. **A monorepo whose structure enforces the non-negotiables**, so that later violations require deliberate effort rather than mere forgetfulness.
2. **Working Rust fundamentals** — narrowly, the subset the envelope needs.
3. **A tested, conforming envelope implementation** with exported test vectors that every future client must pass.
4. **A specification corrected by the act of implementation.**
5. **Empirical validation of the two riskiest numeric choices** — 64 MiB Argon2id and 256 KiB chunks — on real target hardware.
6. **Honest onboarding copy, written before any UI exists.** If the guarantee cannot be stated truthfully in three sentences, the product is not yet clear, and discovering that now costs nothing.

## 4. Two tracks, interleaved

Measured in **work sessions** (one focused evening, ~2 hours), not calendar time.

**Track A — Rust fundamentals.** Own chat, own exit condition. ~6–10 sessions.
**Track B — Project foundations.** Needs no Rust and no crypto. Can start tonight, in parallel.
**Track C — Envelope implementation.** Begins when Track A reaches step A.4.

Track B is deliberately the low-cognitive-load work, so it's available on evenings when learning a new language isn't.

---

## 5. Track A — Rust fundamentals

Scope is set by what §6 actually requires. There are chapters of the Rust Book you should skip.

**Needed:**

- Ownership, borrowing, `&[u8]` vs `Vec<u8>`, slicing
- Fixed-size arrays `[u8; 32]`, and `TryInto` for slice→array conversion
- `Result`, `?`, custom error enums, `thiserror`
- Structs, `impl`, methods; enough traits to derive and implement a few
- Pattern matching, `Option`
- Modules, `Cargo.toml`, dependencies, `cargo test`
- Integer types and explicit little-endian conversion (`u32::from_le_bytes`, `to_le_bytes`)
- Writing unit tests and `#[should_panic]` / error-case tests

**Deliberately skipped:** `async`/`await`, threads and `Send`/`Sync`, `Rc`/`RefCell`, lifetimes beyond what the compiler infers, macros, unsafe, web frameworks. If a tutorial leads you into these, you have left the scope.

**Exit condition:** you can write a function taking `&[u8]`, parsing fixed-offset fields into a struct, returning `Result<Struct, MyError>`, with tests covering success and three failure modes — without looking anything up.

**Milestones:**

- A.1 — toolchain installed, `cargo new`, tests running
- A.2 — ownership and borrowing genuinely understood, not merely survived
- A.3 — `Result` and error enums fluent
- A.4 — byte slices, arrays, `TryInto`, endianness → **Track C can begin**
- A.5 — traits and modules sufficient to organise a crate

---

## 6. Track B — Project foundations

No Rust, no crypto. Heavily delegable.

**Expanded in `vitrina-track-b-plan.md`, which supersedes this section** — ordering and dependencies, per-step acceptance criteria, the CI enforcement rules, and an energy map. The summary below remains accurate; the detail lives there.

- **B.1** Create the monorepo, `pnpm` workspace + `cargo` workspace, directory skeleton per the component table. _(Yours.)_
- **B.2** Commit the specification documents to `spec/`. _(Yours — 5 minutes, and it unblocks every Claude Code session.)_
- **B.3** CI: `cargo test`, `cargo clippy`, `pnpm lint`, `pnpm test`, plus a build-failing grep for `crypto_secretstream`. Green on an empty repo. _(Delegate.)_
- **B.4** `docker-compose` for local Postgres + an S3-compatible object store (currently SeaweedFS). _(Delegate.)_
- **B.5** Initial migration from brief §9. Mark provisional. _(Delegate, review yourself.)_
- **B.6** API surface sketch — routes, auth model, error shapes, and the proxy-versus-signed-URL decision. Design document, not code. _(Yours. This is where non-negotiable #5 either happens or quietly doesn't.)_
- **B.7** Write the onboarding copy. Three sentences stating the guarantee and its limit honestly. _(Yours, and don't defer it.)_
- **B.8** Record the framework decision in brief §12. License stays absent for now — see brief §12.

---

## 7. Track C — Envelope implementation ladder

**The order here is pedagogical, not arbitrary.** Each step is independently testable, teaches roughly one thing, and the first two contain no cryptography at all — so you can start before the crypto concepts have landed.

| Step | What                                                                                            | Teaches                                         | Crypto? |
| ---- | ----------------------------------------------------------------------------------------------- | ----------------------------------------------- | ------- |
| C.1  | 64-byte header: serialize, parse, validate                                                      | Byte slices, endianness, `TryInto`, error enums | None    |
| C.2  | Derived quantities: `chunk_count`, byte offsets, ranges                                         | Integer arithmetic, edge cases                  | None    |
| C.3  | Key derivation — keyed BLAKE2b, three domain strings                                            | Calling a crypto dependency                     | Trivial |
| C.4  | Nonce derivation                                                                                | Concatenation, counters                         | Trivial |
| C.5  | Single-chunk encrypt/decrypt with AAD                                                           | AEAD, what AAD actually does                    | Yes     |
| C.6  | Full multi-chunk envelope                                                                       | Composition, the partial final chunk            | Yes     |
| C.7  | **Random-access decrypt of chunk _i_** given only `K_asset`, the header, and that chunk's bytes | The property Phase 3 depends on                 | Yes     |
| C.8  | Argon2id wrap and unwrap                                                                        | Password hashing vs hashing                     | Yes     |
| C.9  | Test vector generation, exported as JSON to `spec/vectors/`                                     | —                                               | —       |
| C.10 | `wasm-bindgen` binding + TypeScript smoke test **+ length validation at the boundary**          | The FFI boundary                                | —       |

**C.2's edge cases are where the bugs live.** Plaintext exactly `chunk_size`; exactly `chunk_size + 1`; a final chunk of one byte. Write those tests before the code.

**C.7 is the conformance gate, not a nice-to-have.** If you cannot decrypt chunk 400 of a video without having touched chunks 0–399, seeking is impossible and the whole chunked design was pointless. Test it explicitly and deliberately, by loading _only_ the header and one chunk's byte range from disk.

**C.10 is where every type-level invariant has to be re-established as a runtime check.** Every `[u8; N]` in the crate — keys, nonces, `asset_id`, salts, wrapped blobs — is a compile-time guarantee that evaporates at the boundary: from JavaScript they are all `Uint8Array` of arbitrary length. So the binding must validate every length it accepts and return an error rather than panicking, and the harness must assert that a wrong-length input is rejected.

The exit criterion below — loads in a browser, round-trips a 3 MB buffer — does **not** cover this. A binding that accepts a 20-byte key and panics inside the crate passes it. Note also that a Rust `panic!` across `wasm-bindgen` surfaces as an unhelpful JavaScript exception with no diagnostic, which is why the check belongs at the boundary rather than being left to the crate's own asserts. _Added 21 August 2026, surfaced by C.8's salt typing: the crate's `&[u8; 16]` makes a wrong-length salt unrepresentable in Rust and says nothing about what arrives from JS._

**C.9's negative vectors matter as much as the positive ones.** Tampered byte, swapped chunks, truncated asset with adjusted `plaintext_length`, altered version byte. An implementation that accepts reordered chunks passes every positive test and is broken.

---

## 8. Empirical validation

Two numbers in the spec are guesses that need evidence. Both are cheap to check once C.10 exists, and both change the spec if they fail — which is why they belong here and not in Phase 2.

**V.1 — Argon2id at 64 MiB, t=3, p=1, in a mobile browser WASM heap.** On a genuinely low-end Android phone, not a flagship and not a desktop. Measure wall-clock time and whether it completes at all. Acceptable is a few seconds; failing to allocate is a spec change. libsodium's `MODERATE` preset (256 MiB) is the thing we are avoiding, and this is the test that confirms we were right to.

**V.1 PASSED, 14 September 2026.** Xiaomi Redmi 9C (M2006C3MG), Android 11, Chrome 148, MediaTek Helio G35 — octa-core but **all Cortex-A53**, so with `p = 1` the derivation runs on one 2.3 GHz in-order core of a 2012 design. Announced June 2020, discontinued. Two runs of six: cold 1852–2239 ms, warm 1991–2048 ms. **Worst observed 2239 ms against a pre-registered 3000 ms limit** — roughly 25% headroom, and the thresholds were fixed before the device was in hand. **Encryption spec §6.2's 64 MiB / t=3 / p=1 stands; no amendment.**

The warm run is _tighter_ rather than faster — spread falls from 387 ms to 57 ms — so steady state is about 2.0 s and the cold outliers were allocation and JIT.

**What the device log cannot establish, and why it is hand-recorded.** Chrome's UA reduction freezes the model to "K" and reports Android 10 regardless; `navigator.deviceMemory` is Chromium-only and returned unavailable here. Model, SoC, RAM and OS version above come from the device's own settings, not from the page.

**The other three measurements, on the slowest hardware in the set.** Criterion 3: 3 MB round trip in 244–274 ms against 2000. Album open: 20 assets in 3709 ms warm and 5215 ms cold against 15000, with decrypt at 271 ms and 323 ms — **6.2% and 7.3% of album-open cost**, inside the 1–13% band the other devices gave. Thumbnail grid: four passes spanning 820–1700 ms against an informational 3000, and worth treating as the worst case rather than one sample, since eMMC 5.1 plus an A53 is close to the floor for both storage and CPU.

**Known gap, recorded rather than chased.** This is the **4 GB** variant. The 2 GB Redmi 9C has the identical SoC, so its Argon2id _timing_ would match; what differs is Chrome's per-tab headroom against a 64 MiB allocation, and that failure mode is the tab being evicted rather than running slowly. Untested. Note also that the page cannot distinguish an OOM eviction from a manual reload — both look like a fresh load from inside — so any future run of this class must state in writing which occurred.

**V.2 — decrypt and render a full album in mobile Safari.** Twenty photos at ~1600 px. Watch for tab crashes from memory pressure. If 256 KiB chunks are wrong, better to know before anything depends on them.

**V.2 PASSED.** Mobile Safari, twenty photos, no crash, maximum scheduler gap 0 ms — so nothing was suspended and the result is memory behaviour rather than backgrounding. **256 KiB chunks stand; encryption spec §3.1 needs no amendment.**

**The transferable finding, which matters more than the pass.** Decryption is not the cost of opening an album. Twenty 1600 px photos: 122 ms decrypt against 706 ms render on iPhone, 495 ms against 1637 ms on Android. On the worse platform the envelope is under a third of decode, and decode is itself a fraction of fetch.

Two consequences for Phase 1. **Chunk size is retired as a performance question** — it is a format decision (§3.1) and nothing about it is worth revisiting for speed. And **the dominant cost is the one brief §10.1 forbids optimising**: `no-store` means no caching, so a recipient pays full fetch on every album open. That is a deliberate choice, not a defect — but it means the first performance complaint in Phase 1 will not be answered by anything in the envelope, and the thumbnail-grid figure §10.1 anticipates now has a first measurement: **roughly one second per album open, fetch-dominated, over a 1.65 Mb/s LAN link**, with `no-store` confirmed to be causing a genuine re-download rather than a cached one. One device, one link, twenty assets — an existence proof rather than a characterisation, and the tunnel runs from the same session are not usable for this.

---

## 9. Exit criteria

Phase 0 is done when all of the following are true. Not "mostly."

- [x] `crates/envelope` passes every vector category in encryption spec §9, **including every negative case** — **done**, 15 categories incl. negatives
- [x] Chunk _i_ decrypts given only the header and that chunk's bytes (C.7) — **done (C.7)**
- [x] The WASM module loads in a browser and round-trips a 3 MB buffer — **done on two devices** (§8)
- [x] The binding validates every length it accepts and errors rather than panicking, with a harness assertion per wrong-length input (§7, C.10) — **done (C.10)**
- [x] V.1 passes on real low-end Android hardware, or the spec has been amended — **passed 13 September 2026**, 2239 ms worst against a pre-registered 3000 ms (§8)
- [x] V.2 passes on real iOS Safari, or the chunk size has been amended — **passed; 256 KiB stands** (§8)
- [x] The encryption spec has been corrected to match the implementation exactly, with every ambiguity found during C.1–C.8 resolved in the document — **done, 13 September 2026.** Uniform pass over §0–§10 against the crate, with §7's unimplemented metadata pipeline as an unannounced control (correctly returned as not located). Zero divergences across 29 sections; five findings, all resolved _in the document_ rather than listed
- [x] Exported JSON vectors live in `spec/vectors/` and CI runs against them — **pending regeneration**: the spec now specifies 15 envelope categories and 7 protocol vectors and the committed file carries fewer
- [x] Repo skeleton exists, CI is green, `docker-compose` brings up Postgres and an S3-compatible store — **done, 13 September 2026.** CI runs a hermetic `checks` job and a `docker` job on every PR; the seeder's exit status is polled rather than slept on, and it now fails loudly rather than swallowing every error
- [x] API surface sketch written (B.6) — **all six parts, 13 September 2026.** 22 routes plus `/health`, each with a path, scheme, body, success shape and error list; §11.8 is the single enumeration. The checklist is superseded and deleted
- [x] Onboarding copy written (B.7) — **done**, brief §16

The sixth item is the one most likely to be skipped and the most valuable. You will find ambiguities. Fix the document, not just the code.

## 10. Explicitly not in Phase 0

No SvelteKit pages. No upload flow. No authentication implementation. No server endpoints beyond a health check. No thumbnail generation, no metadata stripping, no canvas rendering, no watermarking. No ffmpeg, ever, in this phase.

If it has a user interface, it is Phase 1.

## 11. Delegation map

**Yours, non-negotiably** — C.1 through C.8, the spec corrections, B.6, B.7. These are either the product itself or the places where a subtle error is unrecoverable, and writing them is how you come to understand your own system.

**Good Claude Code work** — B.1, B.3, B.4, B.5, the JSON export plumbing in C.9, the TypeScript smoke-test harness in C.10.

**Standing warning for delegated sessions:** any chat or agent without project context will suggest `crypto_secretstream` for chunked encryption, because in isolation that is the correct idiomatic answer. The spec forbids it for a reason — video seeking — that is invisible without the spec. Bootstrap every satellite session with the non-negotiables, and route contradictions back to the executive chat rather than resolving them locally.

## 12. Open questions blocking nothing but worth answering

- Weekly time budget — everything above is in sessions precisely so this isn't blocking, but it determines whether Phase 0 is three weeks or three months
- Access to a low-end Android device for V.1
- SvelteKit confirmed?
- Wordlist sourcing for Spanish/Catalan diceware (encryption spec §6.3) — needed by Phase 1, not Phase 0

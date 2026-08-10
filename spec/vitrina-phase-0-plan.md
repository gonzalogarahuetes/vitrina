# Vitrina — Phase 0 Detailed Plan

**Status:** Draft v0.1 · 6 August 2026
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
| C.10 | `wasm-bindgen` binding + TypeScript smoke test                                                  | The FFI boundary                                | —       |

**C.2's edge cases are where the bugs live.** Plaintext exactly `chunk_size`; exactly `chunk_size + 1`; a final chunk of one byte. Write those tests before the code.

**C.7 is the conformance gate, not a nice-to-have.** If you cannot decrypt chunk 400 of a video without having touched chunks 0–399, seeking is impossible and the whole chunked design was pointless. Test it explicitly and deliberately, by loading _only_ the header and one chunk's byte range from disk.

**C.9's negative vectors matter as much as the positive ones.** Tampered byte, swapped chunks, truncated asset with adjusted `plaintext_length`, altered version byte. An implementation that accepts reordered chunks passes every positive test and is broken.

---

## 8. Empirical validation

Two numbers in the spec are guesses that need evidence. Both are cheap to check once C.10 exists, and both change the spec if they fail — which is why they belong here and not in Phase 2.

**V.1 — Argon2id at 64 MiB, t=3, p=1, in a mobile browser WASM heap.** On a genuinely low-end Android phone, not a flagship and not a desktop. Measure wall-clock time and whether it completes at all. Acceptable is a few seconds; failing to allocate is a spec change. libsodium's `MODERATE` preset (256 MiB) is the thing we are avoiding, and this is the test that confirms we were right to.

**V.2 — decrypt and render a full album in mobile Safari.** Twenty photos at ~1600 px. Watch for tab crashes from memory pressure. If 256 KiB chunks are wrong, better to know before anything depends on them.

---

## 9. Exit criteria

Phase 0 is done when all of the following are true. Not "mostly."

- [ ] `crates/envelope` passes all ten vector categories from encryption spec §9, **including every negative case**
- [ ] Chunk _i_ decrypts given only the header and that chunk's bytes (C.7)
- [ ] The WASM module loads in a browser and round-trips a 3 MB buffer
- [ ] V.1 passes on real low-end Android hardware, or the spec has been amended
- [ ] V.2 passes on real iOS Safari, or the chunk size has been amended
- [ ] The encryption spec has been corrected to match the implementation exactly, with every ambiguity found during C.1–C.8 resolved in the document
- [ ] Exported JSON vectors live in `spec/vectors/` and CI runs against them
- [ ] Repo skeleton exists, CI is green, `docker-compose` brings up Postgres and an S3-compatible store
- [ ] API surface sketch written (B.6)
- [ ] Onboarding copy written (B.7)

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

# Vitrina — Track B Detailed Plan

**Status:** Draft v0.1 · 10 August 2026
**Supersedes:** `vitrina-phase-0-plan.md` §6
**Companion to:** `vitrina-project-brief.md`, `vitrina-phase-0-plan.md`

---

## 1. What Track B is for

Two things, and the second is the one that's easy to miss.

**Foundations.** A repo, CI, local infrastructure, a schema.

**Turning discipline into structure.** Non-negotiable #5 — access control and key wrapping live behind a real API boundary — is a rule you must remember if the repo has no `packages/server`, and a fact you'd have to work to violate if it does. Same for `media`-not-`photos` and the async status field. Track B is where several of the brief's rules stop depending on your memory.

Track B needs no Rust and no cryptography. It is deliberately the **low-cognitive-load** work, available on evenings when learning a language isn't. Given an erratic schedule, keeping this queue non-empty is what protects momentum.

## 2. Ordering and dependencies

```
B.1 skeleton ──┬── B.2 commit specs   (unblocks every Claude Code session)
               ├── B.3 CI             (easiest against an almost-empty repo)
               └── B.4 docker-compose ── B.5 migration

B.6 API sketch      ─┐
B.7 onboarding copy  ├─ independent of all the above; writing, not tooling
B.8 record decisions─┘
```

**B.2 first after B.1, and it is not optional.** `CLAUDE.md` instructs Claude Code to read `spec/vitrina-encryption-spec.md`. Documents uploaded to the Claude project are visible to _chats_, not to Claude Code reading your filesystem. Until the specs are committed, every Claude Code session is as blind as the Track A chat was — and that already cost a header layout reconstructed from memory.

**B.3 before Track C accumulates code.** Configuring CI against an almost-empty repo means any failure is your config. Configuring it against 500 lines of Rust plus a WASM build step means every failure is ambiguous.

## 3. The steps

### B.1 — Monorepo skeleton · _yours_

`pnpm` workspace plus `cargo` workspace, directories per brief §6 and the component table.

```
vitrina/
├── CLAUDE.md
├── README.md
├── crates/envelope/          # Cargo.toml name = "vitrina-envelope"
├── packages/web/             # SvelteKit
├── packages/server/          # Fastify
├── packages/shared/          # shared TS types
├── spec/
└── infra/
```

**Done when:** `pnpm install` and `cargo build` both succeed from the root, and the C.1 work has been moved into `crates/envelope/` rather than living in a standalone crate outside the workspace.

_Move C.1 in before it grows. Trivial today; mildly annoying once there are several modules, a `wasm-bindgen` target, and CI paths._

### B.2 — Commit the specifications · _yours, 5 minutes_

All five documents into `spec/`: brief, encryption spec, invite spec, roadmap, Phase 0 plan. Plus this document.

**Done when:** `CLAUDE.md`'s spec table resolves to real paths, and a Claude Code session launched in the repo can read the encryption spec without being handed it.

### B.3 — CI · _delegate_

Green on a near-empty repo, then kept green.

- `cargo test`, `cargo clippy -- -D warnings`, `cargo fmt --check`
- `pnpm lint`, `pnpm test`, `pnpm build`
- **A step that fails the build if `crypto_secretstream` appears anywhere in the tree.** Non-negotiable #3 as a failing build rather than a line in a document.

**Done when:** a pull request runs all of the above, and a commit adding the string `crypto_secretstream` to any file fails CI. Test that deliberately, then revert it.

_Deferred to later phases, but design CI so they slot in: running the exported JSON vectors (C.9), the WASM build (C.10), and the invite-spec §7 #3 assertion that no outbound request carries key material (Phase 1)._

_Context, not enforcement: `CLAUDE.md` is advisory. Anything that can become a failing build should._

### B.4 — Local infrastructure · _delegate_

`docker-compose` bringing up Postgres and an **S3-compatible object store**, with a documented one-command start and a seeded bucket.

The dependency is the **S3 API**, not any particular implementation. Two capabilities are load-bearing and must be verified rather than assumed:

- **HTTP `Range` requests.** The entire chunked envelope design rests on fetching one chunk's byte range from a single object (encryption spec §3.3).
- **Presigned URLs.** Needed for Phase 3 video delivery (brief §10.1), and for the `Cache-Control` reconnaissance below.

**`Cache-Control` reconnaissance — no longer blocking, still worth doing.** Brief §10.1 settles v1 on proxying, so `no-store` is enforced by the API and this does not gate Phase 1. It gates Phase 3. Two mechanisms, and the negative case is the point:

- Set `Cache-Control` as **object metadata** at upload (`CacheControl` on `PutObject`) and assert it comes back on a presigned `GET`. This is the stronger mechanism — nothing for a client to strip.
- Set it as a **per-request override** (`response-cache-control`) and assert it comes back.
- **Assert that tampering with the override in the query string returns 403.** If SeaweedFS serves a modified `response-cache-control` without a signature failure, the header is client-controllable and the mechanism is decorative — a recipient could strip `no-store` and let the browser cache ciphertext. This is the assertion that would change a design, and a happy-path test never reaches it.
- **Assert it survives a `Range` request** (206, not just 200). Real requests are ranged, and a store can implement overrides correctly for full responses and drop them for partial ones.

**Result (11 August 2026): all six cases pass against SeaweedFS 4.41**, giving fifteen tests in `infra/object-store.test.mjs`. Both mechanisms work; tampering and stripping both return `403 SignatureDoesNotMatch`; both survive range requests. Two additions worth keeping: tamper via raw string replacement rather than `URLSearchParams`, because `searchParams.set()` re-serialises the query and can re-encode the slashes in `X-Amz-Credential` — breaking the signature for a reason unrelated to the tamper and producing a false pass on the assertion that matters most; and asserting the mutation applied before asserting the status, so a no-op replace fails loudly. The design consequence is recorded in brief §10.1.

**Current implementation: SeaweedFS** (Apache-2.0). Its all-in-one server mode runs master, volume, filer, and S3 gateway in one process, which is sufficient for a dev dependency. _Chosen 10 August 2026, replacing MinIO — MinIO's community repository was archived on 25 April 2026 and receives no further security patches, and its successor AIStor is commercial with capacity-based pricing._

**Done when:** `docker compose up -d` gives you a reachable Postgres and a reachable S3 endpoint; a test writes an object, fetches a byte range of it through a presigned URL, and asserts the returned bytes are correct; and the README's development block matches reality.

_That test is not ceremony. An emulator approximately right about `Range` or presigned URLs would let bugs through to production, and this is the cheapest place to catch it._

### B.5 — Initial migration · _delegate, review yourself_

From brief §9. Tables: `owners`, `owner_tokens`, `albums`, `media`, `recipients`, `access_log`.

**There is no `access_tokens` table.** Recipient tokens live hashed on the `recipients` row; owners have their own table. See brief §9.1 — conflating them is the easiest way to leak album access.

Mark it **provisional** in a comment — Phase 1 will change it, and that's expected.

Non-negotiables this must respect:

- Table and column names use `media`, never `photos`
- `media.status` is an enum: `pending → processing → ready → failed`
- `media.kind` discriminator present from the start
- `recipients` holds a _hashed_ access token, never a plaintext one
- Nothing in the schema can store key material. `recipients.wrapped_key` holds a wrapped blob for passphrase recipients only; QR recipients store nothing
- No column ever holds a plaintext filename

**Done when:** it applies cleanly to the B.4 Postgres, and you have personally read every column against brief §9 and encryption spec §6.

### B.6 — API surface sketch · _yours_

A design document in `spec/`, not code. This is where non-negotiable #5 either happens or quietly doesn't.

Cover:

- **Routes** — owner auth, albums, media create/status, upload target, recipients create/revoke, recipient ciphertext fetch, access log
- **Two distinct auth schemes.** Owners hold account tokens. Recipients hold an invite access token and have no account at all. These are different mechanisms and conflating them is the easiest way to leak album access
- **Error shapes** — one consistent envelope, no internal detail leaking outward, and no field that echoes request content (non-negotiable #15)
- **Status code semantics** — `401` unknown or expired token, `403` valid-but-revoked recipient, `404` album genuinely absent
- **Range handling** — accepted forms, rejected forms, and the status code for each
- **Rate limiting** — keyed on the token hash rather than IP, with the reason
- **Upload path** — proxied in v1, and who sets `media.status` to `ready` on what evidence
- **Access log triggers** — which route writes `album_opened`, which writes `asset_viewed`, and why each is structurally once-per-event
- **`/v1` prefix** on every route except `/health`
- **CORS** — separate client and API origins from the start, per brief §11
- **A stated constraint that no endpoint may accept key material in any parameter, header, or body.** Write it down so a future route can be checked against it
- **A stated constraint that no endpoint deletes an album or owner row without having deleted its storage objects first.** `ON DELETE CASCADE` tidies rows and orphans every object in the bucket — including the record of which objects existed. See schema doc §5.1

**The proxy-versus-signed-URL question is now decided** — brief §10.1. Photos and thumbnails are proxied; signed URLs are deferred to Phase 3 video. B.6 records the consequences rather than reopening the choice:

- A chunk-fetch route that streams a byte range from object storage, forwarding `206` and `Content-Range` faithfully
- `Cache-Control: no-store` set by the API on every ciphertext response
- Revocation checked per request, and therefore genuinely immediate — the UI may say so without hedging
- `asset_viewed` recorded on an asset's **first** chunk request, never per chunk (schema §3)
- A note that a later per-asset signed-URL endpoint is additive, so nothing here forecloses Phase 3

**Done when:** the document exists in `spec/`, and someone could write the Fastify routes from it without asking you a question.

### B.7 — Onboarding copy · _yours, and don't defer it_

Three sentences a grandmother would understand, stating the guarantee **and its limit**.

Must convey: nothing lands on their device, nothing syncs to a cloud, nothing forwards with a tap, you can revoke it. Must not imply screenshots are prevented — see brief §3, which makes this a product rule rather than a preference.

**Done when:** three sentences exist and you'd be comfortable putting them in front of a data protection officer _and_ your own mother.

_Write them in one language now. Translation is Phase 1, and brief §15.3 gates each language on a fluent speaker confirming the guarantee and its limit both survive — a machine-translated guarantee is how §3 gets violated silently._

_If you can't do it in three sentences, the product isn't clear yet, and that's the finding — not a reason to write four._

### B.8 — Record decisions · _yours, 10 minutes_

Update brief §12 in place. SvelteKit and Fastify are both confirmed as of 11 August 2026, with the server choice following from the §10.1 proxy decision. License stays absent (all rights reserved) with the real deadline being the first external pull request. Hosting remains open and is low-stakes given the blind relay — though brief §10.1's proxying decision means egress now crosses your server, so it is slightly less low-stakes than it was.

**Done when:** brief §12 contains no decision that's actually been made.

_Keep this in the brief. Don't start a separate decision log — a second source of truth is exactly the drift this project keeps engineering against._

## 4. Explicitly not in Track B

A session told "set up the repository" will cheerfully scaffold far more than this. None of the following belongs here:

- Route implementations beyond a single health check
- Any authentication implementation — B.6 is a document
- SvelteKit pages, components, or layouts
- Any envelope or cryptography code (that's Track C)
- Production Dockerfiles, Terraform, Kubernetes, deployment of any kind
- An ORM, query builder schema, or generated client beyond the provisional migration
- Anything with a user interface — that is Phase 1

## 5. Energy map

| Step | Cost                                              | Needs focus? |
| ---- | ------------------------------------------------- | ------------ |
| B.1  | 1 session                                         | No           |
| B.2  | 5 minutes                                         | No           |
| B.3  | 1 session, delegable                              | No           |
| B.4  | Half a session, delegable                         | No           |
| B.5  | 1 session including your review                   | Review does  |
| B.6  | 1–2 sessions                                      | **Yes**      |
| B.7  | Half a session, and it will feel harder than that | **Yes**      |
| B.8  | 10 minutes                                        | No           |

B.1 through B.5 and B.8 are thin-evening work. B.6 and B.7 are not — they're design and writing, and doing them tired produces something you'll have to redo.

## 6. Track B exit

- [ ] `pnpm install` and `cargo build` succeed from the repo root
- [ ] `crates/envelope/` lives inside the cargo workspace
- [ ] All specifications committed to `spec/`
- [ ] CI green, and a `crypto_secretstream` commit demonstrably fails it
- [ ] `docker compose up -d` brings up Postgres and an S3-compatible store, with `Range` and presigned URLs verified by test
- [ ] Provisional migration applies, personally reviewed against brief §9
- [ ] API surface sketch in `spec/`, including the proxy-versus-signed-URL decision
- [ ] Three sentences of onboarding copy exist
- [ ] Brief §12 lists only genuinely open decisions
- [ ] README development block matches reality

B.7 is the one most likely to be skipped and the one whose absence you'd notice last. It is also the cheapest clarity test available in the whole project.

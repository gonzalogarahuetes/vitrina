# Vitrina

Private photo sharing built on a blind relay: the client encrypts before upload, the server only ever stores ciphertext it cannot read, and keys travel out of band. Currently Phase 0 — envelope crate, repo foundations, spec corrections.

## Canonical documents

`spec/` governs this repository. Those documents win over anything inferred from the code.

| File                              | What it covers                                                              |
| --------------------------------- | --------------------------------------------------------------------------- |
| `spec/vitrina-project-brief.md`   | **Canonical.** Threat model, promises, non-negotiables (§6), open decisions |
| `spec/vitrina-encryption-spec.md` | The envelope format. **Read in full before any work in `crates/envelope/`** |
| `spec/vitrina-invite-spec.md`     | Invite payload and its serialisations                                       |
| `spec/vitrina-phase-0-plan.md`    | Current work, the C ladder, and the delegation map                          |

They are not auto-imported. Read the ones relevant to the task at hand.

## Ownership — do not write this code

I implement the cryptographic layer myself, because a subtle error there is unrecoverable and writing it is how I understand my own system. Do not implement, complete, or "just fix" any of:

- The envelope implementation — Phase 0 plan §7, steps C.1 through C.8
- Key derivation, key wrapping, nonce construction, AAD construction
- The invite payload parser

Review, critique, failing-test suggestions, edge cases I've missed, and design discussion are all wanted. Finished implementations of the above are not, even if I ask for one in a moment of impatience.

Delegable: repo tooling, CI, `docker-compose`, migrations, the JSON vector export plumbing (C.9), the TypeScript smoke-test harness (C.10), and UI work once Phase 1 begins.

## Hard rules

1. **`crypto_secretstream_xchacha20poly1305` and every sequential-only streaming construction are forbidden.** Any chunk must be decryptable from the key, the header, and that chunk's bytes alone, so that video seeking works in Phase 3. This is the idiomatic answer to "how do I encrypt a stream" and it is the wrong answer here.
2. **The envelope format is permanent.** The relay cannot decrypt, therefore it cannot migrate. Never alter the format. If implementation suggests it should change, stop and say so.
3. **Key material never reaches the server** — not in URLs, query strings, headers, bodies, logs, error messages, telemetry, or `Debug` output. Invite key material belongs in the URL **fragment**; a `?` where a `#` belongs sends the album key to the relay in plaintext, works perfectly, and is catastrophic.
4. **Never claim the product prevents screenshots**, makes images uncopyable, or is DRM-protected. This applies to code comments and UI strings as much as to marketing.
5. **Watermarking stays client-side.** Moving it server-side would require a server that can decrypt.
6. **The domain object is `media`, not `photos`** — schema, routes, types. It carries a `kind` discriminator and a status field (`pending → processing → ready → failed`).
7. **Access control and key wrapping live in `packages/server`**, never inside SvelteKit page routes. The web app is one client of the API, not its owner.

If a task appears to require breaking one of these, stop and say so rather than resolving it locally.

## When the spec is ambiguous

It will be — it was written before implementation. Flag the ambiguity, propose what you think is right, and note it needs recording in the document. Never silently pick an interpretation. A spec that has drifted from the code is worse than no spec.

## Conventions that aren't guessable from the code

- Every integer in the envelope format is **little-endian**.
- **Asset and thumbnail ciphertext** goes to S3-compatible object storage, **one object per asset**, never into Postgres. The rule is about size and access pattern: those objects are large and range-requested. **Encrypted metadata blobs are the exception** — a few hundred bytes, always bulk-fetched with their album, so they live in a binary column on the `media` row (encryption spec §7).
- Chunk offsets are computed arithmetically, never discovered by scanning. That property is load-bearing.
- Filenames, EXIF, and GPS are stripped client-side before encryption. Plaintext filenames must never reach the server, including as object keys.

## Before reporting anything done

Run the relevant suite — `cargo test` for Rust, `pnpm test` for TypeScript. Do not describe work as complete against an unrun or red suite.

## Scope

Phase 0 only. Nothing from Phase 1 onward unless I explicitly ask. Nothing from Phase 3 (video) or Phase 4 (native) gets built early — the non-negotiables exist so that waiting costs nothing.

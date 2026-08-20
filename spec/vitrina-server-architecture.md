# Vitrina — `packages/server` architecture

**Status:** Settled v1 · 12 August 2026 · moved to `spec/vitrina-server-architecture.md` on 12 August 2026, from `packages/server/ARCHITECTURE.md` · reconciled against the code 12 August 2026 (§9)
**Companion to:** `vitrina-project-brief.md` (non-negotiable #5), `vitrina-schema.md`, `vitrina-api-sketch.md` (B.6)
**Scope:** the internal shape of the Fastify server package. It says nothing about *which* routes exist or what they do — that is B.6. It says where the code for any route is allowed to live.

---

## 0. Why this document exists

Non-negotiable #5 is a rule you have to *remember* if the server is a flat pile of route files, and a fact you have to *work to violate* if it has a boundary built in. This document is that boundary written down, so that a delegated session adding a route in three months puts access-control and key-wrapping logic where the framework merely calls it, rather than inside a page-rendering route. Everything here follows from #5; the rest is consequence.

If this document and the code ever disagree, that is a bug in one of them. The lint rule in §6 is what stops them drifting silently.

## 1. The dependency rule

Imports point inward only:

```
adapters ──▶ application ──▶ domain
```

Never back. `domain/` imports nothing but itself. `application/` imports `domain/` and its own port interfaces. `adapters/` may import anything inward. Nothing in `domain/` or `application/` may import `fastify`, `pg`, the aws-sdk, or anything under `adapters/`.

This is the whole design. The layout below is just this rule made into directories.

## 2. The graph

```
packages/server/
├── src/
│   ├── domain/                       # pure. no fastify, no pg, no aws-sdk, no upward imports
│   │   ├── owner/                    # Owner + owner tokens
│   │   ├── album/
│   │   ├── media/                    # entity + status state machine: pending → processing → ready → failed
│   │   ├── recipient/                # qr vs passphrase; revocation
│   │   ├── access-log/
│   │   └── shared/                   # value objects crossing aggregates (MediaId, TokenHash, timestamps)
│   ├── application/
│   │   ├── ports/                    # DRIVEN ports only — interfaces the core needs (empty files today, §7)
│   │   │   ├── owner-repository.ts
│   │   │   ├── album-repository.ts
│   │   │   ├── media-repository.ts
│   │   │   ├── recipient-repository.ts
│   │   │   ├── access-log-repository.ts
│   │   │   ├── object-store.ts       # getRange / put / delete — vendor-neutral
│   │   │   ├── token-hasher.ts       # SHA-256 of a 32-byte token (NOT Argon2id, NOT envelope crypto)
│   │   │   └── clock.ts
│   │   └── use-cases/                # one file per use case; a factory function taking a deps object
│   ├── adapters/
│   │   ├── driving/
│   │   │   └── http/                 # Fastify is confined to this subtree, and only this subtree
│   │   │       ├── server.ts         # buildServer({config, useCases}): Promise<FastifyInstance>
│   │   │       ├── routes/
│   │   │       │   └── health.ts     # the only Phase 0 route, and unversioned
│   │   │       ├── schemas/          # per-route JSON Schema — the audit surface brief §12 rests on
│   │   │       ├── dto/              # wire ⇄ domain mapping; DTOs live here, never in domain/
│   │   │       ├── auth/             # owner-token vs recipient-token, kept as two things
│   │   │       └── error-envelope.ts # one shape; setErrorHandler + setNotFoundHandler choke point (#15)
│   │   └── driven/
│   │       ├── postgres/             # one repository implementation per port
│   │       ├── object-store/         # S3 / SeaweedFS behind object-store.ts
│   │       └── hashing/              # token hasher
│   ├── composition-root.ts           # the ONLY file importing both a port and its concrete adapter
│   ├── config.ts                     # env read and validated once, at boot — not at import time
│   └── index.ts                      # read config → build adapters → build use cases → buildServer → listen
├── migrations/                       # exists: 001_initial_schema.sql
├── eslint.config.js                  # the dependency rule as a failing build — §6
└── test/                             # hermetic: app.inject(), no Docker, no network
```

`config.ts` sits beside `index.ts` rather than under `domain/`, `application/` or `adapters/`, because it belongs to none of them — it is bootstrap. It exports a function rather than a populated object, which is not cosmetic: a module-level parse runs on import, and then every test that so much as imports the HTTP adapter needs the environment set. Failing fast on a missing origin is right; doing it before `main()` has been entered is not.

`buildServer` takes `{ config, useCases }` rather than `useCases` alone because the allowlisted CORS origin is configuration, not a use case. It takes the narrowest slice it can — the client origin only. Host and port belong to `index.ts`, which does the listening; an adapter that cannot see them cannot come to depend on them. It returns a `Promise` because `@fastify/cors` must be registered with `await` **before** any route: the plugin installs an `onRequest` hook, and hooks apply only to routes registered after them. That ordering is load-bearing and easy to lose in a tidy-up.

## 3. Layer responsibilities

**`domain/`** — entities, value objects, and the invariants that hold regardless of transport or storage: the `media.status` state machine, the qr-vs-passphrase distinction and what each may carry, revocation as a domain concept. No I/O, no framework, no DTOs. This is where the access-control *decisions* live (whether a caller may see an album), separate from the HTTP mechanics of *authenticating* the caller.

**`application/`** — use cases orchestrating the domain across ports, plus the driven-port interfaces themselves. A use case knows *what* must happen (fetch the media row, check scope, stream the range, write the log); it does not know Postgres or SeaweedFS exist. Ports are named for the need — `ObjectStore.getRange`, not `SeaweedFSClient` — which is what made the MinIO→SeaweedFS swap a one-file change.

**`adapters/driving/`** — things that drive the app. Today: the Fastify HTTP adapter. This is the *only* place `fastify` may be imported. Routes translate a request into a use-case call and a result into a response; they hold no business logic.

**`adapters/driven/`** — things the app drives: repository implementations, the object-store client, the token hasher. Each implements a port from `application/ports`.

## 4. The five locked decisions

Recorded with reasoning because the reasoning is the part that stops each being "improved" later.

1. **Layer-first at the top, aggregate-second inside.** Not bounded-context-first. One context, a few aggregates — context-first is ceremony at this size. Refactors cleanly if a second context ever appears.

2. **One aggregate per repository; no god-`Album` that eager-loads its media.** Owner, Album, Media, Recipient, AccessLog are each their own aggregate with its own repository, referencing each other by id. This matches the schema and its indexes; an Album that loads a hundred media rows to open is wrong for the exact read paths the schema is built around.

3. **Driven ports only. No driving ports.** Routes call use-case functions directly. Primary-port interfaces for a private API this size are indirection with no second implementation behind them. The driven ports earn their keep; the driving ones would not.

4. **A use case is a factory function `(deps) => (input) => Promise<result>`, not a class.** Low-ceremony DI, trivially faked in tests, no framework. Chosen once here so it is not re-decided per file. Classes would also work; consistency is the point.

5. **DTOs and JSON Schemas are adapter concerns, in `driving/http`, never in `domain/`.** `packages/shared` carries only wire-format types genuinely shared with the SvelteKit client (the invite payload, response shapes) — domain entities never go there. Leaking a domain entity into `shared/` is how the web app quietly becomes the API's owner instead of one of its clients (#5).

## 5. The composition root

`composition-root.ts` is the only file that may name a concrete adapter. It constructs the adapters, injects them into the use-case factories, and hands the finished use cases to `buildServer`. Everything above it depends on interfaces; nothing above it can name a vendor. `buildServer` receives use cases and configuration, never repositories — so the web app, and any future native client, is one caller of the API rather than its owner.

In Phase 0 the root wires exactly one route — `health` — through this path. It is deliberately over-built for one route: the shape is the point, not the current contents.

## 6. Enforcement

The dependency rule is not advisory. **It exists as a failing build** in `packages/server/eslint.config.js`, and runs in CI's hermetic `checks` job via `pnpm lint`. This is the same move as the `crypto_secretstream` gate: a rule that can become a failing build should. The moment the boundary can fail CI it stops depending on anyone's memory.

`no-restricted-imports`, scoped per layer with flat config's `files`, so each layer is told only what it may not reach for:

- `src/domain/**` may not import `**/adapters/**` or `**/application/**`, nor name a vendor, nor name `@vitrina/shared`.
- `src/application/**` may not import `**/adapters/**`, nor name a vendor, nor name `@vitrina/shared`.
- `@vitrina/shared` is restricted because it carries wire-format types, and §4 decision 5 makes DTOs an adapter concern. Applied to `application/` as well as `domain/` on the config's own principle — easier to loosen a rule that fired wrongly than to notice a boundary that quietly stopped existing. If a use case ever has a genuine reason to name a wire type, deleting a line is how that decision gets made out loud.
- The vendor list is `fastify`, `@fastify/*`, `pg`, `pg-*`, `aws-sdk`, `@aws-sdk/*`. Both aws-sdk spellings are listed because v2 and v3 differ; `pg-*` catches the driver's sub-packages.

Two things about that file are not preference and should not be tidied:

- **It uses `@babel/eslint-parser`, not `@typescript-eslint/parser`.** typescript-eslint 8.67 refuses to load against TypeScript 7.0 — support for >= 7.1 is still open upstream. Babel parses TS syntax without consulting the compiler, so the boundary rule is insulated from that churn. The trade is that type-aware rules are unavailable here, which is irrelevant to a rule that reads import specifiers only; `tsc --noEmit` covers types. Revisit when typescript-eslint catches up.
- **It deliberately does not spell out the identifier `scripts/check-forbidden-constructions.sh` greps for.** That script scans `crates/` and `packages/`, so naming the banned construction inside `packages/` would fail CI unconditionally. The ban is written down in `spec/` and `CLAUDE.md`, which are outside the search, and that is the only reason it can be written down at all.

The rule was verified by deliberately violating it and reverting, per the discipline track-b-plan §3 B.3 applies to the crypto gate: "Test that deliberately, then revert it."

## 7. What Phase 0 puts in this skeleton

Per phase-0-plan §10 and track-b-plan §4: the structure, the ports, the composition root, and a single `health` route. Nothing else. `auth/`, `dto/`, `driven/*` and every directory under `domain/` exist as empty directories that B.6's decisions drop into later — the skeleton is where those decisions will have obvious homes, not where they get made. No route implementations beyond health, and no authentication implementation, live here yet.

**The eight port files exist and are empty**, which is a deviation from "the ports as interfaces" above and is deliberate rather than unfinished. Writing them means settling repository query shapes and `ObjectStore.getRange`'s signature — application design that belongs to the API surface B.6 has not yet specified. An interface invented ahead of its use case is a guess that later routes have to argue with. The file paths are the commitment; the signatures are not Phase 0's.

Note that git does not track empty directories, so none of these appear in a diff. They exist on disk and are the reason a new route has an obvious home.

## 8. Load-bearing names

A few directory names are enforcing a non-negotiable rather than expressing taste, and should not be "tidied":

- `media/`, never `photos/` — non-negotiable #8, carried into the tree.
- `hashing/` is token hashing (SHA-256) only. There is no envelope crypto on the server; the relay never decrypts. Keep it visibly distinct from Argon2id, which the schema notes is not interchangeable with it.
- `object-store.ts` is a port, not a client. The vendor name lives only in `adapters/driven/object-store/`.
- `error-envelope.ts` is a single module for a reason: non-negotiable #15 — one error shape, so no route hand-rolls an error that echoes request content. It is wired through **both** `setErrorHandler` and `setNotFoundHandler`, and both are required: Fastify routes route-not-found through the second, not the first, so without it an unknown path returns Fastify's own body — which names the requested path and is a second error shape. See `vitrina-api-sketch.md` §1.2.
- `schemas/` is an audit surface, not boilerplate. Brief §12 chose Fastify partly because per-route JSON Schema makes "no endpoint accepts key material" checkable "by a test that walks the route table". That test only works if every route has an entry, which is why the most trivial route in the system gets one.

## 9. Reconciled with the code, 12 August 2026

§0 says that if this document and the code disagree, that is a bug in one of them. This section records the pass that closed the gaps rather than leaving the reader to find them: `buildServer`'s signature (§2), `config.ts` (§2), the ESLint rule moving from "add one" to "here it is" (§6), and the ports being empty files (§7). The api-sketch's own "deviations to be reconciled" list is what prompted it.

Two dangling references were removed. §2 and §8 cited non-negotiables **#26** and **#27**; brief §6 contains fifteen, and `git log -S` shows both numbers were introduced with this document, so neither ever resolved to anything. The rules they were reaching for are real and are now cited properly — #15 for the one-error-shape choke point, and brief §12's Fastify/JSON-Schema argument for `schemas/`. **If #26 and #27 were shorthand for something else, that intent is lost and worth restating.**

### Where the error-code union lives — settled 20 August 2026

**`packages/shared`.** `ErrorCode` and `ErrorBody` are declared in `packages/shared/src/index.ts` and imported by `adapters/driving/http/error-envelope.ts`, which is the first of the three candidates this section previously left open: the obvious reading of §4 decision 5, and the only one that does not admit a way for the client's copy and the server's to drift.

Recorded here rather than only in `vitrina-api-sketch.md` §1.4, because §9's own lesson was that errata living in the wrong document is worse than no errata — a reader who finds an OPEN question assumes it is still open.

**Decision 5 is now enforced in both directions, which it was not the day the union moved.** The boundary rule (§6) restricts `@vitrina/shared` from `src/domain/**` and `src/application/**`. A domain entity leaking into `shared/` is caught by review; a *wire type reaching `domain/`* was caught by nothing, and it is the direction that actually happens once `ErrorBody` is one import away from every file in the tree. Inert today — the only importer is the adapter where decision 5 puts it — and deliberately so: the rule is provision, not a response to a violation.

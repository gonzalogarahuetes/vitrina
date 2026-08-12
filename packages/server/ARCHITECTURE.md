# Vitrina — `packages/server` architecture

**Status:** Settled v1 · 12 August 2026 · intended path `packages/server/ARCHITECTURE.md`
**Companion to:** `vitrina-project-brief.md` (non-negotiable #5), `vitrina-schema.md`, the forthcoming `vitrina-api-sketch.md` (B.6)
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
│   │   ├── ports/                    # DRIVEN ports only — interfaces the core needs
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
│   │   │       ├── server.ts         # buildServer(useCases): FastifyInstance
│   │   │       ├── routes/
│   │   │       │   └── health.ts     # the only Phase 0 route
│   │   │       ├── schemas/          # per-route JSON Schema — the #27 audit surface
│   │   │       ├── dto/              # wire ⇄ domain mapping; DTOs live here, never in domain/
│   │   │       ├── auth/             # owner-token vs recipient-token, kept as two things
│   │   │       └── error-envelope.ts # one shape; setErrorHandler choke point (#15 / #26)
│   │   └── driven/
│   │       ├── postgres/             # one repository implementation per port
│   │       ├── object-store/         # S3 / SeaweedFS behind object-store.ts
│   │       └── hashing/              # token hasher
│   ├── composition-root.ts           # the ONLY file importing both a port and its concrete adapter
│   └── index.ts                      # read config → build adapters → build use cases → buildServer → listen
├── migrations/                       # exists: 001_initial_schema.sql
└── test/
```

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

`composition-root.ts` is the only file that may name a concrete adapter. It constructs the adapters, injects them into the use-case factories, and hands the finished use cases to `buildServer`. Everything above it depends on interfaces; nothing above it can name a vendor. `buildServer` receives use cases, never repositories — so the web app, and any future native client, is one caller of the API rather than its owner.

In Phase 0 the root wires exactly one route — `health` — through this path. It is deliberately over-built for one route: the shape is the point, not the current contents.

## 6. Enforcement

The dependency rule is not advisory. Add an ESLint boundary rule (`no-restricted-imports`, or `eslint-plugin-boundaries`) that fails the build when anything under `domain/` or `application/` imports from `adapters/`, `fastify`, `pg`, or the aws-sdk. This is the same move as the `crypto_secretstream` gate in CI: a rule that can become a failing build should. The moment the boundary can fail CI it stops depending on anyone's memory.

## 7. What Phase 0 puts in this skeleton

Per phase-0-plan §10 and track-b-plan §4: the structure, the ports as interfaces, the composition root, and a single `health` route. Nothing else. `routes/`, `auth/`, and `dto/` exist as empty directories that B.6's decisions drop into later — the skeleton is where those decisions will have obvious homes, not where they get made. No route implementations beyond health, and no authentication implementation, live here yet.

## 8. Load-bearing names

A few directory names are enforcing a non-negotiable rather than expressing taste, and should not be "tidied":

- `media/`, never `photos/` — non-negotiable #8, carried into the tree.
- `hashing/` is token hashing (SHA-256) only. There is no envelope crypto on the server; the relay never decrypts. Keep it visibly distinct from Argon2id, which the schema notes is not interchangeable with it.
- `object-store.ts` is a port, not a client. The vendor name lives only in `adapters/driven/object-store/`.
- `error-envelope.ts` is a single module for a reason: #15 / #26 — one error shape, wired through `setErrorHandler`, so no route hand-rolls an error that echoes request content.

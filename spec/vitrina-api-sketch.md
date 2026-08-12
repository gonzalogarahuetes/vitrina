# Vitrina — API Surface Sketch

**Status:** Draft · 12 August 2026 · **PR 1 only — cross-cutting concerns**
**Implements:** `vitrina-track-b-plan.md` §3 B.6
**Companion to:** `vitrina-project-brief.md`, `vitrina-schema.md`, `vitrina-server-architecture.md`

---

## 0. Scope, and what this document is not yet

B.6 is being written in four parts. **This document currently covers PR 1 only:**
the cross-cutting rules that every route obeys regardless of what it does.

| PR | Covers | Status |
| -- | ------ | ------ |
| 1  | Error envelope, `/v1`, CORS, the two standing constraints, open questions | **this document** |
| 2  | Owner and recipient authentication; `401`/`403`/`404` semantics; token lifetimes | not written |
| 3  | Owner flow — albums, media create/status, upload target, recipients create/revoke | not written |
| 4  | Recipient flow, ciphertext delivery, `Range` handling, access log, rate limiting | not written |

Nothing here specifies a route path or a request/response body other than
`/health`. Where a rule below mentions a later route it is describing a
constraint that route will inherit, not designing it.

vitrina-server-architecture.md is the companion to this document and does not overlap with it:
it says where the code for any route is allowed to live; this says what every
route must do. Neither says which routes exist. That is PRs 2–4.

**Done-when, from track-b-plan §3 B.6:** "someone could write the Fastify routes
from it without asking you a question." For PR 1's scope that bar is met — the
error handler, CORS setup and route registration exist and are tested. It is not
met for PRs 2–4, and deliberately so.

---

## 1. The error envelope

**One shape, every error, no exceptions.**

```jsonc
{
  "code": "ALBUM_REVOKED",        // stable, machine-readable, the client's contract
  "message": "This access has been revoked.", // developer-facing English
  "details": { "field": "album_id" }          // optional, machine-readable
}
```

Implemented at `packages/server/src/adapters/driving/http/error-envelope.ts`, as
a single module wired through `setErrorHandler` **and** `setNotFoundHandler`.
vitrina-server-architecture.md §8 keeps it in one module so no route can hand-roll an error.

### 1.1 `code` is the contract; `message` is never generated

`code` is the only field a client may branch on. It is a closed union in the
implementation, and its HTTP status comes from one table:

| `code` | Status |
| ------ | ------ |
| `VALIDATION_FAILED` | 400 |
| `UNAUTHENTICATED` | 401 |
| `ALBUM_REVOKED` | 403 |
| `NOT_FOUND` | 404 |
| `RATE_LIMITED` | 429 |
| `INTERNAL` | 500 |

That table is the whole set as of PR 1. PRs 2–4 will add to it; the statuses
those codes imply are those PRs' to settle, not this section's.

**An unregistered code does not compile.** The `code → status` map and the
`code → message` map are both keyed by the same union, so adding a code to one
without the other is a build failure, and throwing an unlisted code is a build
failure at the throw site. An earlier draft used a `Record<string, number>` with
a `?? 400` fallback, which meant a code added in PR 2 without a status entry
returned `400` instead of `401` — working, plausible, and wrong. That is the same
failure shape brief §10.1 records for the forgotten `no-store` header, and it is
why the fallback is gone rather than merely documented.

### 1.2 Errors carry no stack traces, no internal exception text, and no request content

Non-negotiable #15 (brief §6): _"No error response ever echoes request content. A
validation error that helpfully returns the offending value is how key material
reaches a response body and then a log."_

The rule is enforced **structurally**, not by review:

- **`message` is looked up from `code` and is never taken from the thrown
  exception.** There is no code path from an `Error`'s own message to the response
  body. Someone who interpolates a request value into a throw cannot get it onto
  the wire.
- **Fastify's validation message is discarded entirely.** Fastify says
  `body/key must be string` — naming the field *and quoting its value*. The whole
  error is replaced with the constant `VALIDATION_FAILED` message; the detail
  goes to the log, where it is useful and not outward-facing.
- **Unrecognised errors are opaque outward and complete inward.** `500` responses
  carry `{code:"INTERNAL"}` and its constant message. The full error goes to
  `request.log.error`.
- **`details` may carry field *names*, never field *values*.** It is typed
  `Record<string, string>` and is for machine-readable context the client needs
  in order to act. Putting the offending input in it is exactly #15.
- **`cause` is logged and never serialised.** An `ApiError` may chain an
  underlying error for diagnosis; that chain does not reach the response.

**`setNotFoundHandler` is required, not optional.** Fastify routes
route-not-found through `setNotFoundHandler`, not `setErrorHandler`. Without it,
an unknown path returns Fastify's default body —
`{"message":"Route GET:/foo not found","error":"Not Found","statusCode":404}` —
which both echoes the request and is a second error shape. This was a live #15
violation in the first implementation. There is now a test asserting the
requested path does not appear in a 404 body.

### 1.3 Human-readable end-user copy lives in the client

Per brief §15.1: no route reads `Accept-Language`, and **no response contains
user-facing prose.** `message` is developer-facing English for whoever is reading
a network tab or a log; the **client** maps `code` to Spanish or Catalan in the
language the user chose.

A user-facing sentence in `message` would mean shipping i18n into the API and
knowing the caller's locale on every request, for no benefit. It would also put
the guarantee copy — which brief §15.3 gates on a fluent speaker's review —
somewhere nobody is reviewing it.

Every string in the `code → message` map is a constant with no interpolation,
which is what makes both properties checkable by reading one table.

---

## 2. Versioning

**`/v1` prefixes every route, registered exactly once at the mount point.** A
route file never writes the prefix itself; it is applied by a single
`app.register(routes, { prefix: "/v1" })` in the HTTP adapter.

**`/health` is unversioned** (track-b-plan §3 B.6). An uptime monitor should not
have to follow an API version. It reports that the process is up and nothing
more — it does not check Postgres or object storage, because a readiness probe
that fails when a dependency blips gets a healthy process restarted, and no such
probe has been specified.

**This does not foreclose Phase 3.** Brief §10.1 records that a later per-asset
signed-URL endpoint "sits alongside the chunk endpoint rather than replacing it",
and a single `/v1` mount point takes an additional route additively. Signed URLs
arriving in Phase 3 need no `/v2` and no change to this section.

---

## 3. CORS

**The client and the API are separate origins from the start.** Brief §11 records
why this is more than hygiene: serving the client from a different origin than
the relay API means compromising the relay does not compromise the code, which is
one of the few partial mitigations available for "the delivered bundle cannot be
verified against the source".

| Setting | Value | Why |
| ------- | ----- | --- |
| `origin` | exactly one allowlisted origin, from config | Never `*`, never `true` |
| `credentials` | `false` | Token in an `Authorization` header, not a cookie — §3.2 |
| `methods` | `GET`, `POST`, `DELETE` | Narrow to what the route table needs |
| `allowedHeaders` | `Authorization`, `Content-Type`, `Range` | `Range` is **not** CORS-safelisted |
| `exposedHeaders` | `Content-Range`, `Accept-Ranges`, `Retry-After` | Not safelisted; the client cannot read them otherwise |
| `maxAge` | `7200` | Preflight cache; 7200s is the maximum Chrome honours |

**One origin per environment, supplied as configuration, validated at boot.** The
value is parsed with `new URL`, rejected unless `https` or `localhost`, and
rejected if it carries a path, query or fragment. `Access-Control-Allow-Origin`
must be a bare origin with no trailing slash; a value that carries one produces a
header that never matches, and the browser reports it as an opaque CORS failure
with nothing logged server-side. Validating at boot means the error names the
actual problem instead of surfacing in someone's console.

### 3.1 Why `Range` and the range response headers are load-bearing

`Range` is not a CORS-safelisted request header, and `Content-Range` and
`Accept-Ranges` are not safelisted response headers. Without all three entries
above, **the PR 4 chunk-fetch route cannot work cross-origin at all** — the
browser would hide exactly the headers the client needs in order to compute the
next chunk's byte range (encryption spec §3.3).

`Access-Control-Max-Age` is in the table for the same reason. Because `Range` is
not safelisted, every ranged GET is a preflighted request, so without a preflight
cache each chunk fetch costs an extra OPTIONS round trip — on the mediocre
connection brief §10.1 explicitly targets, for the audience least able to absorb
it.

### 3.2 `credentials: false` is a decision, not a default

Brief §6 #6 permits that "a cookie may carry the token in the browser". This
says it will not: the token travels in an `Authorization` header. That keeps the
server stateless as #6 requires and sidesteps CSRF entirely.

**Recorded because PR 2's auth mechanics inherit it.** Reversing it later means
setting `credentials: true`, keeping the wildcard-free origin (already the case),
and deciding `SameSite` — so it is cheaper to disagree now than after PR 2.

---

## 4. Standing constraints

Two rules that hold for every endpoint in every later PR. They are written here
so that a future route can be checked against them.

### 4.1 No endpoint accepts key material in any parameter, header, or body

**CONSTRAINT.** No route may accept `K_album`, any derived key, a passphrase, or
a derived KEK — not in a path segment, query parameter, header, request body,
or multipart field.

This is non-negotiable #15 pointed inward, and encryption spec §2.2 states the
outward half: key material must never reach the relay "in any form, by any path.
This includes error reports, crash dumps, telemetry, analytics, and log lines."

What the server legitimately holds for passphrase recipients is the *wrapped*
blob and its parameters — `wrapped`, `wrap_nonce`, `kdf_salt` and the three
Argon2id integers (schema §3). A wrapped blob is not key material. QR recipients
store nothing at all (encryption spec §6.1).

**The checkable form of this constraint** is brief §12's reason for choosing
Fastify: per-route JSON Schema makes it "auditable by a test that walks the route
table". That test does not exist yet and cannot until there are routes; the
`schemas/` directory and the `/health` schema exist so the pattern is established
before there are routes where it matters.

**Note the boundary this constraint does not cover.** Invite spec §2.1 puts
`token` and `key` in the URL **fragment** precisely because fragments are never
transmitted to the server. A `?` where a `#` belongs sends `K_album` to the relay
in plaintext, works perfectly, and is catastrophic. That is a client-side rule;
this constraint is the server-side backstop, not the primary defence.

### 4.2 No endpoint deletes an album or owner row before its storage objects

**CONSTRAINT.** Deleting an album or an owner MUST be an application operation
that enumerates the media, deletes the storage objects, verifies, and only then
deletes the rows — or soft-deletes and reconciles with a worker. Never a raw
`DELETE`.

Schema doc §5.1 names this a B.6 requirement and states why: `ON DELETE CASCADE`
is on every foreign key, and a cascade deletes rows without touching the bucket.
Two consequences, the second serious:

- You keep paying to store data you believe is gone.
- **You have failed to erase the image data while reporting success** — a GDPR
  erasure failure with a false confirmation attached.

Cascade makes it worse rather than better, because the rows it removes are the
only record of which objects existed: `media.id` *is* the object key (brief §9.2),
so once the row is gone the ciphertext is unreachable and undiscoverable except
by enumerating the whole bucket.

`ON DELETE CASCADE` is a referential-integrity net for rows, not the mechanism of
erasure. Note that revoking a recipient deletes nothing — it sets `revoked_at` —
so this constraint concerns album and owner deletion only.

---

## 5. Open questions — not answered here

Three decisions are open. **Nothing in this document resolves, assumes, or
designs around any of them**, and nothing in PR 1's implementation depends on a
particular answer.

### 5.1 How does an owner retain `K_album`? (brief §11)

An owner needs `K_album` every time they add photos to an existing album or mint
a new invite, so a memory-only key means losing your own album on a page refresh.
The candidates — a password-derived master key, device-local storage, or a
server-stored blob wrapped under a password-derived key — differ in whether they
reintroduce the offline-attack surface encryption spec §6.3 exists to manage,
this time against the owner's own password.

**Blocks Phase 1. Not a Phase 0 blocker.** Decide before the upload flow is
built. Coupled to §5.2 and §5.3.

### 5.2 The owner account model (brief §12)

Email required, or invite-only/self-hosted? `owners` currently carries only `id`
and `created_at`, so there is nothing to authenticate against (schema §3). Both
candidate models need a password column; neither is implied by the migration.

**Blocks PR 2**, which is why PR 2 is not written.

### 5.3 Do `albums.title` and `recipients.label` become encrypted? (encryption spec §10)

They are plaintext on the relay today, and §10 calls this "the sharpest
inconsistency in the product": _"Sofía's first birthday"_ and _"María"_ are a
child's name and a family member's name sitting readable in a database whose
entire pitch is that it cannot read anything.

It is not simply fixed because encrypting an album title means the owner cannot
see their own album list without holding the album key — which is §5.1.
**The two are coupled and must be decided together.**

Brief §15.1 is careful about this and does not settle it: no localisation applies
to either field, "and none would if they were later encrypted". If they do become
encrypted, the affected wire shapes are PR 3's, not PR 1's.

---

## 6. What PR 1 built, and what enforces it

Recorded so the next session can see which rules above are load-bearing code and
which are still prose.

| Rule | Enforced by |
| ---- | ----------- |
| One error shape | `error-envelope.ts`, wired through both `setErrorHandler` and `setNotFoundHandler` |
| No unregistered error code | Closed union across the `code → status` and `code → message` maps; compile error |
| `message` never derived from an exception | No code path exists from `Error.message` to the response body |
| 404 does not echo the request path | Test: asserts the requested path is absent from the body |
| One envelope shape, no Fastify defaults | Test: asserts exactly `code` + `message`, and that `error`/`statusCode` are absent |
| Exactly one CORS origin, never `*` | Config parsed and validated at boot; tests assert the allowlisted origin is echoed and a foreign one is not |
| `Range` permitted, range headers exposed, preflight cached | Tests on the OPTIONS preflight |
| `/health` unversioned | Test: `/v1/health` is 404 |
| Key material never in logs | `redact: ["req.headers.authorization", "req.headers.cookie"]` |
| Imports point inward only (vitrina-server-architecture.md §1) | `eslint.config.js` boundary rule; fails `pnpm lint` |
| No sequential-only streaming construction | `scripts/check-forbidden-constructions.sh` |
| §4.1 no key material in any parameter | **Prose only.** Needs the route-table test once routes exist |
| §4.2 no delete before storage objects | **Prose only.** Needs the delete use case, PR 3 |

The suite is hermetic — `app.inject()`, no Docker, no network — so it belongs in
CI's `checks` job, which the workflow keeps free of infrastructure on purpose.

### 6.1 Deviations from vitrina-server-architecture.md, to be reconciled

- **§2 records `buildServer(useCases)`.** It also needs the allowlisted CORS
  origin, which is configuration rather than a use case, so it takes
  `{ config, useCases }`.
- **§2's tree has no `config.ts`.** Configuration is read once at the composition
  root, in `src/config.ts`, per §2's own description of `index.ts`'s job
  ("read config → build adapters → …"). It is not read inside the HTTP adapter,
  and not at import time.
- **§7 says the skeleton contains "the ports as interfaces".** The eight port
  files are still empty. Writing them means designing repository queries and
  `ObjectStore.getRange`'s signature — application design belonging to PRs 2–4.

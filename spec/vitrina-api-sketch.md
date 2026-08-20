# Vitrina — API Surface Sketch

**Status:** Draft · 20 August 2026 · **PR 1 (frame) and PR 2 (auth model)**
**Implements:** `vitrina-track-b-plan.md` §3 B.6
**Companion to:** `vitrina-project-brief.md`, `vitrina-schema.md`, `vitrina-invite-spec.md`, `vitrina-server-architecture.md`

---

## 0. Scope, and what this document is not yet

B.6 is being written in five reviewable parts. **This document currently covers
PR 1 and PR 2:** the cross-cutting rules that every route obeys regardless of
what it does, and the authentication model that every route's contract assumes.

| PR | Covers | Status |
| -- | ------ | ------ |
| 1  | Error envelope, `/v1`, CORS, the two standing constraints, open questions | **§1–§6** |
| 2  | Both auth schemes and the full credential lifecycle of each — `/login`, `/logout`, recipients create and revoke | **§7** |
| 3  | Owner flow — albums, album details, album encrypted metadata, media create/status, upload | not written |
| 4  | The passphrase key-material route — the only route that returns key-adjacent material | not written |
| 5  | Ciphertext delivery, `Range` handling, the access log, rate limiting | not written |

**An earlier draft of that table described four parts**, with recipients
create/revoke inside PR 3's owner flow and delivery in PR 4. The split is now
five, for two reasons worth recording. Recipient create and revoke moved into
PR 2 because their rules are *credential* rules — a client-minted token, a hash
that must never arrive in plaintext, a revocation that must not cascade — and
they read as arbitrary next to album CRUD. And the passphrase key-material route
was isolated as PR 4 so that the one route in the system which hands out
key-adjacent material is not reviewed inside the largest diff in the set.

**Sections are appended in PR order and never renumbered.** Other documents cite
this one by section (`vitrina-server-architecture.md` §8 cites §1.2), so §1–§6
keep their numbers permanently and each later PR adds sections after them. That
is why the enforcement ledger in §6 — which is cross-cutting and grows with
every PR — sits *before* PR 2's material in §7 rather than at the end.

Where a rule in §1–§6 mentions a route defined in a later PR, it is describing a
constraint that route will inherit, not designing it.

vitrina-server-architecture.md is the companion to this document and does not overlap with it:
it says where the code for any route is allowed to live; this says what every
route must do and, from §7 onward, which routes exist.

**Done-when, from track-b-plan §3 B.6:** "someone could write the Fastify routes
from it without asking you a question." For PR 1's scope that bar is met — the
error handler, CORS setup and route registration exist and are tested. For PR 2
the bar is met on paper: §7 fixes paths, bodies, status codes and error codes for
five routes, and §6 records exactly which of its rules are code and which are
still owed. It is not met for PRs 3–5, and deliberately so.

---

## 1. The error envelope

**One shape, every error, no exceptions.**

```jsonc
{
  "code": "ACCESS_REVOKED",       // stable, machine-readable, the client's contract
  "message": "Access has been revoked.", // developer-facing English
  "details": { "field": "kind" }          // optional; field *names* only, never values
}
```

`details` is shown for shape only. **No code PR 2 registers ever carries it** —
§7.3 explains why the auth routes in particular are the wrong place for a
machine-readable hint.

Implemented at `packages/server/src/adapters/driving/http/error-envelope.ts`, as
a single module wired through `setErrorHandler` **and** `setNotFoundHandler`.
vitrina-server-architecture.md §8 keeps it in one module so no route can hand-roll an error.

### 1.1 `code` is the contract; `message` is never generated

`code` is the only field a client may branch on. It is a closed union in the
implementation, and its HTTP status comes from one table:

| `code` | Status | Registered by | First reachable |
| ------ | ------ | ------------- | --------------- |
| `VALIDATION_FAILED` | 400 | PR 1 | PR 1 — any schema failure, and framework 400s (§1.2) |
| `UNAUTHENTICATED` | 401 | PR 1 | PR 2 — missing, unknown, expired or revoked **owner** token (§7.3) |
| `INVALID_CREDENTIALS` | 401 | PR 2 | PR 2 — `POST /login` only (§7.5) |
| `ACCESS_REVOKED` | 403 | PR 2 | PR 3 — a revoked **recipient** on their own album (§7.3) |
| `NOT_FOUND` | 404 | PR 1 | PR 1 — unknown route; PR 2 adds out-of-scope album and recipient |
| `CONFLICT` | 409 | PR 2 | PR 2 — duplicate `id` or `token_hash` on recipient create (§7.7) |
| `PAYLOAD_TOO_LARGE` | 413 | PR 1 | PR 2 — `bodyLimit` on the first route with a body; PR 3's upload route depends on it |
| `UNSUPPORTED_MEDIA_TYPE` | 415 | PR 1 | PR 2 — `POST /login` with a `Content-Type` no body parser matches |
| `RATE_LIMITED` | 429 | PR 1 | PR 2 — the `/login` limiter (§7.6) |
| `INTERNAL` | 500 | PR 1 | PR 1 |

**"Registered by" means "the PR whose prose puts this code in the union" — not
"present in the union today."** Both columns are statements about *this document's*
scope; neither says anything about the implementation. Six of the ten rows are
specified here and absent from the code, three of them rows this table attributes
to PR 1, and **§6.2 is the only place that records which codes actually exist.**
Read a `PR 1` in this column as "PR 1 owes it", never as "PR 1 shipped it".

**Registered ≠ reachable, and the two columns are separated on purpose.** A code
belongs in the union as soon as some layer can produce the condition it names,
which for the framework 4xx (`413`, `415`) is the moment a route accepts a body —
not the moment someone writes a `throw`. §1.2 is why: an unmapped framework error
falls to `INTERNAL`, so a code registered late is a `500` in the meantime.

Four notes on the table itself:

- **`code → status` is a function, not a bijection.** `UNAUTHENTICATED` and
  `INVALID_CREDENTIALS` both carry `401` and that is deliberate: "your session
  ended, sign in again" and "check your details" need different client copy, and
  a client cannot branch on a status it shares with another condition. The
  inverse direction — status → code, needed only for framework errors — is
  therefore hand-written in §1.2 rather than derived.
- **`ACCESS_REVOKED`, not `ALBUM_REVOKED`.** Revocation lives on
  `recipients.revoked_at`; `albums` has no revoked state (schema §3), so a code
  naming the album names a domain concept the schema does not have. The name is
  fixed now, before any client translation key exists, because renaming
  afterwards is a breaking contract change. The sentence *"this album is no
  longer shared with you"* is the **client's** rendering of this code, in the
  recipient's language — never the API's `message` (§1.3).
- **`CONFLICT` is not in the B.6 checklist's list of codes this work adds.** It
  is added here because §7.7's create-recipient route has two `UNIQUE` columns a
  client can collide with, and neither `VALIDATION_FAILED` ("fix your input" —
  the input is fine) nor `INTERNAL` describes it. Flagged rather than slipped in.
- **`405` is deliberately absent.** Fastify routes a method mismatch to
  not-found unless that behaviour is enabled, so registering a code for it would
  be guessing at a response the framework does not produce.

PRs 3–5 may add to the table. The statuses those codes imply are those PRs' to
settle, not this section's.

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
- **Fastify's validation message is discarded entirely**, and **what reaches the
  log is a value-free projection, not the error.** Both halves are stated below,
  because an earlier version of this bullet got the reason right and the fact
  wrong, and the corrected fact does not weaken the rule.
- **Unrecognised errors are opaque outward and complete inward.** `500` responses
  carry `{code:"INTERNAL"}` and its constant message. The full error — stack,
  `cause` chain and all — goes to `request.log.error`. **This path is deliberately
  not sanitised** (see the note below).
- **`details` may carry field *names*, never field *values*.** It is typed
  `Record<string, string>` and is for machine-readable context the client needs
  in order to act. Putting the offending input in it is exactly #15.
- **`cause` is logged and never serialised.** An `ApiError` may chain an
  underlying error for diagnosis; that chain does not reach the response.

#### What a validation failure logs, and the claim that had to be corrected

**Correction of fact.** Earlier drafts of this section, and the comment in
`error-envelope.ts`, said Fastify's validation message names the offending field
*and quotes its value*. **It does not** — verified against `fastify@5.11.3` with
Fastify's default AJV configuration:

| Submitted | `message` | `params` |
| --------- | --------- | -------- |
| `{"email":"S3CRET"}` against `format: email` | `body/email must match format "email"` | `{"format":"email"}` |
| `{"kind":"S3CRET"}` against an `enum` | `body/kind must be equal to one of the allowed values` | `{"allowedValues":["a","b"]}` |
| `{"n":999}` against `maximum: 5` | `body/n must be <= 5` | `{"comparison":"<=","limit":5}` |

`instancePath` is a field name, `params` carries **schema-side** values only, and
Fastify's default `removeAdditional: true` strips an unexpected key rather than
erroring, so not even a client-chosen *key name* reaches the error. The value
never appears.

**The rule does not weaken, and the reason it does not is the point.** AJV's
`verbose: true` attaches the offending value to every error object as `data`. A
custom keyword, a changed message template, or a dependency bump can put the value
back, and nothing in CI would notice. So both rules stand independent of what AJV
happens to emit today:

- **Outward: the whole error is replaced** by the constant `VALIDATION_FAILED`
  message. Unchanged, and never contingent on a library default.
- **Inward: the log gets a projection built by us, never the error object.**
  `instancePath`, `keyword` and `schemaPath` from each entry of `error.validation`
  — field paths and rule names, which the `details` bullet above already treats as
  safe even on the wire. **Never `message`, never `params`, never `{err}`, never
  the body.** The cost is real and accepted: you read the schema alongside a field
  path instead of an English sentence.

**This binds the validation path only.** The `INTERNAL` path stays complete
inward, by the bullet above: an unrecognised error is logged whole because a stack
is the entire diagnostic value of a `500`. A request value reaching a log through
*that* path means someone interpolated one into a throw — which the first bullet in
this section neutralises for the **wire** and cannot neutralise for the **log**.
That asymmetry is worth naming rather than papering over: it is a throw-site
discipline, not something the handler can police, and sanitising the `INTERNAL`
path would trade the only real diagnostic a `500` has for a guarantee the handler
still could not make.

**§7.5 is where this stops being hygiene.** `POST /login`'s body is the first in
the system to carry a shared secret, and a validation failure on it is the one
place a body value and a log line meet. §6.2 owes the test, and because the rule
above is global rather than route-specific, that test asserts a property of *every*
route rather than of `/login` — no route author has to know their body is
sensitive. The code does not do this yet: `error-envelope.ts` currently logs
`{ err: error }`, which is safe under today's AJV and not safe by construction.

**`setNotFoundHandler` is required, not optional.** Fastify routes
route-not-found through `setNotFoundHandler`, not `setErrorHandler`. Without it,
an unknown path returns Fastify's default body —
`{"message":"Route GET:/foo not found","error":"Not Found","statusCode":404}` —
which both echoes the request and is a second error shape. This was a live #15
violation in the first implementation. There is now a test asserting the
requested path does not appear in a 404 body.

**Framework errors reach the envelope too, and must not all collapse to one
code.** `setErrorHandler` catches Fastify's own failures as well as ours, and
they are two classes, not one:

| What arrives | Maps to | Why |
| ------------ | ------- | --- |
| `error.validation` is present | `VALIDATION_FAILED` / 400, **constant** message | Fastify's own text names the field, and one AJV option away (`verbose: true`) carries the value too. Rather than depend on that, the whole error is dropped outward and projected to field-path-plus-keyword inward — see above |
| A `FastifyError` carrying a 4xx `statusCode` and no `validation` | the code registered for **that status** | `413` from `bodyLimit` → `PAYLOAD_TOO_LARGE`; `415` from an unsupported media type → `UNSUPPORTED_MEDIA_TYPE`; a framework `400` (malformed JSON body) → `VALIDATION_FAILED`; a framework `401`, if one ever arrives, → `UNAUTHENTICATED`, never `INVALID_CREDENTIALS` |
| Anything else, including a 5xx `FastifyError` | `INTERNAL` / 500 | Opaque outward, complete inward |

**The rule, stated as a rule:** a `FastifyError` with a 4xx `statusCode` maps to
a code meaning what that status means; only genuinely unrecognised errors become
`INTERNAL`. Collapsing the second row into `VALIDATION_FAILED` is *worse* than
the `500` those errors currently produce — a client that must retry with a
smaller body would be told to fix a field, and it would fix nothing.

Because §1.1's union is closed and `code → status` is a function, this mapping is
its hand-written inverse and every reachable framework 4xx needs its own
registered code — today `400`, `413` and `415`. **A 4xx arriving with no mapping
falls to `INTERNAL`, which is wrong and is meant to be:** it is the signal that
the union is missing an entry, and it is the reason the `?? 400` fallback §1.1
describes had to go rather than being merely documented.

**A test asserts that no framework error reaches `INTERNAL`** — exercising every
framework 4xx the route table can actually produce (an oversized body, an
unparseable `Content-Type`, a malformed JSON body) and asserting the response
code is the registered one. That test is what makes a missing union entry fail in
CI rather than in production. It is owed and not yet written; §6 records it as
such.

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

### 1.4 Where the `ErrorCode` union lives

`vitrina-server-architecture.md` §9 leaves this open and assigns it to "whoever adds the
second error code", naming PR 2 as the natural place. PR 2 adds five. **Decided
here:**

- **`packages/shared` owns the `ErrorCode` union and the `ErrorBody` wire type.**
  §1.3 makes `code` a client contract — the client maps it to Spanish or Catalan
  copy — and architecture §4's decision that DTOs and JSON Schemas are adapter
  concerns puts "wire-format types genuinely shared with the SvelteKit client" in
  `shared`. A closed union the client must exhaust
  is that, exactly.
- **The server keeps `code → status` and `code → message`**, both still keyed by
  the shared union via `satisfies Record<ErrorCode, …>`, so §1.1's compile-time
  closure is unchanged. Neither map is a wire type: the client never chooses a
  status, and `message` is developer-facing by §1.3.
- **`ApiError` stays server-side.** A throwable is not a wire shape, and putting
  it in `shared` would let the web app throw API errors — the beginning of the
  web app owning the API rather than calling it (non-negotiable #5).

The two rejected candidates — duplicating the list in the client, or generating
the client's copy — both admit a way for the two halves to drift, and the failure
they produce is a client with no copy for a code the server can already return.
**This needs recording in architecture §9**, whose OPEN item this closes.

---

## 2. Versioning

**`/v1` prefixes every route, registered exactly once at the mount point.** A
route file never writes the prefix itself; it is applied by a single
`app.register(routes, { prefix: "/v1" })` in the HTTP adapter.

**That mount point exists in code** — `server.ts` registers an empty `/v1`
context, and PR 2's five routes are the first to register inside it. Until they
do, the only thing living there is the test seam described in §6, which is why
§6's row for the prefix is honest about what is and is not asserted.

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
| `allowedHeaders` | `Authorization`, `Content-Type`, `Range` | **`Authorization` explicitly** — the Fetch standard makes it a *non-wildcard* header, so `*` would not cover it (§3.1) |
| `exposedHeaders` | `Content-Range`, `Accept-Ranges`, `Retry-After` | None is a safelisted *response* header; the client cannot read them otherwise |
| `maxAge` | `7200` | Preflight cache. 7200s is the maximum Chrome honours — not a claim about other browsers (§3.1) |

**One origin per environment, supplied as configuration, validated at boot.** The
value is parsed with `new URL`, rejected unless `https` or `localhost`, and
rejected if it carries a path, query or fragment. `Access-Control-Allow-Origin`
must be a bare origin with no trailing slash; a value that carries one produces a
header that never matches, and the browser reports it as an opaque CORS failure
with nothing logged server-side. Validating at boot means the error names the
actual problem instead of surfacing in someone's console.

### 3.1 The preflight cost, recorded honestly

**Correction to an earlier draft of this section**, which said `Range` is not
CORS-safelisted and concluded that every ranged GET preflights *because of*
`Range`. That is wrong on the first clause, and the conclusion happens to survive
for a different reason. Both halves are worth stating, because the wrong version
would send someone optimising in the wrong direction.

**`Range` *is* CORS-safelisted, for single byte ranges** — `bytes=X-Y` and
`bytes=X-`, which are exactly the forms PR 5's asset route accepts, and none of
the forms it rejects. It stays in `allowedHeaders` anyway: the entry costs
nothing, it does not depend on a reader knowing the safelist's shape, and the
header must be listed for any form falling outside it.

**`Authorization` is not safelisted, and it is worse than that — it is a
*non-wildcard* header.** `Access-Control-Allow-Headers: *` does not cover it; it
must be named. So **every authenticated cross-origin request preflights**, which
in v1 is every request except `/health`. Not because of ranges — because of
bearer auth on a separate origin.

`Content-Range`, `Accept-Ranges` and `Retry-After` are none of them safelisted
*response* headers, so without `exposedHeaders` the browser hides them from the
client entirely. Two of the three are how the client computes the next chunk's
byte range (encryption spec §3.3); `Retry-After` becomes load-bearing in **PR 2**,
not PR 5, because the `/login` limiter (§7.6) is the first thing in the system
that can answer `429`, and a client that cannot read the header cannot back off
for the interval the server actually chose.

`Access-Control-Max-Age` is what keeps the preflight cost to one OPTIONS per URL
per cache window rather than one per request — on the mediocre connection brief
§10.1 explicitly targets, for the audience least able to absorb it. **`7200` is
the maximum Chrome honours.** It is deliberately not a claim about the maximum
any browser honours: WebKit's cap is materially lower, and rather than assert a
number from documentation, the real figure belongs to phase-0-plan §8's **V.2**,
which already puts a real iOS device in the loop for exactly this class of
question. If V.2 shows the preflight cache effectively not applying on iOS, that
is a measurement, not a config change.

**The cost is temporary, and that is worth stating** so nobody treats it as an
argument against origin separation. When Phase 3 introduces signed URLs (brief
§10.1), chunk fetches stop carrying `Authorization` — and because the safelisted
form of `Range` is precisely what PR 5 permits, those requests become
preflight-free entirely. The v1 overhead is a consequence of bearer auth on
proxied bytes, not of separate origins as such.

### 3.2 `credentials: false` is a decision, not a default

An earlier version of this subsection read "brief §6 #6 permits that a cookie may
carry the token"; **the brief has since narrowed #6 itself** — the transport is
`Authorization: Bearer` and cookies are not used. So this is no longer a decision
this document makes alone. What it records is the CORS consequence, and the
reason that consequence is unconditional:

**The objection to cookies does not depend on a future choice.** A cookie works
fine same-origin — but separate origins *are* the deployment (§3, brief §11), so
a cookie would need `SameSite=None; Secure`, `credentials: true` on both sides,
and CSRF protection that a bearer header does not need. `credentials: false` is
therefore a decision rather than a default, and it is recorded here because a
route author reading #6's first sentence alone might still conclude cookies are
on the table — and a cross-origin cookie failure surfaces as an auth bug several
layers from its cause.

**PR 2's auth mechanics inherit this**, and §7.2 states the transport rule from
the route side: `Authorization: Bearer`, never a query parameter, never a cookie.
Reversing it means setting `credentials: true`, keeping the wildcard-free origin
(already the case), and deciding `SameSite`.

**One loose end in the table above.** `methods` lists `DELETE`, and no route in
B.6's route surface uses it — §7.8's revoke is a `POST` on purpose (§7.8), and
album deletion (§4.2) has no route in the v1 surface at all. Narrow the list to
`GET, POST` when the route table is complete, or record why `DELETE` stays. It is
harmless either way; an entry nothing uses is just a claim about the route table
that is not true.

---

## 4. Standing constraints

Two rules that hold for every endpoint in every later PR. They are written here
so that a future route can be checked against them.

### 4.1 No endpoint accepts key material in any parameter, header, or body

**CONSTRAINT.** No route may accept `K_album`, any derived key, a passphrase, or
a derived KEK — not in a path segment, query parameter, header, request body,
or multipart field.

**This constraint and non-negotiable #15 are twins**, and the two should be cited
by number rather than by direction: an earlier version of this line said "#15
pointed inward", which reads either way round and tells a reader nothing. #15 is
the outward-facing half — *no error response ever echoes request content* — and
this section is the inward-facing half. Encryption spec §2.2 states the same rule
from the crypto side: key material must never reach the relay "in any form, by any
path. This includes error reports, crash dumps, telemetry, analytics, and log
lines."

**AMBIGUITY, needs recording in the brief.** The B.6 checklist cites the inward
rule as **non-negotiable #16**, and it is not there: brief §6 numbers exactly
fifteen, and #15 itself describes the inward rule without giving it a number
("the 'no endpoint accepts key material' rule pointed outward"). So the inward
half of a symmetric pair is the only one that cannot be cited. Citing "#16" today
would be another dangling reference of the kind architecture §9 had to clean up
(#26 and #27, which never resolved to anything). **Proposed:** add the inward rule
to brief §6 as **#16**, worded as the constraint in this section, and then this
section cites #15 and #16 as the pair. Until that edit lands, the citations here
are #15 plus encryption spec §2.2.

What the server legitimately holds for passphrase recipients is the *wrapped*
blob and its parameters — `wrapped`, `wrap_nonce`, `kdf_salt` and the three
Argon2id integers (schema §3). A wrapped blob is not key material. QR recipients
store nothing at all (encryption spec §6.1).

**The checkable form of this constraint** is brief §12's reason for choosing
Fastify: per-route JSON Schema makes it "auditable by a test that walks the route
table". **PR 2 is the first PR that gives that test something to walk**, and the
first that tests it against a route which legitimately accepts wrap material:
§7.7's create-recipient body carries `wrapped`, `wrap_nonce`, `kdf_salt` and the
three Argon2id integers, and must accept no passphrase and no KEK. A route that
accepts the wrapped blob is exactly where the difference between "wrapped blob"
and "key material" stops being a definition and becomes a schema.

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

**Blocks `POST /login`'s request body, and nothing else.** An earlier version of
this line said it blocks PR 2 outright, which is why PR 2 went unwritten longer
than it needed to. What §12 decides is *what a caller presents* — an email and a
password, or an invite code and a password. Every other property of that route is
independent of the answer and is settled in §7.5: the response shape, the two-week
window, the indistinguishability requirement, the rate limit, the status codes,
and the fact that whatever the body carries is a shared secret that must not be
logged. §7.5 therefore carries a **labelled gap** for the request body — a parked
§12 decision, not an unfinished sentence.

**The owner password's Argon2id parameters ride with this hole**, and must not be
filled in by default. Brief §9.3 says an owner password needs Argon2id and stops
there. The one Argon2id number written down anywhere in this project is the
passphrase wrap's 64 MiB (encryption spec §6.2), chosen for a **mobile WASM heap**
on a low-end Android phone — the opposite constraint from a server hashing under
concurrency, where the same figure is a per-request allocation an unauthenticated
caller can trigger (§7.6). Inheriting it would be choosing a server parameter
from a client benchmark. Decide it with §12, and note that §7.6's rate-limit
argument is deliberately written so that it holds whatever the number turns out
to be.

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

## 6. The enforcement ledger — what is code, and what is still prose

Recorded so the next session can see which rules above are load-bearing code and
which are only written down. **This table grows with every PR** and is the reason
§6 sits before §7 (see §0).

### 6.1 Enforced today

| Rule | Enforced by |
| ---- | ----------- |
| One error shape | `error-envelope.ts`, wired through both `setErrorHandler` and `setNotFoundHandler` |
| No unregistered error code | Closed union across the `code → status` and `code → message` maps; compile error |
| `message` never derived from an exception | No code path exists from `Error.message` to the response body |
| 404 does not echo the request path | Test: asserts the requested path is absent from the body |
| One envelope shape, no Fastify defaults | Test: asserts exactly `code` + `message`, and that `error`/`statusCode` are absent |
| The envelope reaches routes *inside* `/v1` | Test: a throwing route registered through `v1Plugins` returns `{code:"INTERNAL"}` and not Fastify's body. **Also the only assertion today that the `/v1` mount exists at all** — delete the mount and `/v1/boom` becomes a 404, so the test fails. That is coverage by side effect; §6.2 owes a direct one |
| Exactly one CORS origin, never `*` | Config parsed and validated at boot; tests assert the allowlisted origin is echoed and a foreign one is not |
| `Authorization` and `Range` permitted; `Content-Range`, `Accept-Ranges` and `Retry-After` exposed; preflight cached | Tests on the OPTIONS preflight. `Retry-After` was added in PR 2, not PR 5 — §7.6 is the first route that can answer `429` |
| `maxAge` claims only what it claims | Comment in `server.ts` reads "the maximum Chrome honours", not "the maximum useful value". Prose, but the wrong version is what invites someone to raise it |
| `/health` unversioned | Test: `/v1/health` is 404. **Note what this does not prove:** it passes whether the `/v1` mount exists or not |
| `Authorization` and `Cookie` headers never appear in logs | `redact: ["req.headers.authorization", "req.headers.cookie"]`. **This row used to claim "key material never in logs", which is more than two redacted headers deliver** — see §6.2 |
| Imports point inward only (vitrina-server-architecture.md §1) | `eslint.config.js` boundary rule; fails `pnpm lint` |
| No sequential-only streaming construction | `scripts/check-forbidden-constructions.sh` |

The suite is hermetic — `app.inject()`, no Docker, no network — so it belongs in
CI's `checks` job, which the workflow keeps free of infrastructure on purpose.

### 6.2 Owed — a rule in this document with no code behind it

Each row names the assertion, not just the gap, so that writing it is mechanical.

| Rule | What is owed |
| ---- | ------------ |
| §1.1 the six codes the union lacks | The union has **four** — `VALIDATION_FAILED`, `UNAUTHENTICATED`, `NOT_FOUND`, `INTERNAL`. §1.1 specifies **ten**. Owed: `INVALID_CREDENTIALS`, `ACCESS_REVOKED`, `CONFLICT` (PR 2's by §1.1's column) and `PAYLOAD_TOO_LARGE`, `UNSUPPORTED_MEDIA_TYPE`, `RATE_LIMITED` (PR 1's, and owed since PR 1). A `code → status` entry **and** a `code → message` entry each, or it does not compile. **An earlier version of this row called all six "the five codes PR 2 registers"**, which both miscounted and contradicted §1.1's attribution — the sort of drift the split columns exist to prevent |
| §1.2 no framework error reaches `INTERNAL` | A test driving every framework 4xx the route table can produce — oversized body → `413`, unmatched `Content-Type` → `415`, malformed JSON → `400` — and asserting the registered code, never `INTERNAL`. Until the codes above exist this test cannot pass, which is the point |
| §1.2 a validation failure logs a value-free projection | `error-envelope.ts` logs `{ err: error }` — safe under today's AJV defaults (§1.2's verified table) and not safe by construction. Owed: replace it with a projection of `instancePath`, `keyword` and `schemaPath` only. **This row and the `/login` row below are one change**, not two: applying either alone leaves the document contradicting itself |
| §1.4 the union lives in `packages/shared` | `ErrorCode` and `ErrorBody` are still in `error-envelope.ts`, reachable by no other package |
| §2 the `/v1` mount exists | A test that fails when the mount is removed *and* is not about error handling: register a probe route through `v1Plugins`, assert it answers at `/v1/<path>` **and** 404s at `/<path>`. The second half is what makes it about the prefix |
| §4.1 no key material in any parameter | **Prose only.** The route-table walk brief §12 promises. PR 2 gives it its first real subject: §7.7 accepts wrap material and must accept no passphrase |
| §4.2 no delete before storage objects | **Prose only.** Needs the delete use case, PR 3 |
| §7.2 no token in a query string | A test walking the route table asserting no route declares a `token`, `access_token` or `key` query parameter |
| §7.5 no request body reaches a log, on any route | The redaction list covers two *headers*. PR 2 introduces the first route whose **body** carries a shared secret. Nothing today logs a body — pino's default serialisers log method and URL — but nothing stops it either. Owed: a test that POSTs a distinctive secret to `/login`, captures the log stream, and asserts the secret is absent from every line. **Scoped to the validation and success paths, not `INTERNAL`** (§1.2): a secret reaching a log through a `500` means someone interpolated a request value into a throw, which is a throw-site bug the handler cannot police. Because §1.2's projection rule is global, this test states a property of every route, and the paired row above is what makes it pass |
| §7.6 the `/login` limiter | Not built. Note it is in-process state: correct on one instance, silently broken on two (PR 5 states this as a general property; it is true from the moment this limiter exists) |

**A subsection was deleted here.** PR 1 carried a "Deviations from
vitrina-server-architecture.md, to be reconciled" list — `buildServer`'s signature, the
missing `config.ts`, the empty port files. Architecture §9 reconciled all three
at source on 12 August 2026, so the list had become errata for a document that is
now correct, which is worse than no list: a reader who finds it assumes the
deviations are live. Deleted rather than annotated.

---

## 7. Authentication — two schemes, and the credential lifecycle of each

**PR 2.** Everything from here down is the auth model every later route's
contract assumes. It defines five routes; the routes that *consume* recipient
authentication begin in PR 3.

### 7.1 Two schemes, two tables, and no shared principal

Brief §9.1: owners hold account auth tokens in `owner_tokens`; recipients hold
one invite access token, hashed on the `recipients` row. There is no
`access_tokens` table and there must not be one — "a single shared token table
would invite treating them as one, which is the easiest way to leak album
access."

| | Owner | Recipient |
| --- | ----- | --------- |
| Where the hash lives | `owner_tokens.token_hash`, many rows per owner | `recipients.token_hash`, one row per invite |
| Who mints the token | **the server**, at `/login` (§7.4) | **the client**, before the invite exists (§7.4) |
| Expiry | `expires_at`, NOT NULL — two weeks, provisional (§7.5) | **none.** `revoked_at` only (§7.6) |
| Revocation | `POST /logout`, `POST /logout/all` | `POST /recipients/{id}/revoke` (§7.8) |
| Scope | every album where `albums.owner_id` is theirs | exactly one album, the row's `album_id` |
| Revoked, presenting the token | `401 UNAUTHENTICATED` (§7.3) | `403 ACCESS_REVOKED` (§7.3) |
| Recovery after loss | log in again | **none** — the owner mints a new invite |

**Each route declares which scheme it accepts, and no route tries both by
accident.** Both credentials are 32 random bytes in the same header, so nothing
in the request distinguishes them; the only thing that does is which table the
route looks in. A route that falls back from one table to the other is the shared
token table §9.1 forbids, rebuilt in code.

**Where a route genuinely serves both** — PR 3's album encrypted-metadata route
is called by owners and recipients alike — it declares both explicitly and
resolves to **exactly one** identity, represented as a tagged union rather than a
merged `principal`:

```ts
type Caller =
  | { kind: "owner";     ownerId: Uuid }
  | { kind: "recipient"; recipientId: Uuid; albumId: Uuid }
```

The tag is not decoration. An owner has no `albumId` and a recipient has no
`ownerId`, so a downstream check that forgot which kind it is holding does not
compile. A flattened `{ ownerId?, recipientId?, albumId? }` compiles perfectly
and is how a recipient ends up authorised by an owner's code path.

### 7.2 Transport: `Authorization: Bearer`, and nothing else

Both schemes present the token as `Authorization: Bearer <base64url>`.

**Never a query parameter.** A token in a query string lands in access logs, in
`Referer` headers on any outbound navigation, and in browser history. This is the
same class of mistake as invite spec §2.1's `?`-for-`#`, one layer out: it works
perfectly and it publishes the credential. §6.2 owes a route-table test asserting
no route declares a `token`, `access_token` or `key` query parameter.

**Never a cookie**, and `credentials: false` in the CORS config — brief §6 #6 as
narrowed, with the unconditional form of the argument in §3.2.

**No endpoint accepts a plaintext bearer token in a body either.** The header is
the only place a token is read from. The one place a token-shaped value appears in
a request body is §7.7's `token_hash`, which is a hash and not a credential.

**The base64url form is transport only.** The server decodes strictly, then
hashes the 32 raw bytes. **Schema §6's canonical-form rules** apply verbatim to
both schemes: exactly 43 characters, the base64url alphabet, no padding, decoding
to exactly 32 bytes, and **re-encoded and required to equal the input**. A
malformed token is rejected at the boundary with `401`, before any lookup, because
a value that is not a well-formed token cannot be one.

**Lookup is by hash, never by comparison.** The presented token is hashed and the
hash is looked up on a `UNIQUE` index; no code path compares two token strings or
two hashes byte by byte, so there is no comparison to time. **Schema §6's rule
against comparing token strings** applies everywhere else too — not as a cache
key, not for log deduplication, not for rate limiting (§7.6 keys on the hash for
exactly this reason).

**Neither citation above carries a number, deliberately.** An earlier version said
"schema §6, whose *four* rules apply" and then listed five clauses — miscounting
its own enumeration — and three lines later cited "schema §6 **rule 4**" for the
comparison rule. The ordinal happens to resolve correctly today, which is the
problem rather than the reassurance: it is correct by coincidence of numbering,
and schema §6 gaining a rule breaks it silently into a citation that reads as
authoritative and points at something else. That is the failure architecture §9
had to clean up as non-negotiables #26 and #27 — a reference resolving to nothing,
or worse, to the wrong thing. **A citation names the rule it means; only the
section gets a number.** "§6's rule against comparing token strings" survives a
renumber and is checkable by reading; "rule 4" is neither. Same reasoning as
carrying a section *title* alongside its number in the database comments.

**This applies to citations that cross a document boundary.** References into a
numbered list *inside this document* — §7.3's steps, cited in §7.5 and §7.7 — are a
different case: the list and its citation move in one diff, so a renumber cannot
land half-applied. They stay as they are. The rule was applied once more on sight,
to §1.4's "architecture §4 decision 5", which also resolved correctly and also did
so by coincidence of numbering.

### 7.3 `401`, `403`, `404` — and the order the checks run in

Track-b-plan §3 B.6 fixes the semantics: `401` unknown or expired token · `403`
valid but revoked **recipient** · `404` album genuinely absent. Three refinements
matter more than the list, because the natural implementation gets each wrong.

**A valid token for album A requesting album B returns `404`, not `403`.** So
does an owner requesting another owner's album. `403` confirms that B exists,
which is brief §9.1's "easiest way to leak album access" in one status code. The
implementation that gets this wrong is the obvious one: authenticate, load the
album, check ownership, return `403`.

**So scope is resolved before the status is chosen**, in this order:

1. **Parse and hash the token.** Malformed, absent, or no matching row → `401
   UNAUTHENTICATED`.
2. **Owner scheme only: check `expires_at` and `revoked_at`.** Either → `401
   UNAUTHENTICATED`.
3. **Resolve scope.** Is the requested album, media row or recipient row inside
   this caller's grant? No, or absent → `404 NOT_FOUND`. Indistinguishable by
   construction: the same code, the same status, and no `details`.
4. **Recipient scheme only: check `revoked_at`.** Set → `403 ACCESS_REVOKED`.

Step 4 sits after step 3 deliberately. A revoked recipient asking for **their
own** album must get `403`, because that is a state the client can explain; a
revoked recipient probing a **different** album must get `404`, the same as an
unrevoked one. Checking revocation first would answer `403` for both and confirm
the second album exists.

**A revoked owner token is `401`, not `403`** — the same word, a different code,
because the recovery paths differ. An owner logs in again; a revoked recipient can
do nothing at all. `403` would tell a parent whose session was signed out that
they are forbidden, and the client would render the wrong sentence.

**No error in this PR carries `details`.** Every code here is actionable from the
code alone, and on these routes `details` is precisely where a distinguishing hint
leaks: a field name on `INVALID_CREDENTIALS` would say which half was wrong
(§7.5), and a field name on `CONFLICT` would say which `UNIQUE` column collided
(§7.7). `details` stays for the routes where a client must know *which* field to
fix, and PR 2 has none.

**`401` responses carry `WWW-Authenticate: Bearer` with no parameters.** No
`realm` — it would name the deployment — and no `error_description`, which is
where RFC 6750 invites exactly the echo #15 forbids. The header is not in
`Access-Control-Expose-Headers`: the client branches on `code`, not on this
header, and there is no reason to hand it a second source of truth.

### 7.4 Who mints the token, and why the two answers differ

**Owner tokens are server-generated. Recipient tokens are client-generated.**
Stated side by side because the asymmetry is load-bearing and reads as an
inconsistency otherwise — someone who meets only the recipient rule builds a
`/login` where the client chooses its own session token.

**The recipient token must be client-minted** because it has to be embedded in an
invite the relay never sees (invite spec §1). The client generates the 32 bytes,
puts them in the payload's `token` field, hashes them, and sends **only the hash**
(§7.7). It already generates `recipients.id`, `wrapped`, `wrap_nonce` and
`kdf_salt`, so `token_hash` joins an existing set rather than starting one.

The alternative — POST the token, let the server hash it — would put a live bearer
credential through the component this entire architecture is built around not
trusting, on a write path where logging is at its most verbose. It is not key
material, so §4.1 does not cover it, which is the reason it is written here.

**The owner token has no such constraint**, so `/login` mints it server-side,
where entropy is guaranteed: 32 bytes from a CSPRNG, returned once in the response
body, stored only as SHA-256 (schema §6). The server never holds the plaintext
after the response is written.

### 7.5 Owner sessions

```
POST /v1/login
POST /v1/logout
POST /v1/logout/all
```

**Three routes, and deliberately no fourth.** **There is no refresh endpoint.**
`/login` issues, `/logout` revokes, and every request re-checks `expires_at` and
`revoked_at` (§7.3, step 2); a session ends by lapsing or by being revoked, and it
is renewed by logging in again. A refresh route would be the natural way to make
the two-week window shorter without adding friction — which is exactly why its
absence is written down rather than left to be inferred from a list of three
routes. Adding one is a decision about §5.1, not a convenience: it lengthens the
period in which a stolen token remains useful, and it is the first thing that
would make the window's provisional value (below) feel settled without anyone
having settled it.

**`POST /v1/login`** — no authentication. Response `Cache-Control: no-store`,
because the body carries a credential.

**That `no-store` extends brief §10; it does not restate it.** §10 requires the
header on *ciphertext* responses, and §10.1 sets it as object metadata at upload
time precisely so that no code path can forget it. A `/login` response is neither
ciphertext nor an object, so nothing in §10 reaches it — this is §10's *reasoning*
applied to a second kind of body that must not be cached, a bearer token rather
than an encrypted photograph. Two consequences worth stating. It is set by the
handler, so unlike §10.1's object metadata it **can** be forgotten, which is the
same failure shape §10.1 records for the signed-URL override and §1.1 for the
`?? 400` fallback. And the trigger is the *content of the response*, not the route:
`/login`'s `200` is the only response in PR 2 that carries a credential, and PR 4's
wrapped-blob route will need the same extension for the same reason.

- **Request body: OPEN, and only this.** Brief §12 has not settled the owner
  account model — email plus password, or invite code plus password — so the
  fields a caller presents are a **labelled gap** (§5.2). Whatever it carries is
  a shared secret verified with Argon2id (brief §9.3), whose parameters are part
  of the same hole and must not inherit the passphrase wrap's 64 MiB. **Nothing
  else about this route varies with the answer:** the response, the window, the
  error codes, the indistinguishability rule and the rate limit below are all
  fixed.
- **`200`:** `{ "token": "<43 chars, base64url>", "expires_at": "2026-09-03T09:41:12Z" }`
  **and nothing else.** Without `expires_at` a client cannot warn before a
  two-week window lapses, and a parent meets expiry mid-upload rather than being
  prompted. Neither field is secret; an owner id would be redundant, since the
  token identifies them.
- **`expires_at` is RFC 3339, UTC, with a trailing `Z`.** Not "ISO 8601", which
  admits week dates, ordinal dates and offset-less local times. This is encryption spec
  §9.1's discipline applied to a timestamp: a format described loosely is a format
  two implementations can disagree about, and the disagreement is a client that
  believes the session ends two hours later than it does. Every timestamp PR 2 puts
  on the wire follows this rule — here and in §7.8's `revoked_at`.
- **The window is two weeks. Provisional, pending brief §11.** The §11-independent
  reason stands on its own: a parent uploads every couple of weeks, and scheduled
  re-login is friction on the person who has to *want* to use this. The additional
  reason — that under a password-derived `K_album` re-login means re-entering a
  password to reach your own albums — holds under only one of §11's three candidate
  answers, so it must not be treated as settled. **Record the number as
  contingent**, or the hole gets filled by a value chosen for one branch of it.
- **Errors:** `400 VALIDATION_FAILED` · `401 INVALID_CREDENTIALS` ·
  `413 PAYLOAD_TOO_LARGE` · `415 UNSUPPORTED_MEDIA_TYPE` · `429 RATE_LIMITED`.
- **`INVALID_CREDENTIALS` is deliberately distinct from `UNAUTHENTICATED`**, though
  both are `401`. "Check your details" and "your session ended, sign in again" are
  different sentences in the client's language, and a client cannot tell them apart
  from the status (§1.1).

**`/login` must not reveal whether an account exists.** A wrong secret and an
unknown account return the same `code`, the same status, the same body, and as
close to the same timing as can be managed. **Which means running the verification
against a dummy hash when the account is absent**, rather than returning early:
the early return is the natural implementation and it is a timing oracle for
account enumeration. Same family as §7.3's cross-album `404`, and it fails the
same way — look up, check, return a different answer for each. The dummy hash must
use the same parameters as a real one, or the timing signal survives.

**The request body never reaches a log, and this is the route that forces the
rule.** Whatever brief §12 decides the caller presents, it is a shared secret, and
`/login` is the first route in the system whose *body* holds one — the redaction
list in §6.1 covers two headers and nothing else. §1.2 settles the mechanism, and
settles it **globally rather than for this route**: a validation failure logs a
projection of `instancePath`, `keyword` and `schemaPath`, never the error object,
never `message`, never `params`. Route-local suppression was rejected for the usual
reason — it would require a route author to know their body is sensitive, and
forgetting the flag would be silent. Note that today's implementation is *safe but
not safe by construction*: §1.2's verified table shows AJV does not echo values,
and one option (`verbose: true`) would make it do so. §6.2 carries both halves as a
single owed change, because a half-applied version reads as the contradiction it is
fixing.

**`POST /v1/logout`** — owner scheme. **No body**, and `204` on success.

- The bearer token identifies the row to revoke. A `POST /logout {token}` shape
  would need a scope check to stop one owner revoking another's session, and would
  put a plaintext token in a body (§7.2).
- **It revokes the presented token only.** Several `owner_tokens` rows per owner is
  normal — one per signed-in device (schema §3) — so revoking all of them signs a
  parent out of their phone because they logged out on a laptop.
- Sets `revoked_at`; deletes nothing. Calling it twice returns `401` the second
  time, because step 2 of §7.3 rejects the now-revoked token before the handler
  runs. That is correct rather than merely acceptable.
- **Errors:** `401 UNAUTHENTICATED`.

**`POST /v1/logout/all`** — owner scheme. No body, `204`.

- Revokes **every** unrevoked `owner_tokens` row for the owner, **including the
  calling session.** One route, one statement, no schema change.
- "Not in v1" would leave a parent whose phone is lost with no recovery until
  brief §12 grants them a password to change. Including the current session is the safer
  default: exempting it means an attacker holding your session survives your own
  sign-out-everywhere. The **client** should say that it signs you out here too,
  rather than surprising someone who clicked it on a laptop to kill a phone.
- **A per-device session list is the better product** and needs device labels
  nothing in the schema captures. Not v1.
- **Errors:** `401 UNAUTHENTICATED`.

### 7.6 `POST /login` is the one route with no token to key on

`RATE_LIMITED`/`429` with a `Retry-After` header; the client backs off silently.

**The `/login` limiter is not optional hardening.** §7.5's dummy-hash mitigation
means every attempt against an unknown account runs a **full Argon2id
verification** — that is the point of it — and therefore an unauthenticated caller
can force one allocation per request, at whatever the owner-password parameters
turn out to be (§5.2). The limiter bounds a memory-exhaustion vector the product
created deliberately. **State that, or it reads as friction and gets removed.** The
argument holds whatever number §12 lands on, which is why it deliberately names
none.

**Keyed on IP, and this is the one place that is right.** Every other limit in the
system keys on the token hash, because a family behind one NAT shares an address
and mobile data changes it mid-session (PR 5). `/login` has no token to key on,
which makes it both the obvious target and the one route otherwise unlimited. The
NAT objection is weak here: a family makes a handful of login attempts a day, and
**10 per 15 minutes per IP** — provisional — inconveniences nobody while slowing
credential stuffing. If you decide not to limit it, say so explicitly rather than
leaving the gap silent.

**The limiter is in-process state.** Correct on one instance, silently broken on
two. PR 5 states this as a general property of the rate limiting in this system;
it is true from the moment *this* limiter exists, three sections earlier, so
nobody should add Redis to Phase 0 or scale to two instances without noticing.

**`Retry-After` must be in `Access-Control-Expose-Headers`** or a cross-origin
client cannot read the interval it is being asked to wait for (§3.1). This is the
first route in the system that can produce a `429`.

### 7.7 The recipient credential, and creating one

**The invite *is* the credential.** No login, no account, no session: possession of
the link is possession of access to that album, until the owner revokes it (brief
§3, §11; invite spec §1.1). Writing this down in the API document is what stops a
later route treating recipient auth as if it were an account — adding a refresh,
an expiry, a "session", or a password.

**Recipient tokens carry no expiry**, only `revoked_at` (brief §9.1). Expiry would
buy nothing: `token` and `key` travel in the same payload in direct mode, so
expiring the token stops future fetches while leaving a permanent decryption key
(encryption spec §6.4) — and it would break the album for a recipient who did
nothing wrong, whose only recovery is the parent noticing and re-inviting. If
expiry ever arrives it is per-invite and opt-in, never a default.

The consequence — that the link forwards with a tap and grants the whole album —
is recorded in brief §11 and constrains B.7's copy, not this document.

```
POST /v1/albums/{album_id}/recipients
```

Owner scheme. `201` on success. The album must belong to the caller, or `404`
(§7.3, step 3) — not `403`.

| Field | Type | Notes |
| ----- | ---- | ----- |
| `id` | uuid | **Client-generated, required, no server default.** It is inside the wrap AAD — `"vitrina-wrap-v1" ‖ recipient_id`, 16 raw bytes (encryption spec §6.2) — so the client needs it before it can compute `wrapped`. A server-assigned id breaks unwrapping, works fine for QR recipients, and fails as an opaque AEAD error (brief §9.3; schema §3) |
| `kind` | `"qr"` \| `"passphrase"` | Enum, mirroring the `CHECK` |
| `label` | string | Plaintext on the relay today; whether it becomes encrypted is §5.3 |
| `token_hash` | 43 chars base64url → **exactly 32 bytes** | SHA-256 of the 32 raw token bytes, computed by the client (§7.4) |
| `wrapped` | 64 chars → 48 bytes | **passphrase only**, forbidden for `qr` |
| `wrap_nonce` | 32 chars → 24 bytes | **passphrase only.** The field that gets forgotten, and without it the blob is undecryptable |
| `kdf_salt` | 22 chars → 16 bytes | **passphrase only** |
| `kdf_memory_kib`, `kdf_iterations`, `kdf_parallelism` | integer | **passphrase only.** Stored per row so they can be raised without invalidating existing invitations |

**The schema mirrors the two database `CHECK`s rather than trusting them.** All six
wrap fields are required for `passphrase` and forbidden for `qr`, and every binary
field decodes to exactly the length encryption spec §6.2 fixes. A wrong length is
not a style problem: it is a blob that cannot be unwrapped, discovered at unwrap
time with no diagnostic. Rejecting at the boundary turns an opaque AEAD failure
into a `400`.

**Every binary field on this route decodes by schema §6's rules, not just
`token_hash`.** `wrapped`, `wrap_nonce`, `kdf_salt` and `token_hash` all get the
full discipline — the exact character count for that field's length, the base64url
alphabet (`-` and `_`, never `+` and `/`), no padding, an exact decoded byte count,
and **the re-encode check**: encode the decoded bytes again and require the result
to equal the input. Only the lengths differ; the rules do not. An earlier version
of this section guaranteed *length* for all four and canonical form for
`token_hash` alone, which left three fields with a weaker guarantee for no stated
reason.

**One field is worse than `token_hash`, which is the argument for making the rule
uniform rather than per-field.** Schema §6 derives the re-encode check from
base64url's spare trailing bits, and those depend on whether the byte length
divides by three:

| Field | Bytes | Chars | Spare bits | Distinct spellings of the same bytes |
| ----- | ----- | ----- | ---------- | ------------------------------------ |
| `wrapped` | 48 | 64 | 0 | 1 |
| `wrap_nonce` | 24 | 32 | 0 | 1 |
| `token_hash` | 32 | 43 | 2 | **4** |
| `kdf_salt` | 16 | 22 | 4 | **16** |

So the field carrying the *most* non-canonical spellings is `kdf_salt`, not
`token_hash` — sixteen strings that decode to one salt — while `wrapped` and
`wrap_nonce` have none at all, their lengths being multiples of three. Deciding
this field by field means getting that ordering right and re-deriving it whenever a
length changes. One decoder applied to all four is cheaper than the analysis, and
it is the same argument schema §6 makes for hashing `owner_tokens` by the recipient
rule: one rule for both is cheaper than two.

As with `token_hash`, this is a **canonical-form guard, not a security control**:
two spellings of one `kdf_salt` decode to identical bytes and would derive an
identical KEK, so the check buys a single stored representation rather than
integrity. No standard encoder ever fails it.

**This route accepts wrap material and no key material.** `wrapped` is a blob
encrypted under a KEK the server never sees; the passphrase and the KEK must never
appear in any field, and no field may be added later that carries them (§4.1). This
is the route the route-table audit exists for.

**On `token_hash`, one correction to the checklist's wording.** #4c asks the schema
to "reject anything shaped like a plaintext token", and it cannot: a raw 32-byte
token and its SHA-256 are both 32 bytes, both 43 base64url characters,
indistinguishable to any validator. What the schema *does* catch is everything
else — hex, a 64-character hex digest, padded base64, a UUID string, the wrong
length — using schema §6's strict canonical decoding, including the re-encode
check. **A client that posts the raw token instead of its hash is caught by the
conformance vector, not by the server**, and schema §6 already requires that vector
(one known token, both forms, its expected SHA-256). Worth stating plainly: the
guard is a length-and-encoding guard, the failure it cannot see is a client bug,
and the only thing that catches it is the shared test vector — which both halves
must run.

**Responses.** `201` with `{ "id": "...", "created_at": "..." }`, RFC 3339 UTC. No
`Location` header: the client already has the id, and a header the browser cannot
read without being added to `exposedHeaders` is a cost with no buyer.

**Errors:** `400 VALIDATION_FAILED` · `401 UNAUTHENTICATED` · `404 NOT_FOUND`
(album absent or not the caller's) · `409 CONFLICT` · `413 PAYLOAD_TOO_LARGE`.

**`409 CONFLICT` carries no `details`, deliberately**, so it does not say whether
`id` or `token_hash` collided. `id` colliding is the client retrying a create whose
response it never received; `token_hash` colliding across albums is a client bug or
a token being squatted, and naming the field would make the response an oracle for
"is this hash already in use". The client's remedy is the same either way:
regenerate and retry.

### 7.8 Revoking a recipient

```
POST /v1/recipients/{recipient_id}/revoke
```

Owner scheme, no body, `200` with `{ "revoked_at": "..." }`.

**It sets `revoked_at` and deletes nothing.** `access_log.recipient_id` is
`ON DELETE CASCADE` (schema §5), so `DELETE FROM recipients` would destroy that
recipient's entire view history — the "María viewed this" feature — as a side
effect of revoking access. §4.2's delete-objects-first constraint covers albums and
owners and would not catch this. It is worth stating because "revoke" and "delete"
read as synonyms to whoever writes the route.

**Which is why it is a `POST` to `/revoke` and not a `DELETE`.** The method that
names the operation is the method that does not suggest removing the row. This is
also the reason §3.2 flags `DELETE` in the CORS `methods` list as currently unused.

**Idempotent.** A second call returns the **original** `revoked_at` with `200`, not
a new timestamp and not an error: a retried revoke must not look like a failure to
a client that lost the first response, and the first revocation is the true one.

**Scope, and the path shape.** `recipient_id` determines its album, so the album is
not in the path; the handler joins to `albums` and requires `owner_id` to be the
caller's, returning `404` otherwise (§7.3). The nested alternative
(`/albums/{album_id}/recipients/{recipient_id}/revoke`) reads more consistently and
adds a pair that can disagree, needing a rule for the mismatch. Flat, with the
scope check in one place, was chosen for that reason.

**Why create is nested and revoke is flat — the asymmetry is forced, not a style
slip.** The two routes look inconsistent side by side and the inconsistency is
worth one paragraph, because the obvious tidy-up in either direction is wrong:

| | Create (§7.7) | Revoke |
| --- | --- | --- |
| Path | `/v1/albums/{album_id}/recipients` | `/v1/recipients/{recipient_id}/revoke` |
| Does a `recipients` row exist yet? | **No** | Yes |
| Where the album comes from | the caller states it | derived from the row |

**At create time there is no recipient row, so the album cannot be derived from
anything** — the client mints `id` (it is inside the wrap AAD), but a not-yet-stored
id joins to nothing, so the album is necessarily an *input*. **At revoke time the
row exists and determines its album**, so asking for the album again would add a
second value that can contradict the first and require a rule for the mismatch.
One route must be told which album; the other must not be asked. Each takes the
album from the only place available to it.

That leaves only *where* create's album id goes — path or body — and the path wins
on §7.3's ordering. Scope is resolved at step 3, before the handler and before the
status is chosen; a path parameter is available to that check identically on every
route, whereas a body field is available only after body parsing and schema
validation, which means a scope check running after two failure modes that answer
`400`. **Nesting create also makes it structurally impossible to create a recipient
without naming an album**, which a body field leaves as a required-field assertion
instead. Neither shape should be "made consistent" with the other later.

**What revocation does and does not do** must not be restated loosely in any
client copy: it stops the server serving ciphertext to that token, from the next
request onward, and it does nothing about anything already retrieved or about the
key the recipient holds (encryption spec §6.4, brief §8). Because v1 proxies every
byte (§6, brief §10.1), revocation is checked per request and is genuinely
immediate — the UI may say so without hedging.

**Errors:** `401 UNAUTHENTICATED` · `404 NOT_FOUND`.

### 7.9 The five routes, in one table

| Route | Scheme | Body | Success | Errors |
| ----- | ------ | ---- | ------- | ------ |
| `POST /v1/login` | none | **OPEN — §12** (§7.5) | `200` `{token, expires_at}`, `no-store` | 400 · 401 `INVALID_CREDENTIALS` · 413 · 415 · 429 |
| `POST /v1/logout` | owner | none | `204` | 401 |
| `POST /v1/logout/all` | owner | none | `204` | 401 |
| `POST /v1/albums/{album_id}/recipients` | owner | §7.7 | `201` `{id, created_at}` | 400 · 401 · 404 · 409 · 413 |
| `POST /v1/recipients/{recipient_id}/revoke` | owner | none | `200` `{revoked_at}` | 401 · 404 |

All five carry the `/v1` prefix from the single mount point (§2) and none writes it
itself. **No route here is recipient-authenticated:** PR 2 defines what a recipient
credential is and how it is checked, and PR 3 is where the first route consumes
one. `403 ACCESS_REVOKED` is therefore registered in this PR and first reachable in
the next (§1.1).

### 7.10 What PR 2 deliberately does not decide

- **`POST /login`'s request body** — brief §12, labelled in §5.2 and §7.5. The
  owner password's Argon2id parameters ride with it.
- **Whether `recipients.label` is encrypted** — §5.3, coupled to §5.1. §7.7 accepts
  it as plaintext today and the field's *shape* is what would change, not the
  route's.
- **Whether an owner ever authenticates as a recipient of someone else's album**
  — brief §11's "recipients will become owners". The tagged union in §7.1 is chosen
  so that this is additive: a nullable FK from `recipients` to `owners` changes no
  wire shape here.
- **Recipient-side rate limits** — PR 5, keyed on the token hash. Only `/login`'s
  limiter is settled here, because only `/login` has no token to key on.
- **The passphrase key-material route** — PR 4. It is the only route that *returns*
  key-adjacent material, and §7.7's create is its mirror image: this PR settles how
  a wrapped blob is stored, PR 4 settles how it is handed back.

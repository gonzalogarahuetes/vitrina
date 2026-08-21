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
| 1  | Error envelope, `/v1`, CORS, the three standing constraints, open questions | **§1–§6** |
| 2  | Both auth schemes and the full credential lifecycle of each — `/signup`, `/login/params`, `/login`, `/logout`, recipients create and revoke | **§7** |
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
**seven** routes, and §6 records exactly which of its rules are code and which are
still owed. It is not met for PRs 3–5, and deliberately so.

**Amended 21 August 2026.** Brief §11 and §12 closed the two decisions PR 2 was
written around, so this revision closes §5.1 and §5.2, decouples §5.3 from them,
fills §7.5's labelled request-body gap, and adds the two credential routes that
decision implies — `POST /v1/signup` and `POST /v1/login/params`. Per the rule
above nothing was renumbered: both routes joined §7.5, which is now the owner
credential lifecycle rather than owner sessions alone. **Implementing them needs
`owners` columns and the `owner_keys` table, which land in a Phase 1 migration**
— `001_initial_schema.sql` has applied and contains neither.

**Amended again later the same day**, after encryption spec §6.6, schema §3 and
brief §9.3 settled the proof-verification question this document had flagged. Two
changes: the relay's own Argon2id layer is now stated wherever it bears on a route
(§5.2, §7.5, §7.6), and **`details`'s type is spelled once, canonically, in §1.1**
— it had acquired three spellings in a day, one of them the type §1.1 exists to
reject.

---

## 1. The error envelope

**One shape, every error, no exceptions.**

```jsonc
{
  "code": "ACCESS_REVOKED",       // stable, machine-readable, the client's contract
  "message": "Access has been revoked.", // developer-facing English
  "details": { "fields": ["kind"] }       // optional; field *names* only, never values
}
```

`details` is shown for shape only. **No code PR 2 registers ever carries it** —
§7.3 explains why the auth routes in particular are the wrong place for a
machine-readable hint.

**`details` is typed `ErrorDetails`. Decided 21 August 2026** — an amendment,
because PR 1 shipped without settling it and it therefore had no owner, the one
state the open-items list exists to prevent.

**This is the canonical declaration, spelled exactly as the code spells it, and
every other mention in this document cites the name rather than re-spelling the
structure:**

```ts
type ErrorDetails = { readonly fields: readonly string[] };
```

That convention is not fussiness. Within a day of the decision this document
carried **three** spellings — `{ fields: string[] }` here, `{fields: readonly
string[]}` in §6.1, and `Record<string, string>` still sitting in §1.2's bullet
list, which is the type this section rejects. A document whose whole argument is
that *the type is the enforcement* cannot be loose about the type. Same discipline
as §7.2's rule for citations: **name the thing you mean; only the section gets a
number.** A name survives a change to the structure; a re-spelling drifts from it
silently.

The constraint that decides the shape is #15: it must distinguish a field **name**
from a field **value**. `Record<string, string>` — what the type was — fails
structurally, because `{"field": "kind"}` and `{"kind": "<what they sent>"}` are
the same shape and only intent separates them. **A list of names has nowhere to
put a value**, so the type refuses the echo rather than a reviewer catching it;
`tsc` rejects `details: { kind: "..." }` at the throw site. Same reasoning as
§1.2's log projection being a whitelist rather than a filter, and the same safety
class: a name is safe because *our schema declared it*.

Two limits, stated rather than implied. A value can still be *placed in the
list* — the type forecloses the shape that made echoing natural, not a throw site
determined to lie, and `http.test.mjs` asserts that as the property rather than
overclaiming. And `fields` is the only member: a future code needing context that
is genuinely not a field name gets a sibling key with its own #15 argument, never
a widening of this one. It lives in `packages/shared` (§1.4), because a client
that must render it has to import it.

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
| `CONFLICT` | 409 | PR 2 | PR 2 — duplicate `id` or `token_hash` on recipient create (§7.7); also a duplicate address on `POST /signup` (§7.5) |
| `PAYLOAD_TOO_LARGE` | 413 | PR 1 | PR 2 — `bodyLimit` on the first route with a body; PR 3's upload route depends on it |
| `UNSUPPORTED_MEDIA_TYPE` | 415 | PR 1 | PR 2 — `POST /login` with a `Content-Type` no body parser matches |
| `RATE_LIMITED` | 429 | PR 1 | PR 2 — the `/login` limiter (§7.6) |
| `INTERNAL` | 500 | PR 1 | PR 1 |

**"Registered by" means "the PR whose prose puts this code in the union" — not
"present in the union today."** Both columns are statements about *this document's*
scope; neither says anything about the implementation. Read a `PR 1` in this
column as "PR 1 owes it", never as "PR 1 shipped it" — a distinction that matters
again the moment PRs 3–5 add a row.

**All ten rows exist in the union as of 20 August 2026**, in
`packages/shared/src/index.ts` (§1.4), each with a `code → status` and a
`code → message` entry. An earlier version of this paragraph said six of the ten
were absent from the code and that §6.2 was the only place recording which codes
actually exist; both statements were true when written and are now false. §6.1
records the enforcement, §6.2 what remains owed.

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
  `ErrorDetails` (§1.1) and is for machine-readable context the client needs in
  order to act. Putting the offending input in it is exactly #15. **This bullet
  said `Record<string, string>` until 21 August 2026** — the very type §1.1
  rejects, cited from the section §1.1 names as its own precedent. Corrected
  rather than quietly reworded, because a document arguing that the type is the
  enforcement cannot carry the rejected type in its list of rules.
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
  safe even on the wire. **Never `message`, never `data`, never `{err}`, never the
  body.** The cost is real and accepted: you read the schema alongside a field
  path instead of an English sentence. Implemented as `projectValidation` in
  `error-envelope.ts`, built as a whitelist rather than a filter, so a field a
  future AJV attaches is absent by default rather than present by default.

- **One key of `params` is allowed: `missingProperty`, on `keyword === "required"`
  only.** Added 20 August 2026; this bullet previously said "never `params`" flatly
  and the rule was applied for one commit before the gap below was noticed. For a
  `required` failure AJV puts the field name only in `params.missingProperty` and
  in `message`: `instancePath` is the parent object, usually `""`, and `schemaPath`
  is `#/required`. Under the flat rule a missing-field failure logged
  `{instancePath: "", keyword: "required", schemaPath: "#/required"}` and named no
  field at all — worse than the cost this section accepts, which trades an English
  sentence for a field path and here left no field path either. The name is
  declared by our own schema, the same safety class as `instancePath`.

  **The exception is keyword-specific, and that is the whole of its safety. It is
  not "`params` is safe on builtin keywords".** `additionalProperties` is the
  counter-example and it is one keyword over: its `params` carries
  `additionalProperty`, the same shape — a bare string under `params`, on a
  builtin keyword — holding a **client-chosen** key name rather than a
  schema-declared one. `{"S3CRET": 1}` puts a client's string there. It cannot
  fire while Fastify's default `removeAdditional: true` strips unexpected keys
  instead of erroring, which is a default one line from changing, exactly like
  `verbose: true`. So the gate is written per keyword: adding one means arguing
  that keyword's `params` names something *we* wrote, one keyword at a time.

**This binds the validation path only, and the `INTERNAL` path is asserted to be
untouched by it** — `error-logging.test.mjs`, because the way to break that rule
is to "finish" this one. An unrecognised error is logged whole: `request.log.error(error)`,
a stack, and no projection.

A stack is the entire diagnostic value of a `500`. A request value reaching a log through
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
sensitive. **The projection half of that is done** (20 August 2026):
`error-envelope.ts` no longer logs `{ err: error }` on the validation path. What
§6.2 still owes is the route-level assertion, which needs PR 2's `/login` to have
a body worth POSTing a secret into.

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
CI rather than in production.

**Written 20 August 2026**: `packages/server/test/framework-4xx.test.mjs`, 19
cases against a body-accepting route registered through `v1Plugins`. It adds two
triggers this paragraph did not list — a body with **no** `Content-Type` (also
`415`) and an **empty** body sent as `application/json` (also `400`) — and derives
its oversized payload from `app.initialConfig.bodyLimit` rather than hardcoding
1 MiB, so it tracks the limit PR 3's upload route will change. Verified against
the pre-mapping implementation: all five triggers returned `500 INTERNAL`, which
is what the test was written to fail on. `429` is the one registered status it
cannot reach, because nothing raises one — see §7.6.

#### What the log does with a cause — and a measurement this document got wrong

**Correction, 21 August 2026.** A note in this section read: "pino's default
`err` serialiser emits `{type, message, stack}` and drops `error.cause`
entirely, so a chained cause is lost today." **That is false, and the version it
was measured against is the version installed.** Re-measured on pino 10.3.1 /
pino-std-serializers 7.1.0, whose own source comments "We append cause messages
and stacks to `_err`, therefore skipping causes here": the default **flattens**
the chain. Every cause message is joined into `err.message` with `": "`, and
every cause stack is appended to `err.stack` under `caused by:`. There is no
`err.cause` key, which is what the earlier measurement saw and read as absence.

The chain was in the log all along, unstructured. Two consequences, and the
second is the one that matters:

- **`errWithCause` is adopted anyway** — `pino.stdSerializers.errWithCause`,
  wired as `LOG_POLICY` in `server.ts`. But for **structure, not presence**:
  `err.cause` becomes a nested object, each link keeping its own `message` and
  `stack`, queryable by field instead of by substring. The cost, since it is
  real: `err.message` is now the top-level message alone, so anything reading it
  for the underlying reason must walk `err.cause`, and a log query written
  against the flattened form stops matching.
- **The #15 exposure is not new and was never hypothetical.** If the chain has
  been reaching the log flattened since the first `cause` was passed, then a
  driver error chained verbatim has been putting its quoted request values in
  the log all along. `errWithCause` moves where the value sits — `err.cause.message`
  rather than `err.message` — and changes nothing about whether it is there.

**So the rule: chain a message you wrote, not a driver error verbatim.** This is
a #15 guard, not a style note. Postgres spells a unique violation
`duplicate key value violates unique constraint "owners_email_key" Key (email)=(someone@example.com) already exists.`
— a submitted value, quoted by the driver, reaching the log with no throw site
having interpolated anything. Wrap it:

```ts
throw new ApiError("CONFLICT", {
  cause: new Error(`owners.email already taken (pg ${pgError.code})`),
});
```

The driver's `code` and constraint name are both safe to name, because they
describe the schema rather than the request. They belong **in the message you
write**, not in a nested `cause`: both serialisers drop a non-`Error` cause
silently, so `cause: pgError.code` reads as diagnostics and reaches no log line
at all.

It sits with the paragraph above as throw-site discipline rather than a handler
guarantee, for the same reason: the handler cannot inspect a message and know
whether a value in it was submitted or authored. §6.2 carries what that costs in
enforceability. The rule is written on `ApiError`'s `cause` doc comment as well
as here, because whoever chains a `pg` error will be reading the constructor and
not this document.

#### An `ApiError` is logged when it carries a cause, and not otherwise

**Decided 21 August 2026**, closing a §6.2 row. The `ApiError` branch used to
return without logging at all, so a `409 CONFLICT` carrying a unique violation
left no trace on the server.

- **A cause means a line: `warn`, with `{err: error}`.** A cause is the signal
  that something happened which the server had to interpret — a constraint
  violation behind a `CONFLICT`, a storage failure behind a `NOT_FOUND`.
- **No cause means silence.** A `404` with nothing underneath it is not an
  event: the route answered the question it was asked. A line per missing album
  is noise, and noise is what trains people to stop reading the log.
- **`warn` and not `error`**, matching the framework-4xx branch: an `ApiError`
  is a condition this server recognised and answered correctly. `error` stays
  reserved for the branch where it did not.
- Handing pino `{err: error}` here is safe on the envelope's own terms —
  `ApiError`'s message is `MESSAGES[code]`, a constant. Everything below it in
  the chain is the throw site's responsibility, per the rule above.

**One case the cause-based rule does not cover, and it is deliberate:**
`new ApiError("INTERNAL")` with no cause answers `500` and logs nothing. Adding
a second condition on status would be the handler doing a throw site's job. The
rule instead is: **do not throw `INTERNAL` as an `ApiError`** — let an
unrecognised error fall through to the branch that logs a stack.

**The log policy belongs to the adapter, not to `buildServer`'s caller.**
`redact` and `serializers` are merged over whatever logger a caller passes, and
`false` is the only thing passed through untouched. Before this, a
caller-supplied logger replaced the options object wholesale, so every test that
captured a log stream ran with no redaction and no serialisers — harmless in
production, which passes no logger, but it meant no test could prove either rule
held. It also meant a test asserting the cause chain would have been asserting
its own configuration: the same failure mode `v1Plugins` exists to avoid, where a
test passes against the very bug it is meant to catch.

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

`vitrina-server-architecture.md` §9 left this open and assigned it to "whoever adds the
second error code", naming PR 2 as the natural place. PR 2 adds five. **Decided
here, implemented 20 August 2026, and recorded at source in architecture §9:**

- **`packages/shared` owns the `ErrorCode` union, the `ErrorBody` wire type and
  `ErrorDetails` (§1.1).**
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

**One consequence that had to be enforced, not just decided.** Moving the union
out of `error-envelope.ts` put a wire type one import away from every file in the
server, and architecture §4 decision 5 only reads as a rule about the *other*
direction — a domain entity leaking into `shared`. The boundary rule now restricts
`@vitrina/shared` from `src/domain/**` and `src/application/**` (architecture §6),
so decision 5 fails `pnpm lint` in both directions. Verified by violating it
deliberately in each layer, then reverting, per the discipline that rule carries.

---

## 2. Versioning

**`/v1` prefixes every route, registered exactly once at the mount point.** A
route file never writes the prefix itself; it is applied by a single
`app.register(routes, { prefix: "/v1" })` in the HTTP adapter.

**That mount point exists in code** — `server.ts` registers an empty `/v1`
context, and PR 2's seven routes are the first to register inside it. Until they
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

Three rules that hold for every endpoint in every later PR. They are written here
so that a future route can be checked against them. **§4.3 was added 21 August
2026**, when brief §12's account model turned a `/login` property into one
spanning two routes.

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

**That ambiguity is resolved and the note recording it is deleted.** It read:
the inward rule is cited as non-negotiable #16 and brief §6 numbers only fifteen,
so the inward half of a symmetric pair is the one half that cannot be cited;
proposed adding it as #16. **The edit landed** — brief §6 now numbers seventeen,
with **#16** the inward rule worded as this constraint and **#17** the
default-must-never-be-silently-absent rule this document leans on twice (§1.2's
unmapped 4xx, §7.5's decoy secret). So cite **#15 and #16 as the pair**, and drop
the "encryption spec §2.2 in the meantime" workaround.

Kept as one paragraph rather than removed outright because the resolution is the
useful part: a dangling citation was found by writing prose that needed it, which
is the same way architecture §9's #26 and #27 were found. Left as a live
AMBIGUITY, a reader would go looking for a gap that is closed.

What the server legitimately holds for passphrase recipients is the *wrapped*
blob and its parameters — `wrapped`, `wrap_nonce`, `kdf_salt` and the three
Argon2id integers (schema §3). A wrapped blob is not key material. QR recipients
store nothing at all (encryption spec §6.1).

**The checkable form of this constraint** is brief §12's reason for choosing
Fastify: per-route JSON Schema makes it "auditable by a test that walks the route
table". **PR 2 is the first PR that gives that test something to walk**, and it
gives it **two** routes that legitimately accept wrap material — a count that
changed on 21 August 2026 and matters, because a walk demonstrated on one route
is a walk nobody has generalised:

- **§7.7's create-recipient** carries `wrapped`, `wrap_nonce`, `kdf_salt` and the
  three Argon2id integers, and must accept no passphrase and no KEK.
- **§7.5's `POST /signup`** carries `wrapped_master`, `wrap_nonce`, a salt and
  parameters, and must accept neither the password nor `K_master`. **This is the
  higher-consequence body in the system** — it wraps the key every album in the
  account hangs off — so the audit should be written against it and merely
  confirmed on the other.

A route that accepts a wrapped blob is exactly where the difference between
"wrapped blob" and "key material" stops being a definition and becomes a schema.
Brief §6 #16 now states that distinction in the same words: a wrapped blob is
ciphertext and may be posted; the key that wrapped it and the secret that key was
derived from may never be.

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

### 4.3 No credential route reveals whether an account exists

**CONSTRAINT, added 21 August 2026.** It is stated here, once, because it spans
routes and is **one rule rather than a property each route happens to have**. An
earlier draft carried it only inside `POST /login`; brief §12's account model adds
`POST /login/params`, and a rule written per route would have been restated,
drifted, and then disagreed with itself.

**No credential route may reveal whether an account exists — not by status, not
by `code`, not by response shape, and not by timing.** Two routes are in scope
today (§7.5):

- **`POST /login`** — a wrong secret and an unknown address return the same
  status, the same `code` (`INVALID_CREDENTIALS`), the same body, and as close to
  the same timing as can be managed. **Which means running the verification
  against a dummy value when the account is absent**, rather than returning
  early: the early return is the natural implementation and it is a timing oracle.
  The dummy must use the same parameters as a real one, or the timing signal
  survives the mitigation.
- **`POST /login/params`** — always `200`, with deterministic decoy values for an
  unknown address, and the lookup runs unconditionally with substitution on miss.
  Branching before the query is the same oracle in a different place.

This is the same family as §7.3's cross-album `404`, and it fails the same way:
look up, check, return a different answer for each. **Check-then-diverge is the
shape to watch for** in all three.

**`POST /signup` is explicitly outside this constraint and cannot be brought
inside it in v1.** Registration must reject a duplicate address, and with no email
sending there is no way to answer identically and deliver the difference out of
band. So the guarantee is *credential-route indistinguishability*, not
account-existence secrecy — an attacker cannot learn which addresses hold
accounts by attacking the login path, and can still learn it by attempting to
register one.

That limit is **brief §11**'s to carry, because it constrains owner-facing copy
and any privacy claim about what the relay reveals, and whoever writes such a
claim is reading the brief. Encryption spec §10 carries it too, as an envelope
limitation. Recorded here only as the boundary of this constraint — a reader who
finds two routes covered and a third unmentioned would reasonably assume the
third was an oversight.

**Why a standing constraint rather than a route property.** §4's other two
entries are here for the same reason: they are obeyed by routes that do not exist
yet. PR 3's owner flow adds no credential route, but Phase 2's recovery-key
insert (encryption spec §6.6.1) plausibly does, and it inherits this without
anyone re-deriving it.

---

## 5. Open questions — not answered here

**One decision is open — §5.3.** §5.1 and §5.2 closed on 20 August 2026 and are
kept below as closed records rather than deleted, because §7 was written around
them and a reader tracing why a route looks the way it does needs the decision,
not its absence. **Nothing in PR 1's implementation depends on any of the three.**

### 5.1 How does an owner retain `K_album`? — CLOSED (brief §11)

**Decided 20 August 2026: a server-stored `K_master`, wrapped, with no recovery
in v1.** The question was live because an owner needs `K_album` every time they
add photos to an existing album or mint a new invite, so a memory-only key means
losing your own album on a page refresh.

Two of the three candidates were ruled out rather than merely outranked.
**Device-local storage** breaks the ordinary case of a parent with a phone and a
laptop. **A password-derived master key** — `K_album = KDF(K_master, album_id)` —
contradicts encryption spec §2, where `K_album` is 32 random bytes, and forecloses
permanently: a derived key can never be re-wrapped, so no password change, no
recovery key and no rotation are possible afterwards.

**What the API inherits from it**, which is why this section is kept:

- **Wrap, never derive.** `K_album` stays random and is *wrapped* under
  `K_master`. This is what makes §7.5's `/signup` body a wrapped blob rather than
  anything derived, and it is why §4.1's audit has a second subject.
- **N wrappings, not one column.** An `owner_keys` table holds several wrappings
  of the same `K_master`, one per credential. Phase 2 adds a recovery key by
  `INSERT` rather than by migration. The **per-row client KDF parameters** that
  table exists to carry are what force `POST /login/params` to exist at all
  (§7.5): a global constant would have removed the round trip and the property
  with it. The relay keeps a *second*, independent parameter set on `owners`, also
  per row and never returned to a client — §5.2 has the table, and conflating the
  two is the drift both this document and brief §9.3 now guard against.
- **The login proof and the key-encryption key are independently derived from
  the password**, and **the password never leaves the device.** Together these fix
  what `POST /login` receives — a derived proof, never a password. Encryption spec
  §6.6 owns the derivation and still owes conformance vectors per §9.1 before
  Phase 1.

**Accepted cost, and no route may soften it:** forgetting the password loses every
album. Email restores *login*, which the server owns; it cannot restore *keys*,
which the server was never allowed to hold.

### 5.2 The owner account model — CLOSED (brief §12)

**Decided 20 August 2026: email and password.** Email is a memorable username,
not a recovery channel. **§7.5's labelled request-body gap closes with it**, and
so does this hole — with one part carved out below that is genuinely still open.

An earlier version of this section said §12 blocked PR 2 outright, which is why
PR 2 went unwritten longer than it needed to; a later one narrowed it to the
request body alone. Both are now history: §7.5 states the body.

**Still open, and now owned rather than parked: the Argon2id parameters — and
there are TWO SETS, not one.** Encryption spec §6.6 settled the structure on
21 August 2026; the numbers remain unspecified, and neither set may be inherited
from the other or from the passphrase wrap's 64 MiB (§6.2).

| Set | Applied by | Bounded by | Stored on | Returned to a client |
| --- | ---------- | ---------- | --------- | -------------------- |
| Client's | the client, over the password | a mobile WASM heap on a low-end Android phone | `owner_keys`, per row | **Yes** — that is what `/login/params` is for |
| Relay's | the relay, over the received proof | a server under concurrency | `owners`, per row | **No** — the client has no use for them |

They stopped being a deferred hole when the model closed, because `/signup` and
`/login/params` both carry the client's set and someone needs a number to test
against.

**An ambiguity flagged here on 21 August 2026 is now resolved, and this document
got the substance of it wrong.** The flag asked what verifies the proof
server-side, since the design implies three Argon2id applications — the client's
KEK derivation, the client's proof derivation, and whatever the relay does with
the result — and §7.6's rate-limit argument depends on the third.

**Answer: the relay applies its own Argon2id to the proof** (encryption spec
§6.6, schema §3). So §7.6's argument holds, at the relay's parameters.

**The reasoning this section offered for the other answer was wrong, and the
correction is the useful part.** It argued from schema §3's own note on
`owner_tokens.token_hash` — 32 high-entropy bytes, "Argon2id here would be pure
per-request cost" — that `owners.auth_hash` should want a fast hash for the same
reason, the values being the same shape. **Schema §3 has since withdrawn that
argument explicitly**, and the distinction it draws is the one this document
missed:

> The relay mints a token, and therefore *knows* its entropy. A proof's entropy
> is a **claim about what a client did**, and the relay cannot verify it.

The threat is not an owner choosing a weak password. It is a *Vitrina client*
silently producing weak proofs — a WASM build falling back to lower parameters, a
mobile port splitting the derivation wrongly, a normalisation bug. Login still
succeeds, nothing fails, and every proof from that build is weak until a database
is stolen. That is non-negotiable #17's test exactly — *does it work, wrongly,
without this* — and a work factor the relay controls is the only part that does
not depend on four implementations each having done their half correctly.

Worth recording as a reasoning failure rather than a fact correction: the argument
was structurally sound and reached the wrong answer because it compared two values
by **shape** when the property that mattered was **provenance**. Two columns
holding 32 high-entropy bytes are not the same column if only one of them is known
to hold them.

### 5.3 Do `albums.title` and `recipients.label` become encrypted? (encryption spec §10)

They are plaintext on the relay today, and §10 calls this "the sharpest
inconsistency in the product": _"Sofía's first birthday"_ and _"María"_ are a
child's name and a family member's name sitting readable in a database whose
entire pitch is that it cannot read anything.

**No longer blocked — newly decidable, 21 August 2026.** This section used to say
"the two are coupled and must be decided together", the two being this and §5.1:
encrypting an album title means the owner cannot see their own album list without
holding the album key. **§5.1 closed, and closed in the direction that dissolves
the coupling.** An owner unwraps `K_master` at login and can therefore decrypt
their own titles — the objection was to a design that was ruled out. Stop
describing this as blocked. It is a decision nobody has made yet, which is a
different thing, and the distinction matters because "blocked" moves it off
whoever would otherwise own it.

**Deferring is not free, and that is the part worth writing down.** The relay
cannot re-encrypt what it cannot read, so shipping plaintext titles means a
**client-side lazy migration** later: every existing album's title re-encrypted by
a client that holds the key, on some visit, with both shapes readable until the
last one is converted. That cost grows with every album shipped plaintext. It does
not make the decision urgent — it makes "decide later" a choice with a price
rather than a free option.

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
| `Authorization` and `Range` permitted; `Content-Range`, `Accept-Ranges` and `Retry-After` exposed; preflight cached | Tests on the OPTIONS preflight. `Retry-After` was added in PR 2, not PR 5 — §7.6's three unauthenticated routes are the first that can answer `429` |
| `maxAge` claims only what it claims | Comment in `server.ts` reads "the maximum Chrome honours", not "the maximum useful value". Prose, but the wrong version is what invites someone to raise it |
| `/health` unversioned | Test: `/v1/health` is 404. **Note what this does not prove:** it passes whether the `/v1` mount exists or not |
| `Authorization` and `Cookie` headers never appear in logs | `redact: ["req.headers.authorization", "req.headers.cookie"]`, in `LOG_POLICY`. **This row used to claim "key material never in logs", which is more than two redacted headers deliver** — see §6.2. Note the redaction is inert today either way: Fastify's default `req` serialiser logs method and URL and no headers at all, so this fires only once someone widens it. Kept for exactly that day |
| The log policy is the adapter's, not the caller's (§1.2) | `loggerWithPolicy` in `server.ts` spreads `LOG_POLICY` **last** over any caller-supplied logger; `false` alone passes through. `error-logging.test.mjs` asserts a caller-supplied `serializers.err` is ignored. Without this row the two below are untestable — a test would configure the serialiser it then asserts |
| An `ApiError` with a cause logs one `warn` line; without one, nothing (§1.2) | `error-logging.test.mjs`: a route throwing `ApiError("NOT_FOUND")` produces zero lines, one throwing `ApiError("CONFLICT", {cause})` produces exactly one at level 40. Verified by violation — logging unconditionally fails the first |
| The cause chain reaches the log structured, not flattened (§1.2) | `serializers.err: pino.stdSerializers.errWithCause` in `LOG_POLICY`, plus assertions that `err.message` is the constant alone, `err.cause` is an object, and a second-level `err.cause.cause` is walked. Verified by violation — the default `err` serialiser fails three cases |
| All ten codes of §1.1 exist, each with a status and a message | `packages/shared/src/index.ts` holds the union; `STATUS` and `MESSAGES` in `error-envelope.ts` are `satisfies Record<ErrorCode, …>`, so a code missing from either does not compile |
| `details` cannot express a field *value* (§1.1) | `ErrorDetails` in `packages/shared`, spelled canonically in §1.1. The type is the enforcement: `tsc` rejects `details: {kind: "…"}` at the throw site — verified by probe. `http.test.mjs` pins the wire shape, that it gains no siblings, and that it is absent rather than `undefined` when unset. **Note what it does not claim:** a value can still be put *in the list*, and the test asserts that rather than implying otherwise |
| No framework 4xx collapses to `INTERNAL` (§1.2) | `test/framework-4xx.test.mjs`, 19 cases: oversized body → 413, unmatched and absent `Content-Type` → 415, malformed and empty JSON → 400, plus a sweep asserting no case answers `INTERNAL` or a non-4xx. The reply status is `STATUS[code]`, never the number keyed in the inverse table, so a wrong row cannot produce a status and a code that disagree |
| An unmapped 4xx is a loud `INTERNAL`, not a quiet 400 | No fallback in the inverse table; verified by probe — a `410` returns `INTERNAL`, a `503` returns `INTERNAL`, and a method mismatch is a `404` rather than an unmapped `405` (§1.1) |
| A validation failure logs a projection, not the error (§1.2) | `projectValidation` in `error-envelope.ts`, plus `test/error-logging.test.mjs`: a wired half against real AJV, and a by-construction half feeding `data`, an interpolated `message` and a hostile `params` that a `verbose: true` or custom-keyword configuration would produce. Every case asserts the entry's keys against a whitelist, so widening the projection fails here. Measured against the previous `{ err: error }`: 7 of 8 cases fail |
| The `INTERNAL` path stays complete inward (§1.2) | Same file: asserts the `500` log line carries the thrown message and a stack while the wire stays `{code:"INTERNAL"}`. It exists because the way to break this rule is to "finish" the projection above |
| `ErrorCode` is a client-importable contract (§1.4) | Declared in `packages/shared`, imported by the adapter. Architecture §4 decision 5 enforced in both directions: `eslint.config.js` restricts `@vitrina/shared` from `src/domain/**` and `src/application/**` |
| Imports point inward only (vitrina-server-architecture.md §1) | `eslint.config.js` boundary rule; fails `pnpm lint` |
| No sequential-only streaming construction | `scripts/check-forbidden-constructions.sh` |

The suite is hermetic — `app.inject()`, no Docker, no network — so it belongs in
CI's `checks` job, which the workflow keeps free of infrastructure on purpose.

### 6.2 Owed — a rule in this document with no code behind it

Each row names the assertion, not just the gap, so that writing it is mechanical.

| Rule | What is owed |
| ---- | ------------ |
| §1.2 chain a message you wrote, not a driver error verbatim | **Prose only, and structurally unenforceable here** — the reason it is worth a row rather than a note. The handler cannot inspect a chained message and tell a submitted value from an authored one, so no assertion in `error-logging.test.mjs` can close this; that file instead asserts the *absence* of a guarantee, so nobody reads the `ApiError` branch as making one. The nearest thing to enforcement arrives with PR 3's repository adapter, where a real `pg` error is first available to chain: extend §7.5's per-route log test to the `CONFLICT` path and assert the submitted value is absent from every line. Until then this is review discipline, and the rule is written on `ApiError`'s `cause` doc comment because that is where someone chaining a driver error is looking |
| §1.2 the `429` row is unasserted provision | The status → code table maps `429 → RATE_LIMITED` ahead of any code that can raise one, on §1.1's "a code registered late is a `500` in the meantime". `framework-4xx.test.mjs` cannot exercise it. Owed with §7.6: assert it against the real limiter, and check first whether that limiter builds its own reply — `@fastify/rate-limit`'s `errorResponseBuilder` never reaches `setErrorHandler`, which would make this row inert while looking live |
| §2 the `/v1` mount exists | A test that fails when the mount is removed *and* is not about error handling: register a probe route through `v1Plugins`, assert it answers at `/v1/<path>` **and** 404s at `/<path>`. The second half is what makes it about the prefix |
| §4.1 no key material in any parameter | **Prose only.** The route-table walk brief §12 promises. PR 2 gives it **two** subjects, not one: §7.7's create-recipient accepts wrap material and must accept no passphrase, and §7.5's `/signup` accepts the wrapping every album key in the account hangs off and must accept neither the password nor `K_master`. The second is the higher-consequence body in the system, so the walk should be written against it rather than demonstrated on the easier one |
| §4.3 no credential route reveals whether an account exists | **Prose only, and two thirds of it is not assertable by shape.** The `code`/status/body halves are ordinary tests once the routes exist — `/login` answering `401 INVALID_CREDENTIALS` identically for a wrong proof and an unknown address, `/login/params` answering `200` for both. **Timing is the hard half**: a test that measures it is flaky, and one that does not measure it proves nothing about the property that matters. Owed: assert the *structure* that makes timing equal — that the dummy verification runs on the miss path and that the lookup precedes any branch — rather than asserting a duration. Signup is out of scope by §4.3 |
| §4.2 no delete before storage objects | **Prose only.** Needs the delete use case, PR 3 |
| §7.2 no token in a query string | A test walking the route table asserting no route declares a `token`, `access_token` or `key` query parameter |
| §7.5 no request body reaches a log, on any route | The redaction list covers two *headers*. PR 2 introduces the first routes whose **body** carries a shared secret. Nothing today logs a body — pino's default serialisers log method and URL — but nothing stops it either. Owed: a test that POSTs a distinctive secret to `/login`, captures the log stream, and asserts the secret is absent from every line. **`/signup` is now the better subject**, since its body carries a proof *and* wrap material, so the same test covers more per assertion. **Scoped to the validation and success paths, not `INTERNAL`** (§1.2): a secret reaching a log through a `500` means someone interpolated a request value into a throw, which is a throw-site bug the handler cannot police. Because §1.2's projection rule is global, this test states a property of every route. **Its paired row is discharged** — the projection landed 20 August 2026 (§6.1), so this row is now a single change rather than half of one, and what it waits on is the route |
| §7.5 signup's two writes are one transaction | An owner row with no `owner_keys` row can authenticate and decrypt nothing, and no route can repair it — the relay cannot reconstruct a wrapping it never had. Owed: a test that fails the second insert and asserts the first is rolled back. **Needs the Phase 1 migration**, since neither the `owners` columns nor `owner_keys` exist yet, which is why this is a row rather than code |
| §7.6 the limiter on the three unauthenticated routes | Not built, and now three routes rather than one — `/signup`, `/login/params`, `/login` (§7.6). Note it is in-process state: correct on one instance, silently broken on two (PR 5 states this as a general property; it is true from the moment this limiter exists). `/login/params` must be limited on §4.3's grounds and not on cost — it is a lookup and an HMAC, so a limiter added "where the expensive work is" would skip precisely the route whose protection is an enumeration property rather than an allocation |

**Four rows were deleted here, 20 August 2026**, on the same principle as the
deletion below — a discharged owed row is errata, and a reader who finds one
assumes the gap is still open. They moved to §6.1: §1.1's six missing codes,
§1.2's framework-4xx test, §1.2's validation projection, and §1.4's home for the
union.

**Two more were deleted, 21 August 2026** — "the cause chain reaches the log"
and "an `ApiError` logs nothing at all". Both are now code and sit in §6.1, with
a third row for the log-policy ownership the first one turned out to need. The
first row also carried a **wrong measurement**, corrected in §1.2 rather than
carried forward: pino's default serialiser flattens a cause chain, it does not
drop it. Note what that correction did to the shape of the work — it turned a
missing-diagnostics row into a live #15 exposure, and the row now at the top of
this table is what replaced it. A gap discovered by disproving a row is worth
more to this table than the row was.

**A subsection was deleted here.** PR 1 carried a "Deviations from
vitrina-server-architecture.md, to be reconciled" list — `buildServer`'s signature, the
missing `config.ts`, the empty port files. Architecture §9 reconciled all three
at source on 12 August 2026, so the list had become errata for a document that is
now correct, which is worse than no list: a reader who finds it assumes the
deviations are live. Deleted rather than annotated.

---

## 7. Authentication — two schemes, and the credential lifecycle of each

**PR 2.** Everything from here down is the auth model every later route's
contract assumes. It defines seven routes — five of them owner-credential routes
in §7.5 — and the routes that *consume* recipient authentication begin in PR 3.

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

**Three routes never enter this ladder at all** — `/signup`, `/login/params` and
`/login` are unauthenticated by construction (§7.5), so there is no token to parse
at step 1 and no scope to resolve at step 3. Worth stating because the steps below
read as universal: applying step 1 to `/login` would answer `401 UNAUTHENTICATED`
for a caller with no session, which is the correct code for a *missing* session
and the wrong one for a route whose entire purpose is not having one. Their
failure codes are in §7.5 and their enumeration property is §4.3's, not step 3's.

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

That is unchanged by §1.1 settling the shape as `ErrorDetails` on
21 August 2026, and the two decisions are worth keeping apart: the shape says what
`details` may contain **if** a route sends one, and this paragraph says no route
in PR 2 sends one. **A field name is safe from #15 and still unsafe from §4.3** —
`{fields: ["proof"]}` on `INVALID_CREDENTIALS` echoes nothing a client submitted
and tells an attacker the address exists. The new type does not weaken this rule
and must not be read as licence to start populating it here.

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

**`/login` is the only route that mints one, and `POST /signup` deliberately does
not** (§7.5). Signing up does not sign you in. Returning a token from signup is
the obvious convenience and it would put session minting in two places — two
`expires_at` values to keep in step, two places to audit against the window in
§7.5, and a second route to change when that window does. The cost is one extra
round trip on the rarest action an owner performs.

Note this is about the *session* token only. `/signup` does carry key material
into the system — the wrapping of `K_master` — but that is client-generated
ciphertext the relay stores and cannot read, which is a different question from
who mints a credential. §4.1 is where that distinction is enforced.

### 7.5 The owner credential lifecycle — account and sessions

```
POST /v1/signup
POST /v1/login/params
POST /v1/login
POST /v1/logout
POST /v1/logout/all
```

**Retitled and grown from three routes to five, 21 August 2026.** This section
was "Owner sessions" and covered the last three. Brief §11 and §12 closed the two
decisions that made an account impossible to specify (§5.1, §5.2), and the answer
adds two routes ahead of `/login`: an account has to be created, and a login proof
derived client-side needs a salt and parameters before it can be computed. They
land here rather than in a new section because §0 fixes section numbers
permanently, and because splitting the owner's credential lifecycle across two
places is how the two schemes get conflated later. §7.1–§7.4 apply to all five and
are not restated.

**No refresh endpoint, and that is still deliberate.** `/login` issues, `/logout`
revokes, and every request re-checks `expires_at` and `revoked_at` (§7.3, step 2);
a session ends by lapsing or by being revoked, and it is renewed by logging in
again. A refresh route would be the natural way to make the two-week window
shorter without adding friction — which is exactly why its absence is written
down rather than left to be inferred from a list of routes. It lengthens the
period in which a stolen token remains useful, and it is the first thing that
would make the window's provisional value (below) feel settled without anyone
having settled it. Note the §5.1 framing has changed: this used to read "a
decision about §5.1", and §5.1 is closed. It is now a decision about the window
alone, which is a smaller argument and no longer waiting on anything.

---

**`POST /v1/signup`** — no authentication. `201` on success.

**The highest-consequence body in the system**, and the reason it is stated
before `/login` rather than after. It accepts the wrapping that every album key
in the account hangs off (encryption spec §6.6.2):

- the address **exactly as typed, unnormalised** — see `/login/params` below for
  why any client-side normalisation is forbidden;
- the **login proof**, never the password;
- the **client's KDF salt and parameters**, which become the first `owner_keys`
  row. **The relay's own Argon2id parameters are NOT in this body and must never
  be** — the relay generates its `auth_salt` and chooses its own figures. A
  client-supplied work factor would let a client set the work factor protecting
  it, which is precisely the threat that layer exists to answer (§5.2);
- **`wrapped_master` and `wrap_nonce`.**

**This is the second route that accepts wrap material**, alongside §7.7's
create-recipient, and it is what gives §4.1's route-table audit a subject with
real consequences. The distinction that audit must encode: **a wrapped blob is
ciphertext and may be posted; the key that wrapped it, and the secret that
derived that key, may never be.** Both routes carry the first and neither may
carry the second. `K_master` and the password are both absent from this list, and
their absence is the whole design — non-negotiable #16.

- **The account row and its first `owner_keys` row are created in one
  transaction.** An owner with no wrapping is an account that can authenticate
  and decrypt nothing — a state no route can repair, because the relay cannot
  reconstruct a wrapping it never had. Stated as a route property rather than
  left to the repository, since "insert the owner, then insert the key" is the
  natural implementation and it is a partial-failure bug that looks like success.
- **`201`:** the owner id and `created_at`. **No token** — signup does not sign
  you in. Logging in afterwards costs one round trip and keeps `/login` the only
  route that mints a session (§7.4), so there is one place where `expires_at` is
  set and one place to audit.
- **Errors:** `400 VALIDATION_FAILED` · `409 CONFLICT` (address already
  registered) · `413 PAYLOAD_TOO_LARGE` · `415 UNSUPPORTED_MEDIA_TYPE` ·
  `429 RATE_LIMITED`.
- **The `409` is exactly what §4.3 carves signup out for.** It reveals that the
  address exists, cannot be made not to in v1, and is recorded as a limitation in
  brief §11 rather than papered over here.
- **Response `Cache-Control: no-store`**, on the same reasoning as `/login`
  below: the request carried a credential-derived value, and nothing in brief §10
  reaches a non-ciphertext response.

---

**`POST /v1/login/params`** — no authentication. **Always `200`.**

**Why this route exists at all**, since a route whose purpose is unclear is a
route someone will fold into `/login` as an optimisation. Deriving the login
proof client-side requires the salt and Argon2id parameters *before* anything can
be computed, so login is **two round trips** by construction (encryption spec
§6.6, decided 20 August 2026).

The alternative — deriving the salt from the email address to save the trip — was
rejected, and the reason belongs here because this route is where someone will
propose it again. Parameters live per-row on `owner_keys` precisely so they can be
raised without invalidating existing accounts (§5.1), and the client needs them
before deriving; **the only way to reach one round trip is to make them a global
constant**, which forfeits the property the table exists for. And "a hash of the
normalised address" hides a specification — Unicode local parts, IDN domains,
case-folding that differs by language — which would have to agree byte-for-byte
across Rust, TypeScript, Swift and Kotlin, permanently. Disagreement yields a
different salt, a different KEK, and a `K_master` that will not unwrap: an account
nobody can open, retroactively. Every other cross-implementation disagreement in
this system costs an invite a parent can reissue; that one costs an album
collection.

- **Request: the address exactly as typed.** **Clients MUST NOT normalise it at
  all** — no trimming, no `toLowerCase()`, nothing. Any client-side transformation
  reintroduces the agreement problem in a weaker form: a client that lowercases
  differently from the relay produces a lookup miss rather than an unopenable
  account. Recoverable, and there is no reason to have it. Normalisation is still
  required — the relay must normalise before looking up an address and before
  computing a decoy — but it happens **entirely server-side and crosses no client
  boundary**, so a relay that gets it wrong holds plaintext addresses and can
  migrate. Four disagreeing clients cannot be repaired.
- **`200`:** the **client's** `kdf_salt` and its three Argon2id parameters, from
  the caller's `owner_keys` row. Nothing else, and nothing that varies with
  whether the account exists.
- **The relay's parameters are never returned here.** They are the relay's
  business and the client has no use for them (encryption spec §6.6): the client
  derives a proof, and what the relay then does to that proof is not an input to
  any client computation. Returning them would leak the relay's work factor to an
  unauthenticated caller for no purpose. **This route returns one of the two
  parameter sets, and the reader has to know which** — §5.2 has the table.
- **Unknown addresses get deterministic decoys** — `HMAC(server_secret,
  normalised_address)` truncated to 16 bytes — so repeated attempts return the
  same salt. A varying salt is itself an oracle. **The lookup runs
  unconditionally** and the substitution happens on miss; branching before the
  query is a timing oracle. See §4.3.
- **Decoy indistinguishability is conditional, and the condition is invisible
  here.** It holds because every `owner_keys` row carries identical KDF values, so
  a decoy has nothing to distinguish itself from. **It degrades the moment
  parameters differ between accounts** — which is exactly what per-row storage
  exists to enable. **This note belongs next to the code, not only in a
  document**: whoever raises parameters for one account in Phase 2 will not be
  reading this section.
- **The decoy server secret is not a rotatable credential.** Rotating it moves
  every decoy salt while real salts, being stored, stay put — so anyone who
  recorded earlier responses learns which addresses exist by comparing across the
  rotation. It belongs in the same operational category as the database and must
  be backed up with it. **Absent at boot MUST be a hard error**, never
  generate-if-missing: that is the ordinary implementation and it destroys the
  property silently on every restart, with nothing failing while it happens. Brief
  §6 non-negotiable #17.
- **Rate-limited on the same IP basis as `/login`** (§7.6). An oracle that cannot
  be distinguished but can be queried without limit is still a harvesting surface.
- **Errors:** `400 VALIDATION_FAILED` · `413` · `415` · `429 RATE_LIMITED`. **No
  `404`, ever** — that is the whole point of the route.

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

- **Request body: the address exactly as typed, and the login proof.** **The
  labelled gap this bullet used to carry is closed** — brief §12 settled the
  account model as email and password on 20 August 2026 (§5.2). Every other
  property of this route was already fixed and did not move, which is what the
  gap was labelled to make visible.
- **The password is not in that list, and its absence is the design.** The client
  derives the proof locally, using the salt and parameters from `/login/params`,
  and sends only the proof (encryption spec §6.6). This is not hardening: the KEK
  is derived from the password, so a relay that receives the password could
  compute the KEK itself — *able* to unwrap while merely choosing not to.
  Non-negotiable #16 forbids transmitting derived keys; transmitting the input
  they are derived from is the same thing by another route. **The proof is still a
  bearer-equivalent secret** and is covered by the no-body-in-logs rule below.
- **The relay applies its own Argon2id to the proof** and compares against
  `owners.auth_hash` (encryption spec §6.6, schema §3). **This was flagged as
  ambiguous earlier on 21 August 2026 and is now settled** — see §5.2, including
  why the fast-hash reading this document briefly argued for was wrong. The
  practical consequence for this route is only that §7.6's cost argument holds;
  the request and response shapes are unaffected either way.
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

**`/login` must not reveal whether an account exists — §4.3.** The rule is stated
there rather than here, because brief §12's account model made it span two routes
and a rule restated per route is a rule that drifts. What is specific to `/login`:
the wrong-secret and unknown-address answers are both `401 INVALID_CREDENTIALS`
with the same body, and the verification runs **against a dummy value when the
account is absent** rather than returning early. `/login/params` above satisfies
the same constraint by a different mechanism, and `POST /signup` is explicitly
outside it.

**The request body never reaches a log, and this is the route that forces the
rule.** The proof is a shared secret, and `/login` is the first route in the
system whose *body* holds one — the redaction list in §6.1 covers two headers and
nothing else. `/signup`'s body now holds more (wrap material and a proof), so the
rule has a second subject from the same amendment. §1.2 settles the mechanism, and
settles it **globally rather than for this route**: a validation failure logs a
projection of `instancePath`, `keyword` and `schemaPath` — plus
`params.missingProperty` on `required` alone, per §1.2's keyword-specific
exception — and never the error object, never `message`, never `data`. Route-local
suppression was rejected for the usual reason: it would require a route author to
know their body is sensitive, and forgetting the flag would be silent.

**The mechanism is in place as of 20 August 2026**, and it is now safe *by
construction* rather than safe under today's AJV: the payload is built from a
whitelist, so `verbose: true` or a custom keyword changes nothing about what
reaches a log line. What this row still owes is its own half — the test that POSTs
a real secret to this route and reads every line of the stream — and that needs
the route.

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

**Three routes have no token to key on, not one.** `POST /signup` and
`POST /login/params` joined `/login` in the 21 August 2026 amendment, and all
three are unauthenticated by construction. The section keeps its title because
`/login` is the route the reasoning was written for; the limiter covers all
three, on the same IP basis.

**The `/login` limiter is not optional hardening.** §7.5's dummy-value mitigation
means every attempt against an unknown account runs the **same full Argon2id
verification** a real one does — that is the point of it — and therefore an
unauthenticated caller can force one allocation per request, at whatever the
**relay's** Argon2id parameters turn out to be (§5.2). The limiter bounds a
memory-exhaustion vector the product created deliberately. **State that, or it
reads as friction and gets removed.** The argument deliberately names no number,
so it holds whatever those parameters land on.

**A flag stood here for part of 21 August 2026 and is discharged.** It warned that
"full Argon2id verification" is only true if the *relay* runs Argon2id, and that
under a fast-hash reading this paragraph's whole justification evaporated.
**Encryption spec §6.6 settled it the same day: the relay applies its own Argon2id
to the proof it receives**, so the argument holds and the original wording is
restored rather than kept hedged. Recorded rather than silently reverted, because
the hedged wording ("the same verification a real one does") is what a reader
would otherwise find in the history and mistake for the current rule.

Two consequences for this section specifically. The parameters bounding this cost
are the **relay's**, sized for a server under concurrency — not the client's,
which are bounded by a mobile WASM heap and never reach this route (§5.2's table).
And the relay's layer exists *because* a proof's entropy is a claim the relay
cannot verify, which means the cost is not optional: removing it to relieve the
limiter would remove the property the limiter protects.

**Keyed on IP, and this is the one place that is right.** Every other limit in the
system keys on the token hash, because a family behind one NAT shares an address
and mobile data changes it mid-session (PR 5). These three routes have no token to
key on, which makes them both the obvious targets and the only routes otherwise
unlimited. The NAT objection is weak here: a family makes a handful of login
attempts a day, and **10 per 15 minutes per IP** — provisional — inconveniences
nobody while slowing credential stuffing. If you decide not to limit them, say so
explicitly rather than leaving the gap silent.

**`/login/params` needs the limit for a different reason, and it is worth
separating.** It is not protecting work — the route is a lookup and an HMAC. It is
protecting §4.3: the decoys make existence undetectable per response, and an
attacker who can query without limit harvests the address space anyway. A limiter
sized only against Argon2id cost would reasonably be relaxed on this route, which
is exactly the mistake to foreclose. **Same IP basis, same numbers, different
justification.**

**The limiter is in-process state.** Correct on one instance, silently broken on
two. PR 5 states this as a general property of the rate limiting in this system;
it is true from the moment *this* limiter exists, three sections earlier, so
nobody should add Redis to Phase 0 or scale to two instances without noticing.

**`Retry-After` must be in `Access-Control-Expose-Headers`** or a cross-origin
client cannot read the interval it is being asked to wait for (§3.1). These are
the first routes in the system that can produce a `429`.

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

### 7.9 The seven routes, in one table

**Five rows became seven, 21 August 2026** — `/signup` and `/login/params`, per
§7.5. `/login`'s body is no longer a gap.

| Route | Scheme | Body | Success | Errors |
| ----- | ------ | ---- | ------- | ------ |
| `POST /v1/signup` | none | address as typed · proof · **client** `kdf_salt` + params · `wrapped_master` · `wrap_nonce` (§7.5) — never the relay's params | `201` `{id, created_at}`, `no-store` | 400 · 409 `CONFLICT` · 413 · 415 · 429 |
| `POST /v1/login/params` | none | address as typed (§7.5) | `200` — the **client's** `{kdf_salt, params}` only, **always**, decoys on miss | 400 · 413 · 415 · 429 |
| `POST /v1/login` | none | address as typed · proof (§7.5) | `200` `{token, expires_at}`, `no-store` | 400 · 401 `INVALID_CREDENTIALS` · 413 · 415 · 429 |
| `POST /v1/logout` | owner | none | `204` | 401 |
| `POST /v1/logout/all` | owner | none | `204` | 401 |
| `POST /v1/albums/{album_id}/recipients` | owner | §7.7 | `201` `{id, created_at}` | 400 · 401 · 404 · 409 · 413 |
| `POST /v1/recipients/{recipient_id}/revoke` | owner | none | `200` `{revoked_at}` | 401 · 404 |

All seven carry the `/v1` prefix from the single mount point (§2) and none writes
it itself. **Three are unauthenticated**, all three at the top, and all three are
rate-limited on IP (§7.6) — the only routes in the system without a token to key
on. **No route here is recipient-authenticated:** PR 2 defines what a recipient
credential is and how it is checked, and PR 3 is where the first route consumes
one. `403 ACCESS_REVOKED` is therefore registered in this PR and first reachable in
the next (§1.1).

**Two rows carry wrap material** — `/signup` and create-recipient — and they are
§4.1's audit subjects. Neither carries a passphrase, a password, or a KEK.

**`/login/params` is the only route in the system that cannot answer `404`.** Not
an omission from the errors column: §4.3 is why, and a `404` there would defeat
the route's only purpose.

### 7.10 What PR 2 deliberately does not decide

- **The owner password's Argon2id parameters** — §5.2. **`POST /login`'s request
  body is no longer on this list**: brief §12 closed the account model and §7.5
  states the body. What remains is **the numbers, in two sets** — the client's and
  the relay's (§5.2's table) — both encryption spec §6.6's to settle. **The
  coupled ambiguity about *what verifies the proof server-side* is no longer on
  this list**: §6.6 settled it on 21 August 2026, the relay applies its own
  Argon2id, and §7.6's cost argument holds unchanged as a result.
- **Whether `recipients.label` is encrypted** — §5.3. **No longer described as
  coupled to §5.1**, which is closed and closed in the direction that dissolves
  the coupling; it is simply undecided. §7.7 accepts the field as plaintext today
  and the field's *shape* is what would change, not the route's. Deferring costs a
  client-side lazy migration later, per §5.3.
- **Whether an owner ever authenticates as a recipient of someone else's album**
  — brief §11's "recipients will become owners". The tagged union in §7.1 is chosen
  so that this is additive: a nullable FK from `recipients` to `owners` changes no
  wire shape here.
- **Recipient-side rate limits** — PR 5, keyed on the token hash. Only `/login`'s
  limiter is settled here, because only `/login` has no token to key on.
- **The passphrase key-material route** — PR 4. It is the only route that *returns*
  key-adjacent material, and §7.7's create is its mirror image: this PR settles how
  a wrapped blob is stored, PR 4 settles how it is handed back.

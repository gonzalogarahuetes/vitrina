# Vitrina — API Surface Sketch

**Status:** Draft · 13 September 2026 · **all six parts written — PR 1 (frame), PR 2 (auth model), PR 2b (owner account bootstrap), PR 3 (owner flow), PR 4 (recipient key material), PR 5 (delivery and the access log)**
**Implements:** `vitrina-track-b-plan.md` §3 B.6
**Companion to:** `vitrina-project-brief.md`, `vitrina-schema.md`, `vitrina-invite-spec.md`, `vitrina-server-architecture.md`

---

## 0. Scope, and what this document is not yet

B.6 was written in six reviewable parts, **all now present.** §1–§6 are the
cross-cutting rules every route obeys regardless of what it does; §7 and §8 the
authentication model and the owner account's bootstrap; §9 the owner flow; §10
the recipient's key material; §11 delivery and the access log. §11.8 is the one
table listing every route.

| PR  | Covers                                                                                                                                                                                   | Status                    |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- |
| 1   | Error envelope, `/v1`, CORS, the three standing constraints, open questions                                                                                                              | **§1–§6**                 |
| 2   | Both auth schemes and the full credential lifecycle of each — `/login`, `/logout`, `/logout/all`, recipients create and revoke                                                           | **§7**                    |
| 2b  | Owner account bootstrap — `/signup` and `/login/params` to the level a route author needs, the owner's wrapped-key fetch, the owner KDF parameters, the decoy scheme's operational rules | **§7.5 (amended) and §8** |
| 3   | Owner flow — albums, album details, album encrypted metadata, media create/status, upload                                                                                                | **§9**                    |
| 4   | The passphrase key-material route — the only route that returns key-adjacent material to a _recipient_                                                                                   | **§10**                   |
| 5   | Ciphertext delivery, `Range` handling, the access log, rate limiting, the recipient's own row, the full route table                                                                      | **§11**                   |

**PR 2b was carved out of PR 2 after the fact, 13 September 2026.** The 21
August amendment had already placed `/signup` and `/login/params` in §7.5, with
their decoy scheme, the decoy secret's operational rule and the one-transaction
rule — so the two routes were _described_ before PR 2b existed. What they lacked
was the level below prose: field names, encoded lengths, the server-side
normalisation rule, a parameter set to validate against, and the route by which
an owner gets their wrapped `K_master` back after logging in. Without the last of
those an owner can authenticate and decrypt nothing, which is exactly the state
§7.5's one-transaction rule exists to prevent on the write side and nothing
prevented on the read side. PR 2b is therefore two things: an amendment pass on
§7.5 and §7.9 to the level of §7.7's field table, and a new §8 for what §7.5 had
nowhere to put. It is reviewed separately for the reason PR 4 is: signup accepts
the wrapping every album key in the account hangs off, and the owner-key fetch
returns it, and neither belongs inside the largest diff in the set.

**An earlier draft of that table described four parts**, with recipients
create/revoke inside PR 3's owner flow and delivery in PR 4. The split is now
five, for two reasons worth recording. Recipient create and revoke moved into
PR 2 because their rules are _credential_ rules — a client-minted token, a hash
that must never arrive in plaintext, a revocation that must not cascade — and
they read as arbitrary next to album CRUD. And the passphrase key-material route
was isolated as PR 4 so that the one route in the system which hands out
key-adjacent material is not reviewed inside the largest diff in the set.

**Sections are appended in PR order and never renumbered.** Other documents cite
this one by section (`vitrina-server-architecture.md` §8 cites §1.2), so §1–§6
keep their numbers permanently and each later PR adds sections after them. That
is why the enforcement ledger in §6 — which is cross-cutting and grows with
every PR — sits _before_ PR 2's material in §7 rather than at the end.

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
still owed. **For PR 2b the bar is the field level**: §7.5 now carries a field
table per credential route matching §7.7's, and §8 adds the eighth owner route.
**For PRs 3–5 it is met on paper as of 13 September 2026** — every route in §11.8
has a path, a scheme, a body or its absence, a success shape and an error list,
and §6.2 records that none of it is code yet.

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
changes: the relay's peppered fast hash over the proof is now stated wherever it
bears on a route (§5.2, §7.5, §7.6), and **`details`'s type is spelled once,
canonically, in §1.1** — it had acquired three spellings in a day, one of them
the type §1.1 exists to reject.

**Corrected again**, after §6.6 fixed the relay's side as `HMAC(pepper, proof)`
rather than a KDF. This document had spent a day stating the opposite in five
places, and every one of them is now the peppered form: there is **one KDF
parameter set, client-side**, and no server-side figure to size, store or
withhold. §7.6's cost argument does not survive that and is rewritten rather
than patched — see there.

**The Phase 1 migration named above now owes two things beyond the new tables**,
both recorded in schema §3 rather than here, and both cheaper to do in that
migration than after it:

- **`owner_keys` KDF floors.** The table floors nothing today, while `recipients`
  floors all three integers — the constraint was applied to the lower-consequence
  table and not the higher one.
- **An `ALTER` correcting `recipients`' floors.** The applied
  `001_initial_schema.sql` ships the v1 _chosen_ values (`>= 65536`, `>= 3`) where
  floors belong (`>= 16384`, `>= 2`). Schema §0 makes that a bug in one of the
  two; the migration is the bug, and an applied file is not edited to fix it.
- **PR 2b adds two more, 13 September 2026** (§8.2, §8.3): `owners.email` holds
  the _normalised_ address and carries the `UNIQUE`; and `owner_keys` needs a
  credential-kind discriminator with exactly one password row per owner, since
  `/login/params` and `/owner/key` both select by it. Both are recorded here as
  things this document needs of schema §3, not as schema decisions made here.

**This document is a design record; the code is the contract.** Its value is the reasoning — why `/login/params` exists, why §7.6's limiter survives the pepper correction, why `409` is carved out of §4.3 — none of which a generated schema carries. The client-importable contract is `@vitrina/shared`'s types (§1.4); the Fastify schemas are §4.1's audit surface, not a publication. §6's ledger presumes this: rows move from §6.2 to §6.1 as tests land, which only means something if the code is what is true. **The cost is silent rot in the field tables,** mitigated because the length tests pin those exact numbers. Revisit when Swift and Kotlin exist — Phase 4.

---

## 1. The error envelope

**One shape, every error, no exceptions.**

```jsonc
{
  "code": "ACCESS_REVOKED", // stable, machine-readable, the client's contract
  "message": "Access has been revoked.", // developer-facing English
  "details": { "fields": ["kind"] }, // optional; field *names* only, never values
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
that _the type is the enforcement_ cannot be loose about the type. Same discipline
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
class: a name is safe because _our schema declared it_.

Two limits, stated rather than implied. A value can still be _placed in the
list_ — the type forecloses the shape that made echoing natural, not a throw site
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

| `code`                   | Status | Registered by | First reachable                                                                                                                                                                                                  |
| ------------------------ | ------ | ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `VALIDATION_FAILED`      | 400    | PR 1          | PR 1 — any schema failure, and framework 400s (§1.2)                                                                                                                                                             |
| `UNAUTHENTICATED`        | 401    | PR 1          | PR 2 — missing, unknown, expired or revoked **owner** token (§7.3)                                                                                                                                               |
| `INVALID_CREDENTIALS`    | 401    | PR 2          | PR 2 — `POST /login` only (§7.5)                                                                                                                                                                                 |
| `ACCESS_REVOKED`         | 403    | PR 2          | PR 3 — a revoked **recipient** on their own album (§7.3; §9.4, §9.5)                                                                                                                                             |
| `NOT_FOUND`              | 404    | PR 1          | PR 1 — unknown route; PR 2 adds out-of-scope album and recipient                                                                                                                                                 |
| `CONFLICT`               | 409    | PR 2          | PR 2 — duplicate `id` or `token_hash` on recipient create (§7.7); also a duplicate address on `POST /signup` (§7.5); PR 3 adds duplicate `albums.id` and `media.id`, and upload after `ready` (§9.2, §9.6, §9.7) |
| `LENGTH_REQUIRED`        | 411    | PR 3          | PR 3 — an upload without `Content-Length` (§9.7). Handler-thrown, not a framework code                                                                                                                           |
| `RANGE_NOT_SATISFIABLE`  | 416    | PR 5          | PR 5 — a range starting at or beyond the object's end on the asset route (§11.2). Handler-mapped from the store's `InvalidRange`, not a framework code                                                           |
| `PAYLOAD_TOO_LARGE`      | 413    | PR 1          | PR 2 — `bodyLimit` on the first route with a body; PR 3's upload route depends on it                                                                                                                             |
| `UNSUPPORTED_MEDIA_TYPE` | 415    | PR 1          | PR 2 — `POST /login` with a `Content-Type` no body parser matches                                                                                                                                                |
| `RATE_LIMITED`           | 429    | PR 1          | PR 2 — the `/login` limiter (§7.6)                                                                                                                                                                               |
| `INTERNAL`               | 500    | PR 1          | PR 1                                                                                                                                                                                                             |

**"Registered by" means "the PR whose prose puts this code in the union" — not
"present in the union today."** Both columns are statements about _this document's_
scope; neither says anything about the implementation. Read a `PR 1` in this
column as "PR 1 owes it", never as "PR 1 shipped it" — a distinction that matters
again the moment PRs 3–5 add a row.

**The first ten rows exist in the union as of 20 August 2026**, in
`packages/shared/src/index.ts` (§1.4), each with a `code → status` and a
`code → message` entry. **`LENGTH_REQUIRED` (PR 3) and `RANGE_NOT_SATISFIABLE`
(PR 5) are owed** — registered by prose on 13 September 2026, not yet in the
union; §6.2 carries the row. An earlier version of this paragraph said six of the ten
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
  afterwards is a breaking contract change. The sentence _"this album is no
  longer shared with you"_ is the **client's** rendering of this code, in the
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
- **`details` may carry field _names_, never field _values_.** It is typed
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
_and quotes its value_. **It does not** — verified against `fastify@5.11.3` with
Fastify's default AJV configuration:

| Submitted                                    | `message`                                              | `params`                        |
| -------------------------------------------- | ------------------------------------------------------ | ------------------------------- |
| `{"email":"S3CRET"}` against `format: email` | `body/email must match format "email"`                 | `{"format":"email"}`            |
| `{"kind":"S3CRET"}` against an `enum`        | `body/kind must be equal to one of the allowed values` | `{"allowedValues":["a","b"]}`   |
| `{"n":999}` against `maximum: 5`             | `body/n must be <= 5`                                  | `{"comparison":"<=","limit":5}` |

`instancePath` is a field name, `params` carries **schema-side** values only, and
Fastify's default `removeAdditional: true` strips an unexpected key rather than
erroring, so not even a client-chosen _key name_ reaches the error. The value
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
  that keyword's `params` names something _we_ wrote, one keyword at a time.

**This binds the validation path only, and the `INTERNAL` path is asserted to be
untouched by it** — `error-logging.test.mjs`, because the way to break that rule
is to "finish" this one. An unrecognised error is logged whole: `request.log.error(error)`,
a stack, and no projection.

A stack is the entire diagnostic value of a `500`. A request value reaching a log through
_that_ path means someone interpolated one into a throw — which the first bullet in
this section neutralises for the **wire** and cannot neutralise for the **log**.
That asymmetry is worth naming rather than papering over: it is a throw-site
discipline, not something the handler can police, and sanitising the `INTERNAL`
path would trade the only real diagnostic a `500` has for a guarantee the handler
still could not make.

**§7.5 is where this stops being hygiene.** `POST /login`'s body is the first in
the system to carry a shared secret, and a validation failure on it is the one
place a body value and a log line meet. §6.2 owes the test, and because the rule
above is global rather than route-specific, that test asserts a property of _every_
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

| What arrives                                                     | Maps to                                         | Why                                                                                                                                                                                                                                                                    |
| ---------------------------------------------------------------- | ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `error.validation` is present                                    | `VALIDATION_FAILED` / 400, **constant** message | Fastify's own text names the field, and one AJV option away (`verbose: true`) carries the value too. Rather than depend on that, the whole error is dropped outward and projected to field-path-plus-keyword inward — see above                                        |
| A `FastifyError` carrying a 4xx `statusCode` and no `validation` | the code registered for **that status**         | `413` from `bodyLimit` → `PAYLOAD_TOO_LARGE`; `415` from an unsupported media type → `UNSUPPORTED_MEDIA_TYPE`; a framework `400` (malformed JSON body) → `VALIDATION_FAILED`; a framework `401`, if one ever arrives, → `UNAUTHENTICATED`, never `INVALID_CREDENTIALS` |
| Anything else, including a 5xx `FastifyError`                    | `INTERNAL` / 500                                | Opaque outward, complete inward                                                                                                                                                                                                                                        |

**The rule, stated as a rule:** a `FastifyError` with a 4xx `statusCode` maps to
a code meaning what that status means; only genuinely unrecognised errors become
`INTERNAL`. Collapsing the second row into `VALIDATION_FAILED` is _worse_ than
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
- **The #15 exposure is real, and `errWithCause` WIDENED it.** This bullet said
  the opposite until 21 August 2026 — "moves where the value sits and changes
  nothing about whether it is there" — and that was wrong. Corrected below,
  because it is the reason the rule that follows is not merely hygiene.

**Correction: `errWithCause` copies the cause's enumerable own properties, and
that is where the leak is.** The earlier claim assumed the value lives in the
cause's `message`, where the default serialiser was already flattening it. In a
real `node-postgres` error it does not:

```
message: 'duplicate key value violates unique constraint "owners_email_key"'
detail:  'Key (email)=(victim@example.com) already exists.'
code:    '23505'
```

`detail` is an **enumerable own property**, and so are `code`, `table` and
`schema`. Measured on the installed versions:

| Serialiser     | `cause: pgError`                                                                                                     |
| -------------- | -------------------------------------------------------------------------------------------------------------------- |
| default `err`  | flattens the cause to `message` + `stack` only. `detail` never reaches the log — **the address does not leak**       |
| `errWithCause` | copies own properties through: `err.cause.detail` carries `Key (email)=(victim@example.com)` — **the address leaks** |

So adopting `errWithCause` did not relocate this exposure, it created it for
chained driver errors. That does not reverse the decision — structured causes are
still worth having, and a driver error should never have been chained verbatim —
but it does mean **the rule below is load-bearing rather than tidy**, and it
should have landed in the same change as the serialiser rather than beside it.

**So the rule: chain a message you wrote, not a driver error verbatim.** This is
a #15 guard, not a style note. Wrap it:

```ts
throw new ApiError("CONFLICT", {
  cause: new Error(`owners.email already taken (pg ${pgError.code})`),
});
```

The driver's `code` and constraint name are both safe to name, because they
describe the schema rather than the request. They belong **in the message you
write**, not in a bare `cause` — and the reason is narrower than an earlier
version of this paragraph claimed.

**Second correction: "both serialisers drop a non-`Error` cause" was stated
generally and is true of one of two syntaxes.** It depends on **enumerability**,
not on type:

| How `cause` is set          | Non-`Error` value (e.g. `"23505"`)                                    | `Error` value  |
| --------------------------- | --------------------------------------------------------------------- | -------------- |
| `new Error(msg, { cause })` | **Dropped** by both — the options form defines `cause` non-enumerably | Walked by both |
| `err.cause = value`         | **Retained** by both, string and all                                  | Walked by both |

Both serialisers read `.cause` directly when it holds an `Error`, which is why an
Error cause survives either way; a non-`Error` value is only picked up by
property enumeration. **`ApiError` uses the constructor form**, so for this
codebase the original advice holds and `cause: pgError.code` does vanish. It is
scoped to that rather than claimed of pino in general, and **a test asserts the
form**, so changing that `super(...)` to an assignment fails CI instead of
silently inverting this paragraph.

It sits with the paragraph above as throw-site discipline rather than a handler
guarantee, for the same reason: the handler cannot inspect a chained value and
know whether it was submitted or authored. §6.2 carries what that costs in
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

**The one case a cause-based rule cannot cover is now unreachable, not
discouraged.** `new ApiError("INTERNAL")` with no cause would answer `500` and
log nothing — the single place where the rule above is silently wrong, since a
`500` with no log line is the one error that is useless without one.

This was prose here and **nowhere else**: absent from §6.1, absent from §6.2, and
therefore in the one state §6 exists to prevent — a rule with no enforcement and
no record that it lacks any. The fix costs a type:

```ts
type ThrowableCode = Exclude<ErrorCode, "INTERNAL">;
```

`ApiError`'s constructor takes that instead of `ErrorCode`, so the case is a
compile error and the row moves to §6.1. **Checked before narrowing, because it
would have been circular otherwise:** nothing in `src/` constructs an `ApiError`
with `INTERNAL`, and the `500` envelope is built by `body("INTERNAL")` at the
bottom of `errorEnvelope` rather than by throwing — so the handler does not
depend on the code it can no longer throw. Verified by probe: `new
ApiError("INTERNAL")` fails `tsc`.

Adding a second condition on status (`or status >= 500`) was the alternative and
is worse: it is the handler doing a throw site's job, and it leaves the
throw site able to express a thing it should not. **To signal a `500`, throw
anything else** — a plain `Error` reaches the unrecognised branch, which logs a
stack. That is the diagnostic an `INTERNAL` needs and precisely what an
`ApiError` cannot carry.

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
server, and architecture §4 decision 5 only reads as a rule about the _other_
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

| Setting          | Value                                           | Why                                                                                                                                                            |
| ---------------- | ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `origin`         | exactly one allowlisted origin, from config     | Never `*`, never `true`                                                                                                                                        |
| `credentials`    | `false`                                         | Token in an `Authorization` header, not a cookie — §3.2                                                                                                        |
| `methods`        | `GET`, `POST`, `PUT`                            | Narrow to what the route table needs. **`DELETE` removed and `PUT` added by PR 3** (§9.9) — the upload routes are `PUT`, and nothing in the v1 surface deletes |
| `allowedHeaders` | `Authorization`, `Content-Type`, `Range`        | **`Authorization` explicitly** — the Fetch standard makes it a _non-wildcard_ header, so `*` would not cover it (§3.1)                                         |
| `exposedHeaders` | `Content-Range`, `Accept-Ranges`, `Retry-After` | None is a safelisted _response_ header; the client cannot read them otherwise                                                                                  |
| `maxAge`         | `7200`                                          | Preflight cache. 7200s is the maximum Chrome honours — not a claim about other browsers (§3.1)                                                                 |

**One origin per environment, supplied as configuration, validated at boot.** The
value is parsed with `new URL`, rejected unless `https` or `localhost`, and
rejected if it carries a path, query or fragment. `Access-Control-Allow-Origin`
must be a bare origin with no trailing slash; a value that carries one produces a
header that never matches, and the browser reports it as an opaque CORS failure
with nothing logged server-side. Validating at boot means the error names the
actual problem instead of surfacing in someone's console.

### 3.1 The preflight cost, recorded honestly

**Correction to an earlier draft of this section**, which said `Range` is not
CORS-safelisted and concluded that every ranged GET preflights _because of_
`Range`. That is wrong on the first clause, and the conclusion happens to survive
for a different reason. Both halves are worth stating, because the wrong version
would send someone optimising in the wrong direction.

**`Range` _is_ CORS-safelisted, for single byte ranges** — `bytes=X-Y` and
`bytes=X-`, which are exactly the forms PR 5's asset route accepts, and none of
the forms it rejects. It stays in `allowedHeaders` anyway: the entry costs
nothing, it does not depend on a reader knowing the safelist's shape, and the
header must be listed for any form falling outside it.

**`Authorization` is not safelisted, and it is worse than that — it is a
_non-wildcard_ header.** `Access-Control-Allow-Headers: *` does not cover it; it
must be named. So **every authenticated cross-origin request preflights**, which
in v1 is every request except `/health`. Not because of ranges — because of
bearer auth on a separate origin.

`Content-Range`, `Accept-Ranges` and `Retry-After` are none of them safelisted
_response_ headers, so without `exposedHeaders` the browser hides them from the
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
fine same-origin — but separate origins _are_ the deployment (§3, brief §11), so
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

**A loose end here is closed.** This paragraph used to note that `methods`
listed `DELETE` while no route used it — §7.8's revoke is a `POST` on purpose,
and album deletion (§4.2) has no route in the v1 surface. PR 3 settled the route
table's methods: `GET`, `POST` and `PUT` (§9.9), `DELETE` gone. An entry nothing
uses is a claim about the route table that is not true, and it is now not made.

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
the outward-facing half — _no error response ever echoes request content_ — and
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

What the server legitimately holds for passphrase recipients is the _wrapped_
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
- **§9.2's album create** carries `wrapped_key` and `wrap_nonce` — `K_album`
  under `K_master` — and must accept neither key. **Three routes, as of PR 3**,
  and the walk is the same for each.

A route that accepts a wrapped blob is exactly where the difference between
"wrapped blob" and "key material" stops being a definition and becomes a schema.
Brief §6 #16 now states that distinction in the same words: a wrapped blob is
ciphertext and may be posted; the key that wrapped it and the secret that key was
derived from may never be.

**The outbound half, added by PR 4 (13 September 2026) — returns wrapped, never
unwrapped.** Three routes return key-adjacent material: §8.3 (`K_master`, to its
owner), §9.2 (every `K_album`, to its owner), §10.1 (one `K_album`, to a
passphrase recipient). **A route may return a wrapped blob and its public
parameters — salt, nonce, KDF integers — and may never return, compute, or hold
in a returnable form the key that wraps the blob, the secret that key was derived
from, or the key inside it.** Every such response carries `Cache-Control:
no-store` (§8.3). The route-table walk gains a second direction: no _response_
schema declares a field named for a key, any more than a request schema does.
Written here rather than only in §10.2 because this is the section a route is
checked against, and a reader who found a wrapping in a response body and only
this constraint's inbound half would read the response as a violation.

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
only record of which objects existed: `media.id` _is_ the object key (brief §9.2),
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
  _This sentence formerly required the dummy to carry the same KDF parameters as a real row. It was written against a design where the relay ran Argon2id; it applies no KDF (§5.2), so verification is one HMAC and a constant-time compare and no parameters are read on this path at all. The dummy is a bare 32-byte `auth_hash`. Where the same-parameters rule does live is `/login/params`, whose decoy returns the values real rows carry (§8.1)._
- **`POST /login/params`** — always `200`, with deterministic decoy values for an
  unknown address, and the lookup runs unconditionally with substitution on miss.
  Branching before the query is the same oracle in a different place.

This is the same family as §7.3's cross-album `404`, and it fails the same way:
look up, check, return a different answer for each. **Check-then-diverge is the
shape to watch for** in all three.

**`POST /signup` is explicitly outside this constraint and cannot be brought
inside it in v1.** Registration must reject a duplicate address, and with no email
sending there is no way to answer identically and deliver the difference out of
band. So the guarantee is _credential-route indistinguishability_, not
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

- **Wrap, never derive.** `K_album` stays random and is _wrapped_ under
  `K_master`. This is what makes §7.5's `/signup` body a wrapped blob rather than
  anything derived, and it is why §4.1's audit has a second subject.
- **N wrappings, not one column.** An `owner_keys` table holds several wrappings
  of the same `K_master`, one per credential. Phase 2 adds a recovery key by
  `INSERT` rather than by migration. The **per-row client KDF parameters** that
  table exists to carry are what force `POST /login/params` to exist at all
  (§7.5): a global constant would have removed the round trip and the property
  with it. **There is no second parameter set.** The relay applies no KDF — it
  peppers the proof it receives (encryption spec §6.6) — so `owner_keys`' per-row
  figures are the only ones in the system, and a route that returns them is
  returning all of them. An earlier version of this bullet claimed a second,
  server-side set on `owners`; withdrawn.
- **The login proof and the key-encryption key are independently derived from
  the password**, and **the password never leaves the device.** Together these fix
  what `POST /login` receives — a derived proof, never a password. Encryption spec
  §6.6 owns the derivation and still owes conformance vectors per §9.1 before
  Phase 1.

**Accepted cost, and no route may soften it:** forgetting the password loses every
album. Email restores _login_, which the server owns; it cannot restore _keys_,
which the server was never allowed to hold.

### 5.2 The owner account model — CLOSED (brief §12)

**Decided 20 August 2026: email and password.** Email is a memorable username,
not a recovery channel. **§7.5's labelled request-body gap closes with it**, and
so does this hole — with one part carved out below that is genuinely still open.

An earlier version of this section said §12 blocked PR 2 outright, which is why
PR 2 went unwritten longer than it needed to; a later one narrowed it to the
request body alone. Both are now history: §7.5 states the body.

**Still open, and now owned rather than parked: the Argon2id parameters. There is
exactly ONE SET, client-side.** Encryption spec §6.6 settled the structure on
21 August 2026 and corrected it the same day; the numbers remain unspecified, and
they may not be inherited from the passphrase wrap's 64 MiB (§6.2).

| Set          | Applied by                    | Bounded by                                    | Stored on             | Returned to a client                          |
| ------------ | ----------------------------- | --------------------------------------------- | --------------------- | --------------------------------------------- |
| The only one | the client, over the password | a mobile WASM heap on a low-end Android phone | `owner_keys`, per row | **Yes** — that is what `/login/params` is for |

**This table had a second row for part of 21 August 2026** — a relay-side set on
`owners`, bounded by "a server under concurrency", never returned. It is
withdrawn, along with the `owners.auth_salt` and `auth_kdf_*` columns proposed to
carry it, which never shipped in a migration. The relay applies no KDF: it
peppers the proof (below), and a keyed fast hash has no work factor to
parameterise per account.

One derivation feeds both halves. The client runs Argon2id **once** to a root and
derives the KEK and the proof from it by keyed hash with distinct domain strings
(encryption spec §6.6.1) — §6.6's independence requirement is met, because a PRF
output does not yield its key, and the single run is what lets the parameters be
sized for the weakest phone rather than for two runs of it.

They stopped being a deferred hole when the model closed, because `/signup` and
`/login/params` both carry that set and someone needs a number to test against.

**An ambiguity flagged here on 21 August 2026 is now resolved, and this document
got the substance of it wrong twice — in opposite directions.** The flag asked
what verifies the proof server-side, since the design implies three Argon2id
applications — the client's KEK derivation, the client's proof derivation, and
whatever the relay does with the result — and §7.6's rate-limit argument depended
on the third.

**Answer: the relay applies `auth_hash = HMAC(pepper, proof)`** — a peppered fast
hash, not a KDF (encryption spec §6.6.1, schema §3). There is no third Argon2id
application, and there are only two, both client-side, both from one run.
**§7.6's cost argument does not survive that** and is rewritten there rather than
hedged.

**Both wrong answers had the same shape, which is the part worth keeping.** The
first argued from schema §3's note on `owner_tokens.token_hash` — 32 high-entropy
bytes, "Argon2id here would be pure per-request cost" — that `owners.auth_hash`
wants a plain fast hash for the same reason, the values being the same shape. The
second accepted the refutation of that and concluded relay-side Argon2id. The
refutation is right and the conclusion did not follow:

> The relay mints a token, and therefore _knows_ its entropy. A proof's entropy
> is a **claim about what a client did**, and the relay cannot verify it.

The threat is not an owner choosing a weak password. It is a _Vitrina client_
silently producing weak proofs — a WASM build falling back to lower parameters, a
mobile port splitting the derivation wrongly, a normalisation bug. Login still
succeeds, nothing fails, and every proof from that build is weak until a database
is stolen. That is non-negotiable #17's test exactly — _does it work, wrongly,
without this_.

**But Argon2id over the proof does not answer it, and the pepper does.** A KDF's
protection scales with the entropy of its input, which is precisely the quantity
the relay cannot check — so against a weak-client build it buys a slowdown and
nothing categorical. A pepper is not an amplifier of the client's work; it is a
secret the attacker does not hold, so the comparison value cannot be computed at
all, whatever the client did. It is also the only one of the two that leaves
§4.3's dummy verification cheap instead of turning it into a memory-allocation
vector by construction. **Honest limit:** against a live full compromise the
pepper buys nothing, since proofs are visible in flight (encryption spec §6.6.1).

Worth recording as two reasoning failures rather than two fact corrections. The
first was structurally sound and reached the wrong answer because it compared two
values by **shape** when the property that mattered was **provenance**: two
columns holding 32 high-entropy bytes are not the same column if only one of them
is known to hold them. The second accepted that correction and then reached for
the **stronger primitive instead of the applicable one** — a KDF is what you use
when the input's entropy is low, not when it is unverifiable, and those are
different problems with different answers.

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

| Rule                                                                                                                | Enforced by                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| One error shape                                                                                                     | `error-envelope.ts`, wired through both `setErrorHandler` and `setNotFoundHandler`                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| No unregistered error code                                                                                          | Closed union across the `code → status` and `code → message` maps; compile error                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `message` never derived from an exception                                                                           | No code path exists from `Error.message` to the response body                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| 404 does not echo the request path                                                                                  | Test: asserts the requested path is absent from the body                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| One envelope shape, no Fastify defaults                                                                             | Test: asserts exactly `code` + `message`, and that `error`/`statusCode` are absent                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| The envelope reaches routes _inside_ `/v1`                                                                          | Test: a throwing route registered through `v1Plugins` returns `{code:"INTERNAL"}` and not Fastify's body. **Also the only assertion today that the `/v1` mount exists at all** — delete the mount and `/v1/boom` becomes a 404, so the test fails. That is coverage by side effect; §6.2 owes a direct one                                                                                                                                                                                                                                                    |
| Exactly one CORS origin, never `*`                                                                                  | Config parsed and validated at boot; tests assert the allowlisted origin is echoed and a foreign one is not                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `Authorization` and `Range` permitted; `Content-Range`, `Accept-Ranges` and `Retry-After` exposed; preflight cached | Tests on the OPTIONS preflight. `Retry-After` was added in PR 2, not PR 5 — §7.6's three unauthenticated routes are the first that can answer `429`                                                                                                                                                                                                                                                                                                                                                                                                           |
| `maxAge` claims only what it claims                                                                                 | Comment in `server.ts` reads "the maximum Chrome honours", not "the maximum useful value". Prose, but the wrong version is what invites someone to raise it                                                                                                                                                                                                                                                                                                                                                                                                   |
| `/health` unversioned                                                                                               | Test: `/v1/health` is 404. **Note what this does not prove:** it passes whether the `/v1` mount exists or not                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `Authorization` and `Cookie` headers never appear in logs                                                           | `redact: ["req.headers.authorization", "req.headers.cookie"]`, in `LOG_POLICY`. **This row used to claim "key material never in logs", which is more than two redacted headers deliver** — see §6.2. Note the redaction is inert today either way: Fastify's default `req` serialiser logs method and URL and no headers at all, so this fires only once someone widens it. Kept for exactly that day                                                                                                                                                         |
| The log policy is the adapter's, not the caller's (§1.2)                                                            | `loggerWithPolicy` in `server.ts` spreads `LOG_POLICY` **last** over any caller-supplied logger; `false` alone passes through. `error-logging.test.mjs` asserts a caller-supplied `serializers.err` is ignored. Without this row the two below are untestable — a test would configure the serialiser it then asserts                                                                                                                                                                                                                                         |
| An `ApiError` with a cause logs one `warn` line; without one, nothing (§1.2)                                        | `error-logging.test.mjs`: a route throwing `ApiError("NOT_FOUND")` produces zero lines, one throwing `ApiError("CONFLICT", {cause})` produces exactly one at level 40. Verified by violation — logging unconditionally fails the first                                                                                                                                                                                                                                                                                                                        |
| `INTERNAL` cannot be thrown as an `ApiError` (§1.2)                                                                 | `ThrowableCode = Exclude<ErrorCode, "INTERNAL">` on the constructor. The type is the enforcement — verified by probe, `new ApiError("INTERNAL")` fails `tsc`. **This row is why §6 exists:** the rule was prose in §1.2 and in neither §6.1 nor §6.2 until 21 August 2026, so it was unenforced _and_ unrecorded as unenforced                                                                                                                                                                                                                                |
| `ApiError` sets `cause` via the constructor, not by assignment (§1.2)                                               | `error-logging.test.mjs`: a string cause must not reach the log. Sounds like a style assertion and is not — the options form defines `cause` non-enumerably, which is the only reason a non-`Error` cause is dropped. Verified by violation: rewriting `super(msg, {cause})` as `this.cause = cause` fails this case, and would silently invert §1.2's advice                                                                                                                                                                                                 |
| The cause chain reaches the log structured, not flattened (§1.2)                                                    | `serializers.err: pino.stdSerializers.errWithCause` in `LOG_POLICY`, plus assertions that `err.message` is the constant alone, `err.cause` is an object, and a second-level `err.cause.cause` is walked. Verified by violation — the default `err` serialiser fails three cases                                                                                                                                                                                                                                                                               |
| All ten codes of §1.1 exist, each with a status and a message                                                       | `packages/shared/src/index.ts` holds the union; `STATUS` and `MESSAGES` in `error-envelope.ts` are `satisfies Record<ErrorCode, …>`, so a code missing from either does not compile                                                                                                                                                                                                                                                                                                                                                                           |
| `details` cannot express a field _value_ (§1.1)                                                                     | `ErrorDetails` in `packages/shared`, spelled canonically in §1.1. The type is the enforcement: `tsc` rejects `details: {kind: "…"}` at the throw site — verified by probe. `http.test.mjs` pins the wire shape, that it gains no siblings, and that it is absent rather than `undefined` when unset. **Note what it does not claim:** a value can still be put _in the list_, and the test asserts that rather than implying otherwise                                                                                                                        |
| No framework 4xx collapses to `INTERNAL` (§1.2)                                                                     | `test/framework-4xx.test.mjs`, 19 cases: oversized body → 413, unmatched and absent `Content-Type` → 415, malformed and empty JSON → 400, plus a sweep asserting no case answers `INTERNAL` or a non-4xx. The reply status is `STATUS[code]`, never the number keyed in the inverse table, so a wrong row cannot produce a status and a code that disagree                                                                                                                                                                                                    |
| An unmapped 4xx is a loud `INTERNAL`, not a quiet 400                                                               | No fallback in the inverse table; verified by probe — a `410` returns `INTERNAL`, a `503` returns `INTERNAL`, and a method mismatch is a `404` rather than an unmapped `405` (§1.1)                                                                                                                                                                                                                                                                                                                                                                           |
| A validation failure logs a projection, not the error (§1.2)                                                        | `projectValidation` in `error-envelope.ts`, plus `test/error-logging.test.mjs`: a wired half against real AJV, and a by-construction half feeding `data`, an interpolated `message` and a hostile `params` that a `verbose: true` or custom-keyword configuration would produce. Every case asserts the entry's keys against a whitelist, so widening the projection fails here. Measured against the previous `{ err: error }`: 7 of 8 cases fail                                                                                                            |
| The `INTERNAL` path stays complete inward (§1.2)                                                                    | Same file: asserts the `500` log line carries the thrown message and a stack while the wire stays `{code:"INTERNAL"}`. It exists because the way to break this rule is to "finish" the projection above                                                                                                                                                                                                                                                                                                                                                       |
| `ErrorCode` is a client-importable contract (§1.4)                                                                  | Declared in `packages/shared`, imported by the adapter. Architecture §4 decision 5 enforced in both directions: `eslint.config.js` restricts `@vitrina/shared` from `src/domain/**` and `src/application/**`                                                                                                                                                                                                                                                                                                                                                  |
| Imports point inward only (vitrina-server-architecture.md §1)                                                       | `eslint.config.js` boundary rule; fails `pnpm lint`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| No sequential-only streaming construction                                                                           | `scripts/check-forbidden-constructions.sh`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| §8.1 signup validates against floors, not chosen values                                                             | `schemas/credentials.ts` uses `minimum: 16384 / 2 / 1`; `test/credential-routes.test.mjs` posts 131072/4/2 and asserts `201`, and one case per floor asserting `400` with no `details`. Verified by violation — pinning the schema to `65536` fails the first case, which is the one nobody writes by instinct                                                                                                                                                                                                                                                |
| §8.1 decoy parameters equal the constant real rows carry                                                            | Same file: `/login/params` for an unknown address returns exactly `OWNER_KDF_V1`, and a real signup's three integers deep-equal a decoy's. The second is what catches the constant and the stored rows drifting apart                                                                                                                                                                                                                                                                                                                                         |
| §8.2 one normalisation function, called before every lookup                                                         | `domain/owner/normalise-address.ts`, called by all three use cases. Route tests: signup as `Ana@X.es`, then `/login/params` with `  ana@X.ES  ` returns the real salt rather than a decoy, and `/login` with `\tANA@x.es ` succeeds. Negative: `ana@x.es` and `a.na@x.es` are two accounts                                                                                                                                                                                                                                                                    |
| §8.2 an address empty after normalisation is rejected                                                               | Route tests: `"   "` and `U+2028` on all three routes return a byte-identical `400 VALIDATION_FAILED`, and the unit tests assert the repository is never reached                                                                                                                                                                                                                                                                                                                                                                                              |
| §8.2 the secret is required at boot                                                                                 | `config.ts` `parseServerSecret`; `test/config.test.mjs` asserts absent, empty, 31 bytes and non-base64url all throw. Verified by violation — a generate-if-missing fallback fails two cases, one of which exists only to catch that                                                                                                                                                                                                                                                                                                                           |
| §7.5 `/login` compares in constant time and runs the same path on miss                                              | `application/use-cases/verify-proof.ts` uses `node:crypto`'s `timingSafeEqual`, asserted by import in `test/verify-proof.test.mjs`; `test/login.test.mjs` spies the verifier and asserts one query and one verification on a hit and a miss alike, the miss against `dummyAuthHash`. The load-bearing one: a spy returning `true` on the miss path must still mint nothing, because there is no owner id there                                                                                                                                                |
| §7.5 signup's two writes are one transaction                                                                        | `adapters/driven/postgres/owner-repository.ts`; `infra/owner-repository.test.mjs` fails the second insert with a real `CHECK` (47-byte `wrapped_master`) and asserts no `owners` row survives, and that the error is not reported as `DUPLICATE_ADDRESS`. Verified by violation — committing after the first insert leaves a row and fails on `1 !== 0`                                                                                                                                                                                                       |
| §7.5 no request body reaches a log, on any route                                                                    | `error-envelope.ts`'s projection, plus a route test that posts a distinctive proof and wrapping to `/signup` across the success, `409` and validation paths and asserts neither, nor the address, appears in any captured line. It asserts the log is non-empty first, so it cannot pass vacuously                                                                                                                                                                                                                                                            |
| §8.3 `/owner/key` returns only the caller's row                                                                     | No id in the path; the owner comes from the bearer token. Two owners with distinguishable wrappings, two sessions, each `GET` returns its own. This is the test that fails the day someone adds `?owner_id` "for admin"                                                                                                                                                                                                                                                                                                                                       |
| §4.1 no key material in any parameter                                                                               | `test/route-table.test.mjs` walks every exported schema and asserts no property named `password`, `passphrase`, `kek`, `k_master`, `k_album`, `master_key`, `album_key`, `secret`, `pepper` or `root`, inbound or outbound — and asserts the converse, that `/signup` does declare `wrapped_master`, `wrap_nonce` and `proof`, so the list cannot be widened into forbidding what signup exists to carry. Verified by violation — adding a `password` field to the signup body fails it                                                                       |
| §7.2 no token in a query string                                                                                     | Same walk: no schema declares a `querystring`, `params` or `headers` section at all. Scoped that way deliberately — `token` in `/login`'s _response_ is the session the route exists to return, and an earlier version of the walk flagged it                                                                                                                                                                                                                                                                                                                 |
| §1.2 `429` answers through the envelope                                                                             | `429 → RATE_LIMITED` is registered in the inverse table and `Retry-After` is in `Access-Control-Expose-Headers` (§3), so a cross-origin client can read the interval. `credential-routes.test.mjs` asserts the refused request's body is exactly `{code, message}` and that the header is set. What could make this mapping inert is the trap on the §7.6 row below                                                                                                                                                                                           |
| The three unauthenticated routes are rate-limited (§7.6)                                                            | `rate-limit.ts`, IP-keyed; `credential-routes.test.mjs` asserts the eleventh request is refused. The `429` reaches the envelope rather than `@fastify/rate-limit`'s own body, which is what §1.2's `429` row asked for and what would otherwise make that row inert while looking live. The caveat the old owed row carried, kept because it is still true: the limiter is in-process state, correct on one instance and silently broken on two, with the effective limit doubling and no error anywhere. Carried in a comment at the limiter as well as here |
| Credential routes answer identically whether an account exists (§4.3)                                               | `credential-routes.test.mjs`: `/login` returns a byte-identical `401 INVALID_CREDENTIALS` for a wrong proof and an unknown address; `/login/params` returns `200` for both; `login.test.mjs` spies the verifier and asserts it runs once on each path, against `dummyAuthHash` on the miss. §6.2 keeps the timing third, which is not assertable                                                                                                                                                                                                              |

The suite is hermetic — `app.inject()`, no Docker, no network — so it belongs in
CI's `checks` job, which the workflow keeps free of infrastructure on purpose.
**One row above is the exception**: signup's transaction can only be shown
against a real database, so it is enforced by `infra/owner-repository.test.mjs`
under `pnpm test:infra` and not by the `checks` job.

### 6.2 Owed — a rule in this document with no code behind it

Each row names the assertion, not just the gap, so that writing it is mechanical.

| Rule                                                                             | What is owed                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| -------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| §1.2 chain a message you wrote, not a driver error verbatim                      | **Prose only, and structurally unenforceable here** — the reason it is worth a row rather than a note. The handler cannot inspect a chained value and tell a submitted one from an authored one, so no assertion in `error-logging.test.mjs` can close this; that file instead asserts the _absence_ of a guarantee, so nobody reads the `ApiError` branch as making one. **The exposure is larger than this row first recorded** (corrected 21 August 2026): `errWithCause` copies a cause's enumerable own properties, so a chained `pg` error carries `detail` — where Postgres puts the submitted value — and not merely a message. A test now asserts that leak exists rather than implying it does not. The nearest thing to enforcement arrives with PR 3's repository adapter, where a real `pg` error is first available to chain: extend §7.5's per-route log test to the `CONFLICT` path and assert the submitted value is absent from every line. Until then this is review discipline, and the rule is written on `ApiError`'s `cause` doc comment because that is where someone chaining a driver error is looking |
| §2 the `/v1` mount exists                                                        | A test that fails when the mount is removed _and_ is not about error handling: register a probe route through `v1Plugins`, assert it answers at `/v1/<path>` **and** 404s at `/<path>`. The second half is what makes it about the prefix                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| §4.3 no credential route reveals whether an account exists — timing only         | The shape half is enforced and has moved to §6.1: byte-identical `401 INVALID_CREDENTIALS` for a wrong proof and an unknown address, `200` from `/login/params` for both, and the verifier spied on both paths. What remains owed is timing, and it is not assertable: a test that measures it is flaky, and one that does not proves nothing about the property that matters. The structural proxy §4.3 asks for — the dummy runs on the miss path, the lookup precedes any branch — is asserted, so what is left is the gap between "the same instructions run" and "they take the same time", which no test in this suite can close. Kept as a row because deleting it would imply timing was covered                                                                                                                                                                                                                                                                                                                                                                                                                         |
| §4.2 no delete before storage objects                                            | **Prose only.** Needs the delete use case, PR 3                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| §1.1 `LENGTH_REQUIRED`/411 and `RANGE_NOT_SATISFIABLE`/416 in the union          | **PR 3 and PR 5, owed.** One entry each in `packages/shared`, one in each of `STATUS` and `MESSAGES`; `tsc` enforces the rest. Until they land the handlers cannot throw them, which is the point of §1.1's "registered ≠ reachable"                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| §9.7 `status` is set by the server and no body accepts it                        | **PR 3, prose only.** A route-table walk asserting no JSON Schema declares a `status` property — the same walk as §4.1's, one more forbidden name. And a functional test: `PUT` an asset and a thumbnail, assert `ready` and `byte_size` equal to the two byte counts the test itself sent; `PUT` a body whose stream is destroyed mid-way, assert `failed`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| §9.7 `ready` needs both objects                                                  | **PR 3, prose only.** Upload one object and assert the row is `processing`, not `ready`; upload the second and assert `ready`. The single-object `ready` is the natural bug in a handler written for the asset and copied for the thumbnail                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| §9.7 the confirming `HEAD` decides, not the count alone                          | **PR 3, prose only.** Against a fake store whose `HEAD` returns a different length, assert `failed`; against one whose `HEAD` 404s once then succeeds, assert `processing` then `ready`. Both need the storage port to be a test double, which architecture §4 already gives                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| §9.7 upload after `ready` is `409`                                               | **PR 3, prose only.** Trivial; owed because "PUT is idempotent" is the instinct that removes the check                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| §9.5 only `ready` rows' envelopes are returned                                   | **PR 3, prose only.** Create a row, do not upload, call `/metadata`, assert it is absent; then assert §9.4 still lists it as `pending`. The pair is the assertion — the two routes filter differently on purpose                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| §9.4 identical body for owner and recipient                                      | **PR 3, prose only.** Same album, one owner session and one recipient token, deep-equal the two responses. Fails the day someone adds an owner-only field to the shared route instead of to §9.2                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| §9.2 every album's wrapping is in the list, and the list is `no-store`           | **PR 3, prose only.** Header assertion plus: create two albums, list, assert both `wrapped_key`s equal what was posted                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| §3 `methods` is `GET, POST, PUT`                                                 | **PR 3.** Extend the existing OPTIONS preflight test: `PUT` allowed, `DELETE` not                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| §4.1 no response schema declares a key-named field                               | **PR 4, prose only.** The outbound half of the route-table walk: every route's response schema, asserted free of `key`, `K_album`, `K_master`, `kek`, `passphrase`, `password`, `proof` as property names. Same test file as the inbound walk, second loop                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| §10.1 returns the caller's row and only that                                     | **PR 4, prose only, structural** — no id in the path. Owed anyway, as §8.3's is: two passphrase recipients on one album, each token's `GET` returns its own `wrapped` and `id`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| §10.1 QR → `404`, revoked → `403`, both without `details`                        | **PR 4, prose only.** Three tokens — qr, passphrase, revoked passphrase — three statuses; the revoked case is the one that matters, since a handler that reads the row before running §7.3 step 4 answers `200` with the blob                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| §10.1 and §9.2 carry `no-store`                                                  | **PR 4, prose only.** One header assertion per wrapped-blob route — three routes, one parametrised test, so a fourth route added without the header is a one-line addition to the test that someone will notice is missing                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| §11.2 the range table, every row                                                 | **PR 5, prose only.** Nine cases against a fake store that answers `206`/clamped/`InvalidRange` as a real one does: each row's status, `Content-Range` forwarded verbatim on the clamp, `400` bodies carrying no fragment of the submitted `Range` (#15). The no-header row is the one that matters — it is the RFC-compliant behaviour someone will restore                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| §11.2 forwards a whitelist of headers                                            | **PR 5, prose only.** Fake store adds `ETag`, `Last-Modified`, `x-amz-request-id`; assert none reach the client and `Content-Range`/`Content-Length` do                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| §11.3 ignores `Range`                                                            | **PR 5, prose only.** Thumbnail with `Range: bytes=0-10` → `200`, whole body, no `Content-Range`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| §11.3 every ciphertext response is `no-store`                                    | **PR 5, prose only.** Header assertion on §9.5, §11.2 and §11.3 — and a structural one: the three routes register through one hook, so a route-table walk can assert every route serving `application/octet-stream` or a `metadata` body has it                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| §11.5 the limiter keys on the hash and answers through the envelope              | **PR 5, prose only.** Two tokens from one IP do not share a budget; one token from two IPs does. The `429` body is `{code:"RATE_LIMITED", message}` and nothing else — the assertion that catches `errorResponseBuilder`'s default; §1.2's `429` row is discharged by the same test                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| §11.6 `album_opened` on §9.5 only, `asset_viewed` on range-from-0 only           | **PR 5, prose only.** A recipient calls §9.4 → zero rows; §9.5 → one row, twice → two rows (no dedupe); §11.2 `bytes=0-262207` → one row; `bytes=262208-` → zero; §11.3 → zero; the same sequence as an owner → zero rows throughout                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| §11.6 a failed log write does not fail the fetch                                 | **PR 5, prose only.** Log repository throws; assert `206` and one `error`-level line                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| §11.7 summary counts distinct media and includes zero-row and revoked recipients | **PR 5, prose only.** Two opens of one photo → `media_opened: 1`, `album_opens` unaffected; a recipient with no rows appears with zeros; a revoked one appears with `revoked_at` set                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| §11.4 `label` reaches a recipient of either kind                                 | **PR 5, prose only.** A `qr` token and a `passphrase` token both get their row's label; a revoked one gets `403`. This is the test that brief §5's watermark has an input                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |

**Four rows were deleted here, 20 August 2026**, on the same principle as the
deletion below — a discharged owed row is errata, and a reader who finds one
assumes the gap is still open. They moved to §6.1: §1.1's six missing codes,
§1.2's framework-4xx test, §1.2's validation projection, and §1.4's home for the
union.

**Twelve rows were deleted here, 21 September 2026**, on the same principle —
PR 2b's eight, §4.1's route-table walk, §7.2's query-string walk, §1.2's
`429` provision and §7.6's limiter. §4.3's row was narrowed rather than
moved: its shape half is enforced and sits in §6.1, and what it still carries
is the timing third, which no test here can close. All are code and sit in §6.1, most carrying what fails if the
enforcement is removed, which is what makes a row checkable later. Note what
closing §4.1 took: the walk asserts the converse as well, that `/signup` does
declare `wrapped_master`, because a forbidden-names list nobody bounds
eventually forbids the material the route exists to carry.

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
in §7.5 — and the routes that _consume_ recipient authentication begin in PR 3.

### 7.1 Two schemes, two tables, and no shared principal

Brief §9.1: owners hold account auth tokens in `owner_tokens`; recipients hold
one invite access token, hashed on the `recipients` row. There is no
`access_tokens` table and there must not be one — "a single shared token table
would invite treating them as one, which is the easiest way to leak album
access."

|                               | Owner                                                  | Recipient                                       |
| ----------------------------- | ------------------------------------------------------ | ----------------------------------------------- |
| Where the hash lives          | `owner_tokens.token_hash`, many rows per owner         | `recipients.token_hash`, one row per invite     |
| Who mints the token           | **the server**, at `/login` (§7.4)                     | **the client**, before the invite exists (§7.4) |
| Expiry                        | `expires_at`, NOT NULL — two weeks, provisional (§7.5) | **none.** `revoked_at` only (§7.6)              |
| Revocation                    | `POST /logout`, `POST /logout/all`                     | `POST /recipients/{id}/revoke` (§7.8)           |
| Scope                         | every album where `albums.owner_id` is theirs          | exactly one album, the row's `album_id`         |
| Revoked, presenting the token | `401 UNAUTHENTICATED` (§7.3)                           | `403 ACCESS_REVOKED` (§7.3)                     |
| Recovery after loss           | log in again                                           | **none** — the owner mints a new invite         |

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
  | { kind: "owner"; ownerId: Uuid }
  | { kind: "recipient"; recipientId: Uuid; albumId: Uuid };
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
"schema §6, whose _four_ rules apply" and then listed five clauses — miscounting
its own enumeration — and three lines later cited "schema §6 **rule 4**" for the
comparison rule. The ordinal happens to resolve correctly today, which is the
problem rather than the reassurance: it is correct by coincidence of numbering,
and schema §6 gaining a rule breaks it silently into a citation that reads as
authoritative and points at something else. That is the failure architecture §9
had to clean up as non-negotiables #26 and #27 — a reference resolving to nothing,
or worse, to the wrong thing. **A citation names the rule it means; only the
section gets a number.** "§6's rule against comparing token strings" survives a
renumber and is checkable by reading; "rule 4" is neither. Same reasoning as
carrying a section _title_ alongside its number in the database comments.

**This applies to citations that cross a document boundary.** References into a
numbered list _inside this document_ — §7.3's steps, cited in §7.5 and §7.7 — are a
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
for a caller with no session, which is the correct code for a _missing_ session
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
(§7.7). `details` stays for the routes where a client must know _which_ field to
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

**Two routes mint a session token: `/login` and `POST /signup`.** Changed 15 September 2026, after the key-flow spike.

This section said signup deliberately did not, on the grounds that two minting sites mean two `expires_at` values to keep in step and two places to audit. That cost is real and stands. What it was weighed against was "one extra round trip on the rarest action an owner performs", and the spike showed that is not what the alternative costs. **A signing-up device must either cache its login proof across a round trip or run Argon2id a second time.** Caching is what any client will do — and a cached proof is a replayable credential held in JS memory specifically so that a route can mint a session moments later. That is the same outcome with an extra secret alive in the browser, so the audit argument cuts both ways.

**The mitigation for two minting sites is one code path, not two implementations.** Both routes call the same function to mint, set `expires_at` and insert the `owner_tokens` row; neither writes that logic itself. §6.2 owes a test asserting both produce the same window.

Note this is about the _session_ token only. `/signup` does carry key material
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
- the **KDF salt and parameters**, which become the first `owner_keys` row.
  **These are the only KDF parameters in the system** — the relay applies no KDF
  to the proof, only a pepper (§5.2), so there is no second, server-side figure
  for this body to be accused of carrying. That a client supplies its own work
  factor is therefore not mitigated by a relay-side layer: what answers the
  weak-client threat is the pepper, which is a secret rather than a cost
  (encryption spec §6.6.1);
- **`wrapped_master` and `wrap_nonce`.**

**The body, at the level §7.7 gives create-recipient** — added by PR 2b, 13
September 2026. Every binary field is base64url in schema §6's canonical form,
decoded by the same strict rules §7.7 applies to all four of its fields: exact
character count, the base64url alphabet, no padding, exact decoded length, and
the re-encode check.

| Field                                                 | Type                    | Notes                                                                                                                                                                                                                                                                  |
| ----------------------------------------------------- | ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `email`                                               | string, 1–254 chars     | **As typed.** No `format: email` and no `pattern` — the relay normalises server-side (§8.2) and a client-side format check would reject spellings the normaliser accepts. 254 is RFC 5321's path limit and only bounds the column; it is not a validity claim          |
| `proof`                                               | 43 chars → **32 bytes** | The login proof, derived client-side from the Argon2id root by keyed hash with the proof domain string (encryption spec §6.6.1). Stored only as `HMAC(pepper, proof)` in `owners.auth_hash` (schema §3); the relay never holds the proof after the request is answered |
| `kdf_salt`                                            | 22 chars → 16 bytes     | Random, client-generated. The salt for the **single** Argon2id run that yields both KEK and proof                                                                                                                                                                      |
| `kdf_memory_kib`, `kdf_iterations`, `kdf_parallelism` | integer                 | The client's Argon2id parameters, validated against §8.1's floors — not against its chosen values, or raising them in Phase 2 would break signup                                                                                                                       |
| `wrapped_master`                                      | 64 chars → **48 bytes** | `K_master` (32) plus the Poly1305 tag (16), under the KEK. Ciphertext, not key material (§4.1)                                                                                                                                                                         |
| `wrap_nonce`                                          | 32 chars → 24 bytes     | XChaCha20-Poly1305 nonce for `wrapped_master`. Same forgettable field as §7.7's, same consequence — without it the blob is undecryptable                                                                                                                               |

**No `id`.** Unlike `recipients.id` and `media.id`, an owner id is inside no AAD
and no envelope header, so the server assigns it (brief §9.3: "every other `id`
is server-assigned"). **No `kdf_version`.** Encryption spec §6.2 fixes Argon2id
v1.3 as normative for version 1, so the field would carry one permitted value; if
a second version is ever admitted it is added to this body _and_ to
`/login/params`' response together, as an additive change.

**Lengths are the same as §7.7's, and that is a fact about the primitives, not a
coincidence to be preserved.** `K_master` and `K_album` are both 32 bytes, so both
wrappings are 48; both wraps use XChaCha20-Poly1305, so both nonces are 24; both
KDFs are Argon2id with `crypto_pwhash_SALTBYTES`, so both salts are 16. The two
routes may therefore share one set of decoding schemas — and §7.7's spare-bits
table applies unchanged, `kdf_salt` again being the field with the most
non-canonical spellings.

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
  **What the transaction writes**, so the repository method has a contract: one
  `owners` row — `email` normalised per §8.2, `auth_hash = HMAC(pepper, proof)`,
  and nothing derived from the proof but that — and one `owner_keys` row of kind
  password carrying `kdf_salt`, the three parameters, `wrapped_master` and
  `wrap_nonce` verbatim. The `proof` itself is written nowhere. **The duplicate
  check is the `UNIQUE` on the normalised address, inside the same transaction**,
  not a `SELECT` before it — check-then-insert is a race that admits two accounts
  for one address, and the second can never log in because `/login/params`
  returns the first's salt.
  - `201`: `{ "id": "<uuid>", "created_at": "<RFC 3339 UTC>", "token": "<43 chars, base64url>", "expires_at": "<RFC 3339 UTC>" }`. **The token is minted here**, by the same code path as `/login`'s (§7.4) — a client that has just derived a proof should not have to hold it across a round trip to trade it for a session. The wrapping does not come back: the client that posted it holds `K_master` in memory already, and the route that returns it is §8.3, after login, on any device.
  - **`no-store` applies with more force now**, since the response carries a credential rather than only identifiers — §7.5's blanket credential-route rule already covered it.
- **Errors:** `400 VALIDATION_FAILED` · `409 CONFLICT` (address already
  registered) · `413 PAYLOAD_TOO_LARGE` · `415 UNSUPPORTED_MEDIA_TYPE` ·
  `429 RATE_LIMITED`. **`400` covers a parameter below §8.1's floors**, with no
  `details` — §7.3's rule holds on this route too. A sub-floor parameter is not
  user input a client can ask the user to fix; it is a client build choosing its
  own work factor wrongly, and the fix is in the client's source, not its UI.
- **The `409` is exactly what §4.3 carves signup out for.** It reveals that the
  address exists, cannot be made not to in v1, and is recorded as a limitation in
  brief §11 rather than papered over here. **It is raised from the constraint
  violation** (§1.2's rule: chain a message you wrote, never the `pg` error — its
  `detail` carries the address).
- **Response `Cache-Control: no-store`**, on the same reasoning as `/login`
  below: the request carried a credential-derived value, and nothing in brief §10
  reaches a non-ciphertext response.

---

**`POST /v1/login/params`** — no authentication. **Always `200`.**

**Why this route exists at all**, since a route whose purpose is unclear is a
route someone will fold into `/login` as an optimisation. Deriving the login
proof client-side requires the salt and Argon2id parameters _before_ anything can
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
- **`200`:** the `kdf_salt` and its three Argon2id parameters, from the caller's
  `owner_keys` row. Nothing else, and nothing that varies with whether the account
  exists.

  **Request and response, field by field** — PR 2b, 13 September 2026:

  | Direction | Field             | Type                | Notes                                                                                                                                        |
  | --------- | ----------------- | ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
  | request   | `email`           | string, 1–254 chars | As typed; same schema as `/signup`'s, literally the same object                                                                              |
  | response  | `kdf_salt`        | 22 chars, 16 bytes  | The stored salt, or the decoy (§8.2), **encoded by the same canonical encoder** — a decoy that differed in spelling would be a distinguisher |
  | response  | `kdf_memory_kib`  | integer             | From the row, or §8.1's v1 values on miss                                                                                                    |
  | response  | `kdf_iterations`  | integer             | as above                                                                                                                                     |
  | response  | `kdf_parallelism` | integer             | as above                                                                                                                                     |

  **Which row, when an owner has several.** `owner_keys` is one row per
  credential (§5.1), and this route serves the _password_ credential: it reads
  the row of kind password, of which there is exactly one per owner. Phase 2's
  recovery key is a different credential with a different salt, and a recovery
  login is a different route or a different request shape — not this response
  growing a list. Stated because a `SELECT … LIMIT 1` without the kind predicate
  works until the second row exists.

  **The response names its fields exactly as `/signup`'s body does**, because
  they are the same four values making the return trip, and because a client
  that can post `{kdf_salt, kdf_memory_kib, …}` on signup and must read
  `{salt, memory, …}` on login has two spellings of one thing to keep in step.

- **That is every KDF parameter the system has**, so nothing is being withheld
  here and no reader has to work out which set this is. An earlier version of this
  bullet said the route returns "one of the two parameter sets" and that the
  relay's own were never returned; the relay has none — §5.2 has the corrected
  table, and it peppers the proof rather than deriving from it (encryption spec
  §6.6.1). **What must still
  never appear in this response is the pepper**, which is a secret and not a
  parameter, and which no client computation takes as an input.
- **Unknown addresses get deterministic decoys** — `HMAC(server_secret,
"vitrina-decoy-v1" ‖ normalised_address)` truncated to 16 bytes (encryption
  spec §6.6.1; the exact computation is §8.2) — so repeated attempts return the
  same salt. A varying salt is itself an oracle. **The lookup runs
  unconditionally** and the substitution happens on miss; branching before the
  query is a timing oracle. See §4.3.
- **Decoy indistinguishability is conditional, and the condition is invisible
  here.** It holds because every `owner_keys` row carries identical KDF values, so
  a decoy has nothing to distinguish itself from. **It degrades the moment
  parameters differ between accounts** — which is exactly what per-row storage
  exists to enable. **This note belongs next to the code, not only in a
  document**: whoever raises parameters for one account in Phase 2 will not be
  reading this section. Two places, concretely: a `COMMENT ON` the three
  `owner_keys.kdf_*` columns in the Phase 1 migration, and a comment on the one
  function that writes them (§8.1 requires there be exactly one), since those are
  the two things a person raising parameters must touch.
- **The decoy server secret is not a rotatable credential.** Rotating it moves
  every decoy salt while real salts, being stored, stay put — so anyone who
  recorded earlier responses learns which addresses exist by comparing across the
  rotation. It is durable state in the same operational category as the database
  — backed up **as reliably as** the database, and **not in the same artifact**,
  because it is the same secret that peppers `auth_hash` (§8.2), and one snapshot
  yielding both collapses the pepper to an unpeppered hash (encryption spec
  §6.6.1). An earlier version of this bullet said "backed up with it", which
  reads as the same artifact; corrected. **Absent at boot MUST be a hard error**,
  never generate-if-missing: that is the ordinary implementation and it destroys
  the property silently on every restart, with nothing failing while it happens.
  Brief §6 non-negotiable #17.
- **Rate-limited on the same IP basis as `/login`** (§7.6). An oracle that cannot
  be distinguished but can be queried without limit is still a harvesting surface.
- **Errors:** `400 VALIDATION_FAILED` · `413` · `415` · `429 RATE_LIMITED`. **No
  `404`, ever** — that is the whole point of the route.
- **Response `Cache-Control: no-store`**, like the other two credential routes.
  **This route carried no such line until 21 August 2026**, and the omission was
  never argued — which is the objection, not the risk. A `POST` response is not
  cacheable by default, so the practical exposure here is close to nil; but §7.5
  calls this header forgettable _by design_, brief §10.1 records a forgotten
  `no-store` as its canonical works-but-wrong failure, and #17 says a security
  property must not be silently absent. **An asymmetry that needs an argument is
  worse than a header that costs nothing.**

**One rule, therefore, rather than three route properties: every response on a
credential route carries `Cache-Control: no-store`.** `/signup`, `/login/params`
and `/login`. Stated as a blanket rule because that is the form nobody has to
remember per route — the same move as §10.1 setting the header as object metadata
at upload time so no code path can forget it. Here it must be set by a handler and
therefore _can_ be forgotten, which is exactly why the rule is blanket rather than
case-by-case. What it protects on this route specifically is thin and worth naming
honestly: the real `kdf_salt` is not a secret, but it is a per-account value, and a
cache that retains it turns §4.3's indistinguishability into something an attacker
can test against a shared proxy instead of against the relay.

**`POST /v1/login`** — no authentication. Response `Cache-Control: no-store`,
because the body carries a credential.

**That `no-store` extends brief §10; it does not restate it.** §10 requires the
header on _ciphertext_ responses, and §10.1 sets it as object metadata at upload
time precisely so that no code path can forget it. A `/login` response is neither
ciphertext nor an object, so nothing in §10 reaches it — this is §10's _reasoning_
applied to a second kind of body that must not be cached, a bearer token rather
than an encrypted photograph. Two consequences worth stating. It is set by the
handler, so unlike §10.1's object metadata it **can** be forgotten, which is the
same failure shape §10.1 records for the signed-URL override and §1.1 for the
`?? 400` fallback. And the trigger is the _content of the response_, not the route:
`/login`'s `200` is the only response in PR 2 that carries a credential, and PR 4's
wrapped-blob route will need the same extension for the same reason.

- **Request body: the address exactly as typed, and the login proof.** **The
  labelled gap this bullet used to carry is closed** — brief §12 settled the
  account model as email and password on 20 August 2026 (§5.2). Every other
  property of this route was already fixed and did not move, which is what the
  gap was labelled to make visible.

  | Field   | Type                | Notes                                                                                                                                                                                                                                  |
  | ------- | ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | `email` | string, 1–254 chars | As typed — the same schema object as `/signup` and `/login/params`                                                                                                                                                                     |
  | `proof` | 43 chars → 32 bytes | Same field, same decoding, same length as `/signup`'s. Malformed → `400`, before any lookup: a string that is not a well-formed proof cannot be one, and rejecting it early is not an oracle because it says nothing about the address |

  **What the handler does with it, in order**, since §4.3's timing rule is about
  this order: normalise the address (§8.2); look up the `owners` row **and, on
  miss, substitute a fixed dummy row** whose `auth_hash` is a constant the server
  holds for the purpose; compute `HMAC(pepper, proof)`; compare against the
  row's `auth_hash` in constant time; on match, mint the token (§7.4), insert the
  `owner_tokens` row, and answer. The dummy row is what makes the miss path run
  the same instructions as the hit path — one HMAC, one comparison — rather than
  returning early. **The comparison is the one place in this system where two
  32-byte values are compared rather than looked up** (§7.2's rule is about
  tokens, which are looked up by hash), so it is the one place that needs a
  constant-time compare, and the test in §6.2 asserts it is used.

- **The password is not in that list, and its absence is the design.** The client
  derives the proof locally, using the salt and parameters from `/login/params`,
  and sends only the proof (encryption spec §6.6). This is not hardening: the KEK
  is derived from the password, so a relay that receives the password could
  compute the KEK itself — _able_ to unwrap while merely choosing not to.
  Non-negotiable #16 forbids transmitting derived keys; transmitting the input
  they are derived from is the same thing by another route. **The proof is still a
  bearer-equivalent secret** and is covered by the no-body-in-logs rule below.
- **The relay applies `HMAC(pepper, proof)`** and compares against
  `owners.auth_hash` (encryption spec §6.6.1, schema §3). **This was flagged as
  ambiguous earlier on 21 August 2026 and is now settled** — see §5.2, including
  why both of this document's earlier answers, a plain fast hash and relay-side
  Argon2id, were wrong. The request and response shapes are unaffected either way;
  what does move is §7.6, whose cost argument assumed the relay ran a KDF.
- **The pepper is not a parameter and never leaves the relay.** It is not in this
  response, not in `/login/params`, and not derivable from anything a client
  holds. Absent at boot MUST be a hard error — **and note the failure mode differs
  from the decoy secret's**: a missing pepper breaks every login loudly, _except_
  on a fresh deployment with no accounts, where generate-if-missing works and the
  damage surfaces only once real accounts exist. Non-negotiable #17.
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
  re-login is friction on the person who has to _want_ to use this. The additional
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
system whose _body_ holds one — the redaction list in §6.1 covers two headers and
nothing else. `/signup`'s body now holds more (wrap material and a proof), so the
rule has a second subject from the same amendment. §1.2 settles the mechanism, and
settles it **globally rather than for this route**: a validation failure logs a
projection of `instancePath`, `keyword` and `schemaPath` — plus
`params.missingProperty` on `required` alone, per §1.2's keyword-specific
exception — and never the error object, never `message`, never `data`. Route-local
suppression was rejected for the usual reason: it would require a route author to
know their body is sensitive, and forgetting the flag would be silent.

**The mechanism is in place as of 20 August 2026**, and it is now safe _by
construction_ rather than safe under today's AJV: the payload is built from a
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

**The `/login` limiter is not optional hardening — but the reason changed on
21 August 2026, and the old reason must not be left standing.** This section
argued that §7.5's dummy-value mitigation makes every attempt against an unknown
account run the same full Argon2id verification a real one does, so an
unauthenticated caller could force one 64-MiB-class allocation per request, and
the limiter bounded a memory-exhaustion vector the product had created
deliberately. **That argument is void.** Encryption spec §6.6.1 settles the
relay's side as `HMAC(pepper, proof)`, and one of its stated reasons for the
pepper is precisely that it keeps the dummy verification from becoming a
memory-allocation vector — which Argon2id would have made it by construction. The
relay verifies a login for the cost of one HMAC. **There is no work here to
exhaust.**

Recorded rather than silently reverted, because a reader who finds the
memory-exhaustion wording in the history will otherwise mistake it for the
current rule — and because it is the third consecutive claim this section has made
about the same layer (fast hash, then relay-side Argon2id, now the pepper) and the
history is what stops a fourth from being argued from scratch.

**What justifies the limiter now** is what already justified it on
`/login/params`, so the two arguments merge rather than sitting apart:

- **Credential stuffing.** Three unauthenticated routes with no token to key on
  are the only unlimited surface in the system, and an unbounded `/login` is an
  offline attack conducted online.
- **§4.3's indistinguishability is per-response, not per-campaign.** Decoys and
  dummy verification make one answer uninformative; unlimited answers are still a
  harvesting surface. `/signup`'s `409` makes that concrete — it reveals existence
  by design (§4.3), so an unlimited `/signup` is an enumeration oracle whatever
  the other two routes do.

**State the reason, or the limiter reads as friction and gets removed.** Note that
it survives the correction intact: what changed is why it is there, not whether.
And the cost argument's disappearance is not a reason to relax the numbers — a
limiter sized against an allocation cost that no longer exists would be sized
against nothing, which is the mistake in the opposite direction.

**Keyed on IP, and this is the one place that is right.** Every other limit in the
system keys on the token hash, because a family behind one NAT shares an address
and mobile data changes it mid-session (PR 5). These three routes have no token to
key on, which makes them both the obvious targets and the only routes otherwise
unlimited. The NAT objection is weak here: a family makes a handful of login
attempts a day, and **10 per 15 minutes per IP** — provisional — inconveniences
nobody while slowing credential stuffing. If you decide not to limit them, say so
explicitly rather than leaving the gap silent.

**`/login/params` needed the limit for a different reason, and that reason is now
the shared one.** It is not protecting work — the route is a lookup and an HMAC —
it is protecting §4.3, since the decoys make existence undetectable per response
while an attacker who can query without limit harvests the address space anyway.
**As of the pepper correction, `/login` is in the same position**: it too is a
lookup and an HMAC. The note kept here is the one that has outlived two versions
of this section — a limiter sized only against a KDF cost would reasonably be
relaxed on a route that has none, and every one of these three routes now has
none. **Same IP basis, same numbers, and no longer a different
justification.**

**The limiter is in-process state.** Correct on one instance, silently broken on
two. PR 5 states this as a general property of the rate limiting in this system;
it is true from the moment _this_ limiter exists, three sections earlier, so
nobody should add Redis to Phase 0 or scale to two instances without noticing.

**`Retry-After` must be in `Access-Control-Expose-Headers`** or a cross-origin
client cannot read the interval it is being asked to wait for (§3.1). These are
the first routes in the system that can produce a `429`.

### 7.7 The recipient credential, and creating one

**The invite _is_ the credential.** No login, no account, no session: possession of
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

| Field                                                 | Type                                      | Notes                                                                                                                                                                                                                                                                                                                                            |
| ----------------------------------------------------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `id`                                                  | uuid                                      | **Client-generated, required, no server default.** It is inside the wrap AAD — `"vitrina-wrap-v1" ‖ recipient_id`, 16 raw bytes (encryption spec §6.2) — so the client needs it before it can compute `wrapped`. A server-assigned id breaks unwrapping, works fine for QR recipients, and fails as an opaque AEAD error (brief §9.3; schema §3) |
| `kind`                                                | `"qr"` \| `"passphrase"`                  | Enum, mirroring the `CHECK`                                                                                                                                                                                                                                                                                                                      |
| `label`                                               | string                                    | Plaintext on the relay today; whether it becomes encrypted is §5.3                                                                                                                                                                                                                                                                               |
| `token_hash`                                          | 43 chars base64url → **exactly 32 bytes** | SHA-256 of the 32 raw token bytes, computed by the client (§7.4)                                                                                                                                                                                                                                                                                 |
| `wrapped`                                             | 64 chars → 48 bytes                       | **passphrase only**, forbidden for `qr`                                                                                                                                                                                                                                                                                                          |
| `wrap_nonce`                                          | 32 chars → 24 bytes                       | **passphrase only.** The field that gets forgotten, and without it the blob is undecryptable                                                                                                                                                                                                                                                     |
| `kdf_salt`                                            | 22 chars → 16 bytes                       | **passphrase only**                                                                                                                                                                                                                                                                                                                              |
| `kdf_memory_kib`, `kdf_iterations`, `kdf_parallelism` | integer                                   | **passphrase only.** Stored per row so they can be raised without invalidating existing invitations                                                                                                                                                                                                                                              |

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
of this section guaranteed _length_ for all four and canonical form for
`token_hash` alone, which left three fields with a weaker guarantee for no stated
reason.

**One field is worse than `token_hash`, which is the argument for making the rule
uniform rather than per-field.** Schema §6 derives the re-encode check from
base64url's spare trailing bits, and those depend on whether the byte length
divides by three:

| Field        | Bytes | Chars | Spare bits | Distinct spellings of the same bytes |
| ------------ | ----- | ----- | ---------- | ------------------------------------ |
| `wrapped`    | 48    | 64    | 0          | 1                                    |
| `wrap_nonce` | 24    | 32    | 0          | 1                                    |
| `token_hash` | 32    | 43    | 2          | **4**                                |
| `kdf_salt`   | 16    | 22    | 4          | **16**                               |

So the field carrying the _most_ non-canonical spellings is `kdf_salt`, not
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
indistinguishable to any validator. What the schema _does_ catch is everything
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
also why `DELETE` left the CORS `methods` list in PR 3 (§3.2, §9.9): nothing in
the v1 surface uses it.

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

|                                    | Create (§7.7)                      | Revoke                                 |
| ---------------------------------- | ---------------------------------- | -------------------------------------- |
| Path                               | `/v1/albums/{album_id}/recipients` | `/v1/recipients/{recipient_id}/revoke` |
| Does a `recipients` row exist yet? | **No**                             | Yes                                    |
| Where the album comes from         | the caller states it               | derived from the row                   |

**At create time there is no recipient row, so the album cannot be derived from
anything** — the client mints `id` (it is inside the wrap AAD), but a not-yet-stored
id joins to nothing, so the album is necessarily an _input_. **At revoke time the
row exists and determines its album**, so asking for the album again would add a
second value that can contradict the first and require a rule for the mismatch.
One route must be told which album; the other must not be asked. Each takes the
album from the only place available to it.

That leaves only _where_ create's album id goes — path or body — and the path wins
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

| Route                                       | Scheme | Body                                                                                                                           | Success                                                                   | Errors                                            |
| ------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------- | ------------------------------------------------- |
| `POST /v1/signup`                           | none   | address as typed · proof · `kdf_salt` + params · `wrapped_master` · `wrap_nonce` (§7.5) — never the password, never `K_master` | `201` `{id, created_at, token, expires_at}`, `no-store`                   | 400 · 409 `CONFLICT` · 413 · 415 · 429            |
| `POST /v1/login/params`                     | none   | address as typed (§7.5)                                                                                                        | `200` — `{kdf_salt, params}` only, **always**, decoys on miss, `no-store` | 400 · 413 · 415 · 429                             |
| `POST /v1/login`                            | none   | address as typed · proof (§7.5)                                                                                                | `200` `{token, expires_at}`, `no-store`                                   | 400 · 401 `INVALID_CREDENTIALS` · 413 · 415 · 429 |
| `POST /v1/logout`                           | owner  | none                                                                                                                           | `204`                                                                     | 401                                               |
| `POST /v1/logout/all`                       | owner  | none                                                                                                                           | `204`                                                                     | 401                                               |
| `POST /v1/albums/{album_id}/recipients`     | owner  | §7.7                                                                                                                           | `201` `{id, created_at}`                                                  | 400 · 401 · 404 · 409 · 413                       |
| `POST /v1/recipients/{recipient_id}/revoke` | owner  | none                                                                                                                           | `200` `{revoked_at}`                                                      | 401 · 404                                         |
| `GET /v1/owner/key` _(PR 2b, §8.3)_         | owner  | none                                                                                                                           | `200` `{kdf_salt, params, wrapped_master, wrap_nonce}`, `no-store`        | 401                                               |

**Seven became eight on 13 September 2026**, with PR 2b's owner-key fetch — listed
here so this table stays the one place every owner-auth route appears, though its
definition is §8.3. The three credential routes' bodies are now field tables in
§7.5, at the level §7.7 already had.

All eight carry the `/v1` prefix from the single mount point (§2) and none writes
it itself. **Three are unauthenticated**, all three at the top, and all three are
rate-limited on IP (§7.6) — the only routes in the system without a token to key
on. **No route here is recipient-authenticated:** PR 2 defines what a recipient
credential is and how it is checked, and PR 3 is where the first route consumes
one. `403 ACCESS_REVOKED` is therefore registered in this PR and first reachable in
the next (§1.1).

**Two rows carry wrap material** — `/signup` and create-recipient — and they are
§4.1's audit subjects. Neither carries a passphrase, a password, or a KEK. **One
row returns it** — `/owner/key` — and it returns exactly what `/signup` accepted,
wrapped, never unwrapped (§8.3).

**All three credential routes carry `no-store`**, as one rule rather than three
properties (§7.5). `/login/params` was the odd one out until 21 August 2026, with
no reason recorded either way.

**`/login/params` is the only route in the system that cannot answer `404`.** Not
an omission from the errors column: §4.3 is why, and a `404` there would defeat
the route's only purpose.

### 7.10 What PR 2 deliberately does not decide

- **The owner password's Argon2id parameters** — §5.2. **`POST /login`'s request
  body is no longer on this list**: brief §12 closed the account model and §7.5
  states the body. What remains is **the numbers, one set, client-side**,
  encryption spec §6.6's to settle, from phase-0-plan §8's V.1 measurement.
  **PR 2b gives them a provisional value and floors in §8.1** so the routes can be
  built and tested; V.1 confirms or moves the value, not the shape. **The
  coupled ambiguity about _what verifies the proof server-side_ is no longer on
  this list either**: §6.6.1 settled it on 21 August 2026 as `HMAC(pepper, proof)`,
  which withdrew the second parameter set and voided §7.6's memory-exhaustion
  argument — rewritten there, not carried forward.
- **Whether `recipients.label` is encrypted** — §5.3. **No longer described as
  coupled to §5.1**, which is closed and closed in the direction that dissolves
  the coupling; it is simply undecided. §7.7 accepts the field as plaintext today
  and the field's _shape_ is what would change, not the route's. Deferring costs a
  client-side lazy migration later, per §5.3.
- **Whether an owner ever authenticates as a recipient of someone else's album**
  — brief §11's "recipients will become owners". The tagged union in §7.1 is chosen
  so that this is additive: a nullable FK from `recipients` to `owners` changes no
  wire shape here.
- **Recipient-side rate limits** — PR 5, keyed on the token hash. Only `/login`'s
  limiter is settled here, because only `/login` has no token to key on.
- **The passphrase key-material route** — PR 4. It is the only route that _returns_
  key-adjacent material **to a recipient**, and §7.7's create is its mirror image:
  this PR settles how a wrapped blob is stored, PR 4 settles how it is handed
  back. _The owner-side equivalent is §8.3, PR 2b — this bullet said "the only
  route that returns key-adjacent material" until 13 September 2026, which was
  true only because the owner's had not been written._

---

## 8. Owner account bootstrap — what §7.5 had nowhere to put

**PR 2b, 13 September 2026.** Three things, none of them a new decision about the
auth model: the parameter set the credential routes validate against and return
(§8.1); the two server-side computations §7.5 names and does not define — address
normalisation and the one server secret's two uses (§8.2); and the route by which
a logged-in owner recovers their wrapped `K_master` (§8.3). §7.1–§7.4 apply to
everything here and are not restated. §4.3 governs the enumeration property and
is not restated either; §8.3 is authenticated and therefore outside it.

**Why a section rather than more bullets in §7.5.** §7.5 is the credential
lifecycle — the routes an owner calls to get and lose a session. §8.1 and §8.2 are
constants and functions those routes share, and §8.3 is a route that needs a
session rather than producing one. Folding them into §7.5 would make the longest
section in the document longer and put a _consumer_ of owner auth among its
_producers_, which is the conflation §7.1 spends a table preventing.

### 8.1 The owner Argon2id parameters — one set, client-side, with floors

**Decided here, provisionally, because the checklist's §4 assigned the decision
to this PR and the routes cannot be tested without a number.** Brief §12 and
encryption spec §6.6.1 fix the _shape_: exactly one Argon2id parameter set in the
system, applied by the client over the password, sized for the weakest phone the
product targets. They left the values to phase-0-plan §8's V.1 measurement, which
ran on 14 September 2026 and confirmed them: 2239 ms worst on a Helio G35 against
a pre-registered 3000 ms ceiling. The figures are normative (encryption spec §6.2)
rather than provisional.

|                   | Value                        | Status                                                                                                                               |
| ----------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Argon2id version  | **1.3 (`0x13`)**             | Normative — encryption spec §6.2, and not a parameter this API carries (§7.5)                                                        |
| `kdf_memory_kib`  | **65536** (64 MiB)           | v1 chosen value, **Confirmed by V.1**, 14 September 2026                                                                             |
| `kdf_iterations`  | **3**                        | as above                                                                                                                             |
| `kdf_parallelism` | **1**                        | as above                                                                                                                             |
| Floors, enforced  | `>= 16384` · `>= 2` · `>= 1` | Schema §3's floors for `recipients`, applied to `owner_keys` by the Phase 1 migration (§0) and mirrored in the `/signup` JSON Schema |

**The v1 values are §6.2's, and inheriting them is now consistent with the specs
rather than the mistake the checklist warned against.** The checklist's §4 said
the owner set "must be chosen for a server under concurrency, not inherited from
§6.2's 64 MiB, which was sized for a mobile WASM heap." That was written when the
relay was believed to run Argon2id; it does not (§5.2 — it peppers the proof).
Both sets now answer the identical constraint — a low-end Android phone's WASM
heap — and encryption spec §6.6.1's single-run design means the owner derivation
costs the phone _one_ run of it where the passphrase path also costs one. So the
same figure is the right starting point, and V.1 is the measurement that confirms
or amends it for both.

**The floors are what the server validates; the chosen values are what it
returns on a miss.** Those are two different uses and conflating them is the bug
to watch for:

- **`/signup` validates against the floors, never the chosen values.** A client
  is permitted to post _higher_ parameters — that is the entire reason they are
  stored per row. A schema that pins them to 65536/3/1 works today and rejects
  every account created after Phase 2 raises the default.
- **`/login/params` returns the chosen values on a miss** (§7.5), because a decoy
  must equal what real rows hold, and in v1 every real row holds these. The decoy
  values are therefore read from the same constant the client build uses to
  sign up — one constant, owned by `packages/shared` since both halves need it,
  and the Phase 2 note in §7.5 attaches to it.
- **No ceiling beyond the column type.** The relay never runs the KDF, so a
  client posting 4 GiB costs the relay nothing. What it costs is that owner's
  ability to log in from a phone, and the relay has no basis for judging that —
  it is a client build's responsibility to post values it can itself run.
  `integer` (`int4`) bounds it structurally; nothing product-level does, and the
  absence is deliberate rather than forgotten.

**There is exactly one function that inserts an `owner_keys` row**, in the
repository adapter, and the comment §7.5 asks for — that decoy indistinguishability
holds only while every row's parameters agree — goes on it. Phase 2's recovery
key inserts through the same function, which is how the comment is met by whoever
raises parameters for one account.

**If V.1 amends the values, nothing here changes shape.** The constant moves, new
rows carry the new value, existing rows keep theirs, and §7.5's Phase 2 warning
becomes live one phase early — which is worth knowing before V.1 runs, not after.

### 8.2 Server-side computations: address normalisation and the one secret

Both are named in §7.5 and encryption spec §6.6 as things the relay does; neither
was defined anywhere a route author could read. Both live in `packages/server`
(brief §6 #5) and nowhere else.

#### Address normalisation

**Applied by the relay, to every address on every credential route, before any
lookup, any uniqueness check and any decoy computation.** One function, called
from exactly three handlers, and the as-typed form is never stored and never
compared.

1. Unicode **NFC**.
2. Trim leading and trailing whitespace (Unicode `White_Space`).
3. Apply the platform's lowercase mapping, **then replace every `U+03C2` with `U+03C3` —** the same rule as encryption spec §6.3 step 3. **The reason here is consistency, not divergence:** this normalisation has exactly one implementation and clients are forbidden from touching it, so there is no second implementation to disagree with. What the substitution buys is that an address normalises the same way a passphrase does, one rule in two places rather than two rules that happen to agree.

**An address that is empty after normalisation MUST be rejected, on every credential route.**
`" "` is three characters, passes a 1–254 length check as typed, and normalises to `""` —
which `UNIQUE` then permits exactly once, leaving an account nobody can name.
`400 VALIDATION_FAILED` with no `details`, on all three routes: emptiness is a property of the
input rather than of whether an account exists, so rejecting it reveals nothing and §4.3 is
untouched. Same class as encryption spec §6.6.2's empty-password rule, and missed there for
the same reason — a length check on the as-typed form says nothing about what survives
normalisation.

Nothing else. No IDNA on the domain, no dot-stripping in the local part, no
plus-suffix removal — each is a provider convention, not an address property,
and each would merge addresses their provider keeps separate.

**The sigma substitution merges two addresses a provider might keep separate —** `οδυσσευς@x.es` and `οδυσσευσ@x.es` become one account — which is the thing the list above rejects dot-stripping for. Accepted, on the same terms as lowercasing the local part: a strictly smaller loss, and the alternative is an address normalising differently from a passphrase. Recorded so it is a decision.

**Why this can be simple, and why it can be wrong without being catastrophic.**
Encryption spec §6.6 rejected email-derived salts because the normalisation would
have had to agree byte-for-byte across four clients forever, and a disagreement
was an unopenable account. Under the chosen design the normalisation runs in one
place, on one implementation, against addresses the relay holds in plaintext. If
the rule above turns out to be wrong — too strict, too loose — the relay
re-normalises its own column and migrates. That recoverability is _the_ reason
the rule can be three steps and a paragraph rather than a specification with
vectors, and it is also why **clients must not pre-apply it** (§7.5): a client
that normalises is a second implementation of a rule that was made simple by
having one.

**Lowercasing the local part is technically lossy** — RFC 5321 permits a
case-sensitive local part — and is done anyway, because every provider a parent
uses treats it as insensitive, and the alternative is an owner who cannot log in
because they typed a capital on their phone. Recorded so it is a decision.

**Storage.** `owners.email` holds the normalised form and carries the `UNIQUE`
that `/signup`'s `409` fires on. The as-typed spelling is not retained: nothing
displays it, and keeping two spellings of an identifier is how a lookup path ends
up using the wrong one. _Schema §3's Phase 1 migration must agree with this
paragraph — it is stated here because the route is where the rule is exercised,
and flagged rather than assumed._

#### The one server secret and its two uses

Encryption spec §6.6.1: one secret, domain-separated into a decoy salt and an
auth pepper. Concretely:

```
decoy_salt = HMAC-SHA-256(secret, "vitrina-decoy-v1"       ‖ normalised_email)[0..16]
auth_hash  = HMAC-SHA-256(secret, "vitrina-auth-pepper-v1" ‖ proof)
```

Domain strings are ASCII, no null terminator, no length prefix — the convention
encryption spec §2 and §6.2 use. `proof` is the 32 raw bytes, never the base64url
string, on the same rule schema §6 applies to token hashing. `auth_hash` is 32
bytes and is compared in constant time (§7.5).

**`HMAC-SHA-256` is this document's reading of §6.6.1's `HMAC`.** §6.6.1 writes
`HMAC(secret, …)` and calls it "§2's existing pattern"; §2's pattern is _keyed
BLAKE2b_, which is a different construction. Either is sound here — the property
needed is a PRF the attacker cannot evaluate without the secret — and the relay is
the only implementation, so no cross-client agreement is at stake. But the
relay's own value is permanent: a change re-keys every `auth_hash` and every
decoy salt, which is the rotation §7.5 forbids. So one primitive has to be named
once, and it is named here as HMAC-SHA-256 because that is what the text says and
what Node's `crypto` provides without a dependency. **If encryption spec §6.6.1
means keyed BLAKE2b, that document must say so and this line changes before the
first account exists** — flagged to the spec, not resolved silently in either
direction.

**Loading, and the boot rule.** One environment variable, holding at least 32
bytes (base64url, decoded strictly, or hex — pick one in `config.ts` and reject
the other). Validated at boot alongside the CORS origin (§3): **absent or short is
a hard failure before the process listens**, never a generated substitute
(non-negotiable #17; the two failure modes are in §7.5 — the decoy use fails
silently, the pepper use fails loudly except on an empty deployment, and one
secret means the silent one governs). The variable's name is `config.ts`'s to
choose; what this document fixes is that there is one, that it is required, and
that no code path reads it from anywhere but the validated config object — a
second reader is a second place to fall back.

**Never returned, never logged, never in `details`.** Not a parameter (§7.5), so
not in `/login/params`; not derivable from anything a client holds; and the
redaction list in §6.1 does not cover it because it should never be near a log
line to redact — the config object it lives on is not something a handler logs.

### 8.3 `GET /v1/owner/key` — the owner's wrapped `K_master`, back

```
GET /v1/owner/key
```

Owner scheme. `200` with the caller's password-credential row, and
`Cache-Control: no-store`.

**Why the route has to exist.** Brief §11 chose a server-stored `K_master` over
device-local storage _because_ a parent has a phone and a laptop. The laptop has
never seen `K_master`; after `/login` it holds a session token and, in memory,
the KEK derived from the password. Something has to hand it `wrapped_master`.
Without this route the system can create an account, authenticate it, and never
decrypt anything on a second device — the read-side twin of the partial-failure
state §7.5's one-transaction rule closes on the write side.

| Field                                                 | Type               | Notes                                                                                                                                             |
| ----------------------------------------------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `kdf_salt`                                            | 22 chars, 16 bytes | The password row's. Repeated from `/login/params` so this response is self-contained — everything needed to unwrap `K_master` except the password |
| `kdf_memory_kib`, `kdf_iterations`, `kdf_parallelism` | integer            | as above                                                                                                                                          |
| `wrapped_master`                                      | 64 chars, 48 bytes | Exactly as posted at signup. The relay stores and returns it; it never inspects it                                                                |
| `wrap_nonce`                                          | 32 chars, 24 bytes | as above                                                                                                                                          |

**Why not fold it into `/login`'s `200`.** §7.5 fixes that response as
`{ token, expires_at }` and nothing else, and the reason survives contact with
this route: a session artefact and a key artefact have different lifetimes and
different consumers. A client restoring a two-week session on page refresh has a
token and no KEK; it asks the user for the password again and needs the wrapping
— and it should not need to _log in_ again to get it, because that would mint a
second session for the sake of a read. Phase 2's recovery credential is a second
`owner_keys` row with its own salt and wrapping, reached by a sibling of this
route; `/login` would otherwise grow a discriminator it has no other use for.

**Scope, and why §4.3 does not apply.** No id in the path: the row is the
caller's, resolved from the bearer token, so there is nothing to enumerate and no
`404` to leak — the only failure is `401`. This is the property PR 4's passphrase
route has to _argue_ for, because its caller is a recipient whose row is one of
many on an album; here it is structural.

**Returns wrapped, never unwrapped — stated next to §4.1 because the two rules
are a pair.** §4.1 forbids _accepting_ key material; this route and PR 4's are the
two that _return_ key-adjacent material, and what they return is ciphertext under
a key the relay never held. The route cannot unwrap because it has nothing to
unwrap with; that is a fact about the design, and this sentence exists so that a
reader who finds a wrapping in a response body does not read it as a hole in
§4.1.

**`no-store`, on §7.5's rule extended by one route.** §7.5's `/login` bullet
predicted this: "the trigger is the content of the response, not the route", and
"PR 4's wrapped-blob route will need the same extension for the same reason." So
does this one, and for the same reason PR 4's does — a cache holding
`wrapped_master` beside a device that also holds the password is a stolen
database in miniature. Stated as: **every response carrying a wrapped blob
carries `no-store`**, which covers §8.3, §9.2 and §10.1.

**Does not write the access log.** `access_log` records what _recipients_ do
with _media_ (schema §3, PR 5); an owner reading their own key material is
neither. Recorded because PR 4's route raises the same question for recipients
and leaves it open (§0), and the two should not be confused — here the answer is
structural, since the table has no column the event would fit.

**Method and shape.** `GET`, no body, because it reads one row and changes
nothing; §3's `methods` list already permits it. Singular `key`, because the
route returns the one password credential, and Phase 2's recovery credential
arrives as a sibling (`/owner/key/recovery`, or a `kind` segment — its PR's to
name) rather than by turning this response into a list. No `ETag` and no
conditional request: `no-store` makes the body uncacheable, and a validator on a
key artefact is a fingerprint of it for no benefit.

- **Errors:** `401 UNAUTHENTICATED`. Nothing else is reachable — no body to
  validate, no scope to miss.

### 8.4 The client's four calls, in order

Recorded so the three unauthenticated routes and §8.3 read as one flow rather
than four contracts, and so the point at which each secret exists is visible:

| Step | Call                                        | Client holds afterwards                            | Relay learns                             |
| ---- | ------------------------------------------- | -------------------------------------------------- | ---------------------------------------- |
| 1    | `POST /login/params` `{email}`              | salt, parameters                                   | an address was asked about               |
| 2    | _(local)_ Argon2id once → root → KEK, proof | KEK in memory, proof                               | nothing                                  |
| 3    | `POST /login` `{email, proof}`              | token, `expires_at`                                | the proof, which it peppers and discards |
| 4    | `GET /owner/key`                            | `wrapped_master`, nonce → **`K_master` in memory** | that a session read its key row          |
| 5    | _(session ends)_                            | nothing                                            | —                                        |

**When a session ends, the client frees `MasterKey`, `OwnerKek` and every `AlbumKey` handle.**
Three things end a session — logout, `expires_at` lapsing, and the tab closing —
and only the first is a click, which is why the rule is written about the session
rather than about the button. **Revocation and freeing are independent failures**
revoking without freeing leaves `K_master` live in WASM memory, and freeing without
revoking leaves a usable token. `OwnerCredential.proof` is a `Uint8Array` the caller
zeroes after `POST /login`.

**What this cannot deliver, stated so nothing claims it does:** the password reaches
`deriveOwnerCredential` as a JavaScript string, and a JavaScript string cannot be
wiped — it persists until the garbage collector reclaims it, on no schedule the
client controls. "The password never leaves the device" is true; "the password
is erased after use" is not, and no amount of freeing makes it so.

The password exists in step 2 only and reaches no request. `K_master` exists
after step 4 only, in memory, and reaches no request either — what reaches
requests from then on is `K_album` wrappings under it (PR 3). On signup the sequence is:
generate `K_master` and salt, step 2, `POST /signup` — which returns a session token,
so steps 1 and 3 are not repeated on that device — and step 4 is unnecessary there,
since the client already holds `K_master`. **The signing-up device therefore runs Argon2id exactly once.**
A second device runs steps 1–4 in full.

### 8.5 What PR 2b deliberately does not decide

- **Password change and email change.** Brief §11 notes a password change
  "re-wraps `K_master` once and leaves album keys untouched" — a new `owner_keys`
  row value and a new `auth_hash`, in one transaction, under the owner scheme.
  Not in the checklist's route surface and not in v1's; when it arrives it is an
  amendment to §7.5 and inherits §8.1 and §8.2 unchanged.
- **Recovery credentials** — Phase 2, encryption spec §6.6.1. A second
  `owner_keys` row, a sibling of §8.3, and a login shape that names the
  credential. §8.1's one-function rule and §7.5's Phase 2 note are written for it.
- **Whether V.1 moves the numbers in §8.1.** It may; the shape does not move.

---

## 9. The owner flow — albums, media, upload

**PR 3, 13 September 2026.** Seven routes: albums create and list, album
details, album encrypted metadata, media create, media status, and upload — the
last as two routes, one per object. Everything an owner does between logging in
and minting an invite (§7.7), and the two routes a recipient calls to see what an
album contains. **No ciphertext is delivered here and nothing here writes the
access log**: fetching chunks and thumbnails is PR 5 (§11), and PR 5 also owns the
logging behaviour of two routes _defined_ in this section — see §9.4 and §9.5,
each of which says so and points forward. That split is deliberate: the two
routes' logging rules are a contrast (one logs, one does not), and a contrast
split across two PRs reads as arbitrary from either half.

§7.1–§7.4 govern authentication throughout. Every timestamp is RFC 3339 UTC with
a trailing `Z` (§7.5). Every binary field is base64url in schema §6's canonical
form, strictly decoded (§7.7). No route here reads `Accept-Language` or returns
user-facing prose (§1.3).

### 9.1 What the owner posts and what the relay holds — the shape of the flow

Brief §11 fixed the key hierarchy the routes carry: `K_master` is unwrapped in
memory after §8.4's step 4; every `K_album` is 32 random bytes **wrapped under
`K_master` and stored on the album row**; every asset, thumbnail and metadata
envelope is encrypted under a key derived from `K_album` (encryption spec §2).
So the relay stores, per album, one wrapped blob it cannot open, and per media
row, one metadata envelope it cannot open and two objects in the bucket it cannot
open. **That is the whole of what PR 3 accepts**: titles in plaintext (§5.3, a
recorded limitation), identifiers, and ciphertext.

```
POST /v1/albums                          create — carries the wrapped K_album
GET  /v1/albums                          list, with every wrapping — owner only
GET  /v1/albums/{album_id}               details — owner or recipient; no logging
GET  /v1/albums/{album_id}/metadata      every metadata envelope — owner or recipient; logs (PR 5)
POST /v1/albums/{album_id}/media         media create — carries the metadata envelope
GET  /v1/media/{media_id}                status
PUT  /v1/media/{media_id}/asset          upload the asset envelope
PUT  /v1/media/{media_id}/thumbnail      upload the thumbnail envelope
```

**The wrap construction binds `album_id`, so `albums.id` is client-generated.**
Encryption spec §2 now fixes the `K_album`-under-`K_master` wrap with an AAD that
includes the album's 16 raw UUID bytes (37 bytes in total), on the same reasoning
as §6.2's `recipient_id` binding: a wrapping that does not name its album can be
moved to another album row and unwrap successfully there. The consequence for
this section is the one §7.7 and §9.6 already live with — the client needs the
id before it can compute the blob, so the id is an _input_ to create, with no
server default. Schema §1 now lists **three** client-generated ids and states
the rule that makes them one rule rather than three exceptions: **every id that
sits inside an AAD is client-generated.** Schema §3's `albums` carries
`wrapped_key` and `wrap_nonce` with their `octet_length` checks and no default
on `id`, all in the Phase 1 migration. _This paragraph was conditional when PR 3
was first written on 13 September 2026 — "if the spec binds `album_id`, then…"
— and the gap it flagged had sat in encryption spec §2 since the pepper decision.
It was found by having to write §9.2 and needing to know whether the id came
first. Recorded because it is the third format-level gap this month surfaced by
writing a route rather than by reading the spec._

This document carries `wrapped_key` (48 bytes) and `wrap_nonce` (24 bytes) and
never inspects them; the construction is the spec's, and nothing here depends on
it beyond the ordering above.

**The relay stays format-blind, deliberately.** It could parse the 64-byte
envelope header on upload — check `VTRN`, the version byte, that `asset_id` at
offset 36 equals the media id — and catch a broken client before a grandmother
sees a broken photograph. It does not, in v1: brief §9.2 removed `chunk_size`
and `plaintext_length` from the schema so the server would have no opinion about
envelope internals, PR 5's range handling is syntactic for the same reason (§11),
and a server that validates version `0x01` is a server that must be redeployed
for version `0x02`. What the server verifies about an object is that it exists
and is the size the server itself streamed (§9.7). A header check is additive if
it is ever wanted; its absence is a decision, recorded so it is not read as an
oversight.

### 9.2 `POST /v1/albums` and `GET /v1/albums`

**`POST /v1/albums`** — owner scheme. `201`.

| Field         | Type                    | Notes                                                                                                                                                                                                                                                              |
| ------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `id`          | uuid                    | **Client-generated, required, no server default.** It is inside the wrap AAD (encryption spec §2), so the client needs it before it can compute `wrapped_key` — the same shape as `media.id` (§9.6) and `recipients.id` (§7.7), and schema §1's rule for all three |
| `title`       | string, 1–200 chars     | Plaintext on the relay (§5.3). Owner-authored free text; no normalisation, no localisation (brief §15.1). 200 is a column bound, not a product rule                                                                                                                |
| `wrapped_key` | 64 chars → **48 bytes** | `K_album` (32) plus tag (16), under `K_master`. Ciphertext, not key material — §4.1's third accepted wrapping, after §7.7's and §7.5's                                                                                                                             |
| `wrap_nonce`  | 32 chars → 24 bytes     | The field that gets forgotten (§7.7)                                                                                                                                                                                                                               |

- **The wrapping is required.** An album row with no wrapping is an album whose
  owner can never re-open it from a second device — the same shape as §7.5's
  owner-without-`owner_keys`, one level down. Making the field optional "for
  now" is how that state becomes reachable.
- **`201`:** `{ "id": "<uuid>", "created_at": "<RFC 3339 UTC>" }` — the client's
  own id returned as the created resource's identifier, as §7.7 and §9.6 do.
- **`409 CONFLICT` on a duplicate `id`**, no `details`, on §9.6's reasoning
  exactly: a collision is the client retrying a create whose response it lost,
  the row it finds is its own, and a fresh id would orphan the wrapping already
  computed under the old one. `409` here means "already created".
- **Errors:** `400 VALIDATION_FAILED` · `401 UNAUTHENTICATED` · `409 CONFLICT` ·
  `413 PAYLOAD_TOO_LARGE` · `415 UNSUPPORTED_MEDIA_TYPE`.

**`GET /v1/albums`** — owner scheme. `200`, `Cache-Control: no-store`.

```jsonc
{
  "albums": [
    {
      "id": "…",
      "title": "…",
      "created_at": "…",
      "wrapped_key": "<64 chars>",
      "wrap_nonce": "<32 chars>",
      "media_count": 12,
    },
  ],
}
```

- **Every wrapping comes back in the list, and this is where the owner gets
  their album keys.** After §8.4 the client holds `K_master`; one call to this
  route and it holds every `K_album` it owns, in memory, for the session. The
  alternative — a per-album key route, or the wrapping on §9.4's details — was
  rejected because an owner needs `K_album` to _view_ their own album (the
  thumbnails are under a key derived from it), not only to upload, so a per-album
  fetch is one extra round trip on every album open; and because §9.4 is shared
  with recipients, and a route that returns key-adjacent material to one caller
  kind and not the other is a branch on `Caller.kind` at exactly the place §7.1
  says not to have one. **This route is owner-only by construction and therefore
  needs no branch.**
- **So it carries `no-store`**, under §8.3's rule — every response carrying a
  wrapped blob does. The third such route, with §8.3 and PR 4's.
- **Ordered by `created_at` descending. No pagination in v1.** A parent has a
  handful of albums; the response is small; and a paginated key list is a list an
  owner can hold half of. If a cap is ever needed it arrives as `?limit` and
  `?cursor`, additively.
- **`media_count` is a `COUNT(*)` over the album's media rows regardless of
  `status`**, for the album grid's "12 photos" label — it counts rows, not
  viewable assets, and the client should say "12" rather than "12 photos" until
  it has §9.4's statuses. Cheap enough that a subquery is fine at this scale;
  denormalising it is a Phase 2 question if it ever is one.
- **Errors:** `401 UNAUTHENTICATED`.

### 9.3 Scope resolution for album and media routes

§7.3's step 3, made concrete for the shapes in this section. Resolved **before**
the status is chosen, on every route below:

| Path carries | Owner scheme                                                   | Recipient scheme                                                                 |
| ------------ | -------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `{album_id}` | `albums.owner_id = caller.ownerId`, else `404`                 | `caller.albumId = album_id`, else `404` — **then** step 4's `revoked_at` → `403` |
| `{media_id}` | join `media → albums`, `owner_id = caller.ownerId`, else `404` | not applicable — no recipient route in this section takes a media id             |

Flat media paths (`/media/{media_id}`) for the reason §7.8 gives for flat revoke:
the row determines its album, and a path carrying both is a pair that can
disagree. Nested media _create_ for the reason §7.7's create is nested: the row
does not exist yet, so the album is necessarily an input.

**`403 ACCESS_REVOKED` becomes reachable in this section**, on §9.4 and §9.5 —
the first routes a recipient calls (§1.1's "first reachable" column). A revoked
recipient asking for their own album gets `403`; asking for any other gets `404`,
identically to an unrevoked one (§7.3, step 4 after step 3).

### 9.4 `GET /v1/albums/{album_id}` — album details

Owner **or** recipient scheme, declared explicitly (§7.1's tagged `Caller`).
`200`.

```jsonc
{
  "id": "…",
  "title": "…",
  "created_at": "…",
  "media": [
    { "id": "…", "kind": "photo", "status": "ready", "created_at": "…" },
  ],
}
```

- **Title, media ids, kind, status.** Exactly that — what a client needs to know
  which assets exist and which are viewable. Ordered by `media.created_at`
  ascending. No pagination in v1; a hundred-photo album is under 10 KB here.
- **Every media row is listed, whatever its `status`.** A recipient's client
  hides anything not `ready`; that filter lives in the client, because
  `status` is the mechanism non-negotiable #9 built for exactly this — a video
  in `processing` for three minutes must not vanish from the owner's grid — and a
  server that filtered per caller kind would be a second branch on `Caller.kind`.
  What a recipient learns from a `pending` row is that the owner is mid-upload;
  the metadata and objects behind it are not reachable until `ready` (§9.7).
- **No wrapped key, no metadata envelopes, no byte sizes.** The key is §9.2's,
  owner-only; the envelopes are §9.5's, because fetching them is the event that
  _is_ an album open; and `byte_size` is a storage-accounting cache (brief §9.2)
  that a client computes better from the header it fetches anyway.
- **Identical response shape for both caller kinds.** The route resolves one
  identity and then runs one query. Nothing in the body says which kind asked,
  which is what lets §7.1's rule — declare both, resolve to exactly one — hold
  without a downstream branch.
- **This route does not write the access log.** It may be called for reasons
  that are not an album open — a status poll after upload, a refresh of the
  owner's own grid, a client re-validating an id. **The logging rule and its
  contrast with §9.5 are stated in PR 5 (§11), not here** — this section defines
  the route and deliberately does not describe its logging, because the reason
  it does not log is the reason §9.5 does, and the two halves of that argument
  belong on one page.
- **Errors:** `401 UNAUTHENTICATED` · `403 ACCESS_REVOKED` · `404 NOT_FOUND`.

### 9.5 `GET /v1/albums/{album_id}/metadata` — every encrypted metadata envelope

Owner **or** recipient scheme, as §9.4. `200`, `Cache-Control: no-store`.

```jsonc
{
  "metadata": [
    { "media_id": "…", "envelope": "<base64url, the full envelope bytes>" },
  ],
}
```

- **One request returns every metadata envelope in the album.** Encryption spec
  §7 puts the envelope in a `bytea` column rather than the bucket for exactly
  this: a client cannot lay out a grid without the dimensions inside the
  envelopes, so it needs all of them before it can draw anything, and one query
  is the only way that is cheap. Each `envelope` is the complete bytes —
  64-byte header and chunks — under `K_meta(media_id)`; the relay returns the
  column verbatim.
- **Only rows with `status = 'ready'` are included.** Unlike §9.4, this is not a
  caller-kind filter — it is the same for owners — and it is the one place the
  server _does_ filter on status. A `pending` row's envelope was posted at create
  (§9.6) and describes an asset that does not exist yet; handing it out invites a
  client to lay out a cell it cannot fill. The owner's client learns about its
  own in-flight rows from §9.4 and §9.7, which is what those are for.
- **`no-store`**, on the ciphertext rule (brief §10, PR 5's §11): a metadata
  envelope is ciphertext, and §10's rule is about ciphertext responses, not about
  the bucket. This is the first ciphertext response in the document.
- **This is the route that writes `album_opened`, and PR 5 (§11) states that
  rule** — including why it is structurally once per album open. This section
  defines the route and, as with §9.4, says nothing further about its logging on
  purpose. A reader who wants to know why one of these two routes logs and the
  other does not reads §11 and finds both halves together.
- **Errors:** `401 UNAUTHENTICATED` · `403 ACCESS_REVOKED` · `404 NOT_FOUND`.

### 9.6 `POST /v1/albums/{album_id}/media` — media create

Owner scheme. `201`. Creates the row at `pending` with its metadata envelope;
the objects arrive by §9.7.

| Field      | Type                                        | Notes                                                                                                                                                                                                                                                                                                                |
| ---------- | ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`       | uuid                                        | **Client-generated, required, no server default** — it _is_ the envelope's `asset_id` (schema §1, brief §9.3), fixed before the client encrypted anything, so it cannot be assigned here                                                                                                                             |
| `kind`     | `"photo"`                                   | Enum of one value in v1. Schema §3 admits `'video'` from day one (non-negotiable #8); **the API schema does not**, until Phase 3 makes a video row mean something. Widening the enum is additive                                                                                                                     |
| `metadata` | base64url, **decoded length 81–4096 bytes** | The complete metadata envelope under `K_meta(id)` — filenames, capture time, dimensions (encryption spec §7). Lower bound is a 64-byte header plus one chunk of at least one byte plus a 16-byte tag; the upper bound is a body cap, not a format claim, and 4 KiB holds any v1 metadata document several times over |

- **The metadata envelope is posted here, not with the asset.** It is the one
  thing the client knows in full before encrypting the image — dimensions come
  from the decoded original — and putting it on the create means no `media` row
  ever exists without its envelope. A separate metadata upload would make "row
  exists, envelope missing" a reachable state that §9.5 would then have to
  filter. The row's `metadata` column was nullable because the schema predated
  this decision; schema §3 now marks it `NOT NULL` for the Phase 1 migration, and
  the API never writes a null either way.
- **`201`:** `{ "id": "…", "status": "pending", "created_at": "…" }`. The id is
  the client's own, returned as the created resource's identifier, exactly as
  §7.7 returns `recipients.id`; #15 is a rule about error responses and does not
  reach a `201`.
- **`409 CONFLICT` on a duplicate `id`**, with no `details` — the same rule and
  the same remedy as §7.7. An id colliding within the album is a client
  retrying a create whose response it lost, and the row it finds is its own; an
  id colliding across albums is a UUIDv4 collision and will not happen (encryption
  spec §2). Either way the client's next step is §9.7, not a new id — **a new id
  would orphan the envelope the client already encrypted under the old one**, so
  the client must treat `409` here as "already created", not as "try again".
- **Errors:** `400 VALIDATION_FAILED` · `401 UNAUTHENTICATED` · `404 NOT_FOUND`
  (album absent or not the caller's) · `409 CONFLICT` · `413 PAYLOAD_TOO_LARGE` ·
  `415 UNSUPPORTED_MEDIA_TYPE`.

### 9.7 Upload — `PUT /v1/media/{media_id}/asset` and `/thumbnail` — and who sets `status` on what evidence

Owner scheme. Body is the raw envelope, `Content-Type: application/octet-stream`.
`200` with the status object (§9.8's shape).

**Proxied, not a presigned `PUT`.** Brief §10.1 settled delivery on proxying for
Phase 1; upload follows for the same reason and two more. One mechanism in v1,
not two — a presigned upload would be the only signed-URL code in the system, with
its own auth story and its own `Cache-Control` path. The bandwidth argument for
presigning is moot at roughly 8 MB per album. And a presigned `PUT` from a browser
needs bucket CORS configured and verified against SeaweedFS _and_ against Hetzner
(brief §12), which is a second B.4 for a benefit the numbers do not show.

**Two routes because there are two objects.** Asset and thumbnail are separate
objects under separately derived keys (`K_asset`, `K_thumb` — encryption spec
§2), stored separately so that PR 5 can fetch a thumbnail without knowing
anything about the asset. The server has to know which it is being handed; a path
segment is the least ambiguous way to be told.

**Object keys are derived from `media.id`, never stored** (brief §9.2): the
asset at `media/{id}/asset`, the thumbnail at `media/{id}/thumbnail`, `{id}` in
its canonical lowercase 36-character form. Two objects per row, both keys
computable from the row, no column that can disagree with the bucket. Named once
here so PR 5's fetch routes and any future erasure worker (§4.2) derive the same
strings.

#### The body limit, and the number

**`bodyLimit` is per route, and these two routes replace the placeholder.**
`server.ts` holds 1 MiB globally "until B.6 settles the upload path"; that
global stays where it is for JSON routes, and the two upload routes set their own:

| Route             | `bodyLimit` | Why                                                                                                                                                                                                                                                                                                                      |
| ----------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `PUT …/asset`     | **16 MiB**  | A 1600 px long-edge JPEG (non-negotiable #14) is typically under a megabyte and not reliably so — a detailed photograph at high quality can approach 3 MB — plus 64 bytes of header and 16 per 256 KiB chunk. 16 MiB is several times any legitimate asset and small enough that a runaway client is stopped at the edge |
| `PUT …/thumbnail` | **1 MiB**   | A thumbnail is one chunk by construction (PR 5, §11) — a few hundred pixels, tens of kilobytes                                                                                                                                                                                                                           |

Exceeding either is `413 PAYLOAD_TOO_LARGE` from the framework (§1.2), which is
why §1.1 registered the code ahead of this route and why it must never fold into
`VALIDATION_FAILED`. **Real abuse limits — per-owner quota, per-album counts —
are Phase 2.** The route still needs a number now, and these are them:
provisional, and marked so.

**`Content-Length` is required; chunked transfer encoding is not accepted.** A
request without it is `411 LENGTH_REQUIRED`, a code this PR adds (§1.1). This is
not a client-declared size in the sense §9.7's status rule forbids — it is HTTP
framing, and the server does not _believe_ it: it counts. What requiring it buys
is that the framework's `bodyLimit` check happens before the first byte rather
than after the last, and that the storage `PutObject` can be given a length up
front, so a stream that ends early fails at the store rather than committing a
short object.

#### Status is set by the server, on evidence, and no client-declared size is involved

Non-negotiable #9's ladder — `pending → processing → ready → failed` — and who
moves the row along it:

| Transition             | When                                                                                         | Who                                        |
| ---------------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------ |
| `pending → processing` | The first byte of either object arrives                                                      | server, on the upload route                |
| `processing → ready`   | **Both** objects exist in storage and each is the size the server counted while streaming it | server, on completion of the second upload |
| `processing → failed`  | A stream ends early, or `PutObject` fails, or the confirming `HEAD` disagrees with the count | server                                     |
| `failed → processing`  | The client re-uploads                                                                        | server, on the upload route                |

**The evidence.** Because upload is proxied, the server streamed the bytes and
therefore _counted_ them — every byte of the envelope passed through it. On
completion it issues one `HEAD` against the object it just wrote and compares
`Content-Length` to its own count:

- **Match** → that object is confirmed. When both are, the row becomes `ready`
  and **`byte_size` is populated from the server's observed counts — the sum of
  the two objects** — for brief §9.2's storage accounting. No client number is
  read at any point; the client never sent one.
- **Missing, or a different size** → `failed`, and the status object carries
  that. The client's remedy is to re-upload, and it can, because `failed →
processing` is a legal transition.
- **Not yet visible** — `HEAD` says the object does not exist immediately after
  a successful `PutObject` — → the row stays `processing` and the client retries
  §9.8 in a few seconds. AWS S3 has been read-after-write consistent for new
  objects since 2020; whether SeaweedFS and Hetzner's store are is a B.4-class
  assertion to add, not an assumption to make. The branch is specified either
  way: one that is specified and unreachable costs nothing, one that is
  unspecified and reachable shows a spinner forever.

**`ready` therefore _means_ something a viewer can rely on: both objects exist,
and each is the size the server itself counted while streaming it.** Nothing is
_claimed_ — there is no client-declared size for the server to have believed.
Client-asserted `ready` would mean "a client said so", and a client that lost its
connection after saying so shows a broken photograph to a grandmother, silently.
That is why the transition is the server's and only the server's: no route
accepts a `status` field, on any body, ever.

**What the server does not verify** is anything about the bytes' _contents_ —
§9.1's format-blindness. `ready` says the object is whole; whether it decrypts
is between the client that encrypted it and the client that opens it.

#### Re-upload, ordering, and the stall

- **Order is free.** Asset first or thumbnail first; `ready` waits for both.
- **Re-upload is permitted in `pending`, `processing` and `failed`, and refused
  in `ready` with `409 CONFLICT`.** `PUT` replaces the object, so a second upload
  before `ready` is simply the client's latest attempt. After `ready`, replacing
  an object a recipient may be mid-fetch on is editing, and v1 has no album
  editing (schema §5). If editing arrives it is a route with its own transition,
  not a relaxation here.
- **A `media` row can stall, and detection is deferred.** A row created at
  `pending` whose client never uploads sits there indefinitely; so does one at
  `processing` whose second object never arrives. A stream that _ends early_ can
  be marked `failed` because the server sees it end; an _abandoned_ create
  cannot, because nothing happens. `updated_at` exists in the schema for exactly
  this — it moves on every transition — and **nothing yet reads it.** A sweep
  that marks rows stale after some interval is Phase 2 and needs a number nobody
  has; until then §9.4 lists such rows honestly as `pending`, the owner's client
  can offer a retry, and the owner's storage is not charged because nothing was
  stored. Recorded so the state is known rather than discovered.
- **Errors:** `401 UNAUTHENTICATED` · `404 NOT_FOUND` · `409 CONFLICT` (row is
  `ready`) · `411 LENGTH_REQUIRED` · `413 PAYLOAD_TOO_LARGE` ·
  `415 UNSUPPORTED_MEDIA_TYPE` (anything but `application/octet-stream`).

### 9.8 `GET /v1/media/{media_id}` — status

Owner scheme. `200`:

```jsonc
{
  "id": "…",
  "album_id": "…",
  "kind": "photo",
  "status": "processing", // pending | processing | ready | failed
  "byte_size": null, // integer once ready; null before
  "created_at": "…",
  "updated_at": "…",
}
```

- **The shape the upload routes return**, so a client has one type for "where is
  this row" whether it asked or was told.
- **Owner-only.** A recipient learns status from §9.4, per album; there is no
  recipient case for polling one row.
- **`updated_at` is on the wire** so the owner's client can render "stuck since
  …" without the server having an opinion about what stuck means (§9.7).
- **No `details` on `failed`, and no reason string.** The status object says the
  upload did not complete; the client's action is the same regardless of why —
  retry — and a reason field is where a storage error's text would leak (§1.2).
- **Errors:** `401 UNAUTHENTICATED` · `404 NOT_FOUND`.

### 9.9 What this section changes elsewhere

- **§3's `methods` gains `PUT` and loses `DELETE`.** The two upload routes are
  the first `PUT`s; nothing in B.6's route surface issues a `DELETE` (§3.2's
  loose end, now closed — album and owner deletion have no route in v1, and
  §4.2 remains a constraint on the operation that will). `Content-Type:
application/octet-stream` is not a CORS-safelisted value, so the upload
  requests preflight — as every authenticated request already does (§3.1).
- **§1.1 gains `LENGTH_REQUIRED`/411**, thrown by the upload routes' handler
  when `Content-Length` is absent. Not a framework code — Fastify does not raise
  411 — so it is not in §1.2's inverse table.
- **`ACCESS_REVOKED` is first reachable here**, on §9.4 and §9.5.
- **§4.1's audit gains a third wrap-accepting route**, §9.2's album create. Three
  routes carry a wrapping; none carries the key that made it.
- **§6.2 gains the rows in the table there tagged PR 3.**

### 9.10 What PR 3 deliberately does not decide

- **Album and owner deletion.** No route. §4.2 stands as the constraint on the
  operation when it arrives; the object-key derivation in §9.7 is what an erasure
  worker will enumerate.
- **Album editing** — title change, media removal, re-ordering. None in v1
  (schema §5). §9.7's `409` after `ready` is where the first of these will have
  to be argued.
- **The stall interval** — §9.7. `updated_at` is there; the number is not.
- **Quotas and abuse limits** — Phase 2. The body limits in §9.7 are edge
  protection, not policy.
- **Whether `albums.title` becomes ciphertext** — §5.3. If it does, §9.2's
  `title` becomes a base64url envelope field and §9.4 returns it as such; the
  routes do not otherwise change.
- ~~The `K_album` wrap construction and the `albums` columns that hold it~~ —
  **closed** the same day, in encryption spec §2 and schema §3 respectively; §9.1
  records the outcome and §9.2 carries it.

---

## 10. The passphrase recipient's key material

**PR 4, 13 September 2026. One route.** A passphrase recipient arrives holding
what the invite carried — relay, album id, token — and no key (invite spec §4,
encryption spec §6.5). To derive `K_album` they need what §7.7 stored: `wrapped`,
`wrap_nonce`, `kdf_salt` and the three Argon2id parameters. Without a route that
hands those back the passphrase path is unimplementable; with it, the relay
participates in every unwrap, which is the lever encryption spec §6.5 describes
and the reason this route is reviewed on its own.

§7.1–§7.4 govern; §7.3's ladder runs in full, recipient branch. §4.3 does not
apply — the route is authenticated. §8.3's rule applies — the response carries a
wrapped blob, so it carries `no-store`.

### 10.1 `GET /v1/recipient/key`

Recipient scheme **only**. `200`, `Cache-Control: no-store`.

```
GET /v1/recipient/key
```

| Field                                                 | Type               | Notes                                                                                                                                                                                                                                      |
| ----------------------------------------------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `id`                                                  | uuid               | `recipients.id` — the caller's own row. **Returned because the client needs it and may not have it**: it is inside the wrap AAD (`"vitrina-wrap-v1" ‖ recipient_id`, encryption spec §6.2), so no unwrap is possible without it. See §10.3 |
| `kdf_salt`                                            | 22 chars, 16 bytes |                                                                                                                                                                                                                                            |
| `kdf_memory_kib`, `kdf_iterations`, `kdf_parallelism` | integer            | The row's own values — a client MUST use these and not a constant (encryption spec §9 category 9 exists to catch the one that does)                                                                                                        |
| `wrapped`                                             | 64 chars, 48 bytes | `K_album` under the passphrase-derived KEK, exactly as §7.7 stored it                                                                                                                                                                      |
| `wrap_nonce`                                          | 32 chars, 24 bytes |                                                                                                                                                                                                                                            |

Field names are §7.7's, unchanged, for the reason §7.5 gives about
`/login/params`: the same six values making the return trip should not have two
spellings.

- **No id in the path, and that is the scope check.** The bearer token resolves
  to exactly one `recipients` row (§7.3, step 1); the route returns that row's
  columns and reads nothing else. There is no `{recipient_id}` to substitute,
  no `{album_id}` to disagree with the token's (§7.8's pair-that-can-disagree
  argument), and therefore nothing to enumerate. The checklist asked that this
  route be "scoped strictly to the caller's own row"; a flat path makes that a
  property of the URL rather than of a `WHERE` clause someone has to remember.
- **A QR recipient calling it gets `404 NOT_FOUND`**, no `details`. A `qr` row
  has all six columns NULL (schema §3): there is no key material for this caller
  and the honest answer is that the resource does not exist. No QR client ever
  calls this route, so the case is a probe or a bug either way, and `404` is
  what a nonexistent row would have answered under an id-bearing design — the
  equivalence the checklist asked for, now moot but preserved.
- **A revoked recipient gets `403 ACCESS_REVOKED`**, by §7.3 step 4 — and this is
  the one route where that matters beyond copy. Revocation stops the relay
  serving ciphertext (encryption spec §6.4); the wrapped key is the one piece of
  ciphertext whose continued availability would let a revoked passphrase holder
  finish an unwrap they had not yet started. Refusing it is the server's
  revocation doing exactly what brief §8 says it does, one artefact further.
- **Rate-limited on the token hash like every recipient route** (PR 5, §11).
  Nothing specific to this route in v1 — see §10.4.
- **Errors:** `401 UNAUTHENTICATED` · `403 ACCESS_REVOKED` · `404 NOT_FOUND`
  (QR recipient) · `429 RATE_LIMITED`.

### 10.2 Returns wrapped, never unwrapped — the rule, stated beside §4.1

§4.1 forbids every route from _accepting_ key material. It says nothing about
_returning_ it, because PR 1 had no route that did. Three now do — §8.3 for the
owner's `K_master`, §9.2 for the owner's `K_album`s, and this one for a
recipient's — and the rule for all three is written into §4.1 as of this PR,
where a reader checking a route against the constraints will find it:

**A route may return a wrapped blob and its public parameters. It may never
return, compute, or hold in a form it could return: the key that wraps the blob,
the secret that key was derived from, or the key inside it.** For this route
concretely: `wrapped` and its five companions, and never the passphrase, the
KEK, or `K_album`. The relay cannot violate this by accident — it has none of
the three — and the sentence exists so that a future route which _could_ (one
that took a passphrase "to help") is checked against a written rule rather than
an inferred one. The route-table walk §4.1 promises gains a second direction:
no response schema declares a field named for a key.

### 10.3 What this route hands a recipient, and what it does not

The passphrase flow, so the response shape is checkable against a use:

| Step | Who            | What                                                                                                                                        |
| ---- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | client         | opens the invite: relay, album id, token (invite spec §4)                                                                                   |
| 2    | client → relay | `GET /recipient/key` with the token → `id`, salt, params, `wrapped`, `wrap_nonce`                                                           |
| 3    | client         | takes the passphrase from the recipient, normalises it (encryption spec §6.3), rejects it if empty after normalisation                      |
| 4    | client         | Argon2id(passphrase, `kdf_salt`, params) → KEK; unwraps `wrapped` with `wrap_nonce` and AAD `"vitrina-wrap-v1" ‖ id` → `K_album`, in memory |
| 5    | client → relay | §9.4 details, §9.5 metadata, PR 5 fetches — as any recipient                                                                                |

Step 4's failure is an opaque AEAD error (encryption spec §9.1), and it is the
_client's_ to render — "wrong passphrase" — because the relay never learns
whether the unwrap succeeded. **This is the honest limit of the §6.5 lever in
v1: the relay can count fetches of the blob, not unwraps of it.**

**`id` is in the response because the flow needs it at step 4 and the checklist
says the recipient arrives without it.** If invite spec §4's payload does carry
`recipient_id`, the field is redundant and a client may cross-check the two; if
it does not, this response is the only source. Flagged to the invite spec rather
than resolved here.

**Not returned: `label`, `album_id`, `kind`, `created_at`.** The album is in the
invite; the kind is implied by a `200`; and `label` is not this route's — a QR
recipient needs it too, for the watermark (brief §5), and cannot call here.

**That gap blocks PR 5, and is escalated rather than noted.** Trace it: brief §5's
watermark reads _"Shared privately with María · 6 Aug 2026"_, and its entire
deterrent is the name — it survives a screenshot and makes forwarding feel wrong,
which is the mechanism the brief chose over anything server-side. Ask where a
recipient's client gets `label`. Not the invite payload — invite spec §1 is
`{v, relay, album, token, key}`. Not §9.4's details, which is shared with owners
and carries no per-caller field. Not this route, which excludes it deliberately
and which a QR recipient cannot call at all. **Nowhere.** As the surface stood at
the end of PR 4, the client renders a watermark with no name in it, and brief
§5's mechanism is reduced to a date. Two candidate shapes, with asymmetric
timing — a recipient route, additive whenever; or a field in the invite payload,
which invite spec §6 makes a version increment, free today while no invites exist
and `v: 2` forever after. **Decided in §11.4, where the watermark's input is
consumed.**

### 10.4 Where encryption spec §6.5's lever lives, and that v1 does not pull it

Because the client must fetch the blob to derive `K_album`, the relay is in the
loop for every passphrase unwrap — the property §6.5 identifies as the mode's
advantage against a forwarded or captured invite. This is the route where that
lever would be pulled: count fetches, throttle them per row, bind the first to a
device, refuse after the first. **None of that is in v1**, and the route is
written so each is additive: a counter is a column on `recipients`, a
per-recipient throttle is a second key on the PR 5 limiter, a refusal is one more
condition before the `200`. Nothing here forecloses any of them, and nothing here
implements one — deciding _which_ is a product question about how much a
forwarded passphrase invite should be defended, and brief §11 and invite spec §8
own it.

### 10.5 Open, and left open: does a key fetch write the access log?

**Not decided here, deliberately** — it is a schema change as well as an API one,
since `access_log.event` is `CHECK (event IN ('album_opened','asset_viewed'))`
(schema §3) and a third value is a migration. Both shapes, so the decision is
made against them rather than from scratch:

- **Log it** as a third event, `media_id` NULL. Argument for: §6.5's lever
  begins with knowing it happened, and a fetch of the blob is the closest the
  relay gets to observing an unwrap. Cost: a third `event` value, and a row that
  duplicates the `album_opened` §9.5 writes moments later in the same flow (PR
  5, §11) — a passphrase recipient who fetches their key opens the album next,
  every time.
- **Do not log it.** Argument for: PR 5 makes the log _behavioural, not
  authorisational_ (§11) — it powers "María viewed this", and a key fetch is not
  a view. If §10.4's counting is ever wanted it belongs in a column on the row it
  counts, not in a table whose retention is a GDPR item (schema §3). Cost: the
  relay's one observation of the passphrase path goes unrecorded until someone
  decides it matters.

**v1 behaviour until decided: the route writes nothing.** That is the second
shape by default, not by decision, and it is recorded here so it is not mistaken
for one. It is not a #17 case — the property at stake is observability, not
security — which is why the default is tolerable where §8.2's would not be.

### 10.6 What PR 4 does not decide

- **§10.5.** Above.
- **Any §10.4 mechanism.** Additive, product-owned.
- **How `label` reaches the recipient** — §10.3's escalated gap, decided in
  §11.4 (PR 5), not here.

---

## 11. Delivery, rate limiting, and the access log

**PR 5, 13 September 2026.** The routes that move ciphertext to a viewer, the
limiter every authenticated route sits behind, the rules that make the access
log honest, the recipient's own row (the §10.3 escalation), and the owner's read
of the log. Five routes are defined here; two more — §9.4 and §9.5 — were defined
in PR 3 and have their logging behaviour stated here, because the contrast
between them _is_ the design and belongs on one page (§11.6). This is the
largest section and the lowest risk per line: nothing here accepts or returns key
material, and every rule is about bytes the relay cannot read.

§7.1–§7.4 govern; §9.3's scope table applies to `{media_id}` and `{album_id}`
unchanged. Every ciphertext response carries `Cache-Control: no-store` (brief
§10; §11.3).

### 11.1 Proxied, both directions, in v1 — and what that fixes

Brief §10.1 decided it, 11 August 2026: photos and thumbnails travel bucket →
relay → client; signed URLs direct to the store are Phase 3, for video. This
section records the consequences rather than the choice:

- **One auth path.** Every byte a recipient receives passed §7.3's ladder on the
  request that fetched it. Revocation is therefore checked per request and is
  genuinely immediate; the UI may say so without hedging (§7.8).
- **The log is honest for free.** A proxied fetch _is_ a retrieval, so
  `asset_viewed` can be recorded on the request that fetched the header — not on
  the issuance of a URL that may never be used (§11.6).
- **`no-store` is set by the relay** on every ciphertext response, directly,
  rather than depending on the store honouring an override (§11.3).
- **A later signed-URL endpoint is additive** (brief §10.1): it sits beside the
  chunk route under the same `/v1` mount (§2), and when it arrives, chunk fetches
  stop carrying `Authorization` and become preflight-free (§3.1). Nothing here
  forecloses it, and nothing here builds it.

### 11.2 `GET /v1/media/{media_id}/asset` — ranged chunk fetch

Owner **or** recipient scheme (§7.1's tagged `Caller`; §9.3's scope). The media
row must be `ready`, else `404 NOT_FOUND` for either caller — a row that is not
`ready` has no object a viewer may rely on (§9.7), and a `pending` row's absent
object is indistinguishable from an absent row on purpose.

**The client computes byte offsets; the server validates syntax and forwards.**
Encryption spec §3.3 makes the byte range of chunk _i_ arithmetic on the 64-byte
header, and the client does that arithmetic — it fetches header plus chunk 0 in
one range, reads `chunk_size` and `plaintext_length`, and computes every later
range itself. **The server never interprets a range semantically and knows
nothing about chunking.** It parses the `Range` header for well-formedness,
normalises it to a single `bytes=X-Y` or `bytes=X-`, hands that to the store,
and forwards the store's answer. "Forwards blindly" would be wrong — the server
_rejects_ malformed ranges (§11.2's table) — so the distinction is **syntax
versus semantics**: the server has an opinion about the shape of a `Range`
header and none about what byte 64 means.

**Why not a per-chunk-index route** (`…/chunks/{i}`), which reads more cleanly:
computing chunk _i_'s byte range server-side needs `chunk_size` and
`plaintext_length`, which brief §9.2 removed from the schema deliberately — the
header is authenticated by every chunk's AAD, and a database copy of it is a
value the header can contradict with no way to tell which is lying. Stated
explicitly so nobody adds the two columns back to make a nicer URL.

#### The range table — accepted and rejected forms, with status codes

**The asset route requires a valid `bytes=` range.** No `Range` header is a
`400`, not a `200` with the whole object.

| Request `Range` on the asset route                 | Response                                                                                 |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `bytes=X-Y`, valid, within the object              | `206` + `Content-Range: bytes X-Y/size`                                                  |
| `bytes=X-`, open-ended, `X <` object size          | `206` + `Content-Range: bytes X-(size-1)/size`                                           |
| `bytes=X-Y` where `Y >=` object size, `X <` size   | `206`, **clamped** — the store clamps, the relay forwards its `Content-Range` faithfully |
| `bytes=X-Y` where `X > Y`                          | `400 VALIDATION_FAILED`                                                                  |
| `bytes=X-` or `bytes=X-Y` where `X >=` object size | `416 RANGE_NOT_SATISFIABLE` + `Content-Range: bytes */size`                              |
| `bytes=-N` suffix range                            | `400 VALIDATION_FAILED`                                                                  |
| `bytes=A-B,C-D` multi-range                        | `400 VALIDATION_FAILED`                                                                  |
| Unrecognised unit, e.g. `items=0-10`               | `400 VALIDATION_FAILED`                                                                  |
| **No `Range` header at all**                       | `400 VALIDATION_FAILED`                                                                  |

**Requiring a range removes a case rather than handling it.** One response path,
always `206` on success, and §11.6's `asset_viewed` rule needs no second
condition for a range-less request — it is refused, not logged differently. Your
client's first request is header plus chunk 0 in one range, so nothing
legitimate is ever refused. `Accept-Ranges: bytes` is set on every response from
this route, including the `400`s, so a client that forgot the header is told what
the route wants.

**This is a deliberate deviation from RFC 9110**, which says an unrecognised
range unit — and a syntactically invalid `Range` — should be _ignored_ and the
full representation returned as `200`. Recorded as deliberate, with the reason:
the client is ours, and on a private API a single code path is worth more than
generality. A future "fix" toward RFC compliance would make a bare `GET` an
unlogged open (§11.6) and reopen exactly the hole this table closes. The `400`
carries `VALIDATION_FAILED`'s constant message and no `details` — a `Range` value
is request content (#15), and a client that sent `items=0-10` does not need to be
told what it sent.

**The `416` is the store's, forwarded.** The relay does not know the object size
— only the store does — so `X >=` size is discovered when the store answers
`InvalidRange`, and the relay maps that to `416 RANGE_NOT_SATISFIABLE` with the
store's `Content-Range: bytes */size`. A new code (§1.1); handler-mapped from
the storage error, not a framework code.

**Forwarded faithfully: `206`, `Content-Range`, `Content-Length`.** Set by the
relay: `Content-Type: application/octet-stream`, `Cache-Control: no-store`,
`Accept-Ranges: bytes`. **Not forwarded: `ETag`, `Last-Modified`, and every
`x-amz-*` header.** An `ETag` is a fingerprint of the ciphertext with no
consumer; `Last-Modified` is upload timing, which encryption spec §10 already
lists as visible but which the relay need not hand out per request; and the
store's own headers name the store. The whitelist is the shape — forward what
the table above requires and nothing the store happens to add — for the same
reason §1.2's log projection is a whitelist.

**Errors:** `400 VALIDATION_FAILED` · `401 UNAUTHENTICATED` · `403 ACCESS_REVOKED`
· `404 NOT_FOUND` (row absent, out of scope, or not `ready`) ·
`416 RANGE_NOT_SATISFIABLE` · `429 RATE_LIMITED`.

### 11.3 `GET /v1/media/{media_id}/thumbnail` — whole object, `Range` ignored

Same schemes, same scope, same `ready` requirement as §11.2. **Always `200` with
the whole object.** A thumbnail is one chunk by construction (§9.7's 1 MiB body
limit is the outer bound; a real one is tens of kilobytes) — there is nothing to
seek within, and a client that ranged it would fetch the same bytes in two
requests. A `Range` header, if present, is **ignored entirely**: not rejected,
not honoured. This is the RFC 9110 behaviour §11.2 deviates from, and here it is
correct because the route's contract is "the object", not "a part of it".

**Separate route from the asset, and that is not a style choice.** Asset and
thumbnail are separate objects under separately derived keys (`K_asset`,
`K_thumb`, encryption spec §2), at separate keys in the bucket (§9.7). The relay
has to know which it is being asked for; a path segment is how it is told. One
route with a `?variant=` would be the same information in a worse place —
§7.2's argument against query parameters is about tokens, but a query string
that changes _which object_ is served is one a proxy or a log treats as
optional.

**This has no bearing on preflights.** `Authorization` alone forces one whether
or not `Range` is present (§3.1); dropping `Range` here saves nothing.

**Headers:** `Content-Type: application/octet-stream`, `Content-Length` from the
store, `Cache-Control: no-store`. No `Content-Range`, no `Accept-Ranges` — the
route does not do ranges and should not advertise them.

**Errors:** `401` · `403 ACCESS_REVOKED` · `404` · `429`.

#### `Cache-Control: no-store` on every ciphertext response — the rule

Brief §10 requires it and §10.1 explains the mechanism: in v1 the proxying relay
sets the header directly, on every response carrying ciphertext — §11.2, §11.3,
and §9.5's metadata envelopes. Set by a shared response hook on the three routes,
not by each handler, so that a fourth ciphertext route added later inherits it by
registering in the same place rather than by remembering. It is one of the two
`no-store` rules in this document; §8.3's (every response carrying a _wrapped
blob_) is the other, and the two are stated separately because their subjects
differ — ciphertext of a photograph, ciphertext of a key — even though the
header is the same. Note what the header is not: a request clients and
intermediaries honour, not a confidentiality control (brief §10).

### 11.4 `GET /v1/recipient` — the caller's own row, and the watermark's input

**Decides §10.3's escalated gap. A route, not a payload field.**

```
GET /v1/recipient
```

Recipient scheme only. `200`:

```jsonc
{
  "id": "…",
  "album_id": "…",
  "label": "María",
  "kind": "qr",
  "created_at": "…",
}
```

- **`label` is what brief §5's watermark renders**, and this is the only place a
  recipient's client can get it. Plaintext on the relay (§5.3); whatever the
  owner typed (brief §15.1); returned verbatim.
- **Flat, no id, scoped by the token** — the same shape as §8.3 and §10.1, for
  the same reason: the caller's own row has nothing to enumerate.
- **Revoked → `403 ACCESS_REVOKED`.** The client's first call on opening an
  invite, so this is where a revoked recipient learns it — a `403` here renders
  "this album is no longer shared with you" before any grid is attempted.
- **Not `no-store`** — nothing here is ciphertext or a wrapping. Not logged —
  §11.6's events are about the album and its assets.
- **Errors:** `401` · `403 ACCESS_REVOKED` · `429`.

**Why the route and not `label` in the invite payload.** The payload option is
the one that expires — invite spec §6 makes adding a field a version increment,
so it is free today while no invite exists and `v: 2` forever after — which is
why the decision is made now rather than drifted past. It was still not taken,
for three reasons. **One source of truth**: a label in the payload is a second
copy outside the database, frozen at invite time, and the moment labels become
editable (a plausible Phase 2 nicety — a parent fixing a typo in a grandmother's
name) the QR on the fridge says the wrong thing forever. **The QR stays small**:
a label is free text in any script, and QR capacity at the error-correction level
a printed card needs is not generous. **The payload is the credential** (§7.7),
and it should carry what the credential needs and nothing that is merely
convenient — the checklist's own rule for §10.1, applied to the other artefact.
The cost is one round trip on album open, in parallel with §9.4 and §9.5 rather
than before them; on brief §10.1's mediocre connection that is a few hundred
milliseconds of a load that is fetch-dominated anyway.

### 11.5 Rate limiting — keyed on the token hash, not the address

Every authenticated route in the system sits behind one limiter, keyed on the
**hash of the presented bearer token** — `owner_tokens.token_hash` or
`recipients.token_hash`, whichever §7.3 step 1 resolved. Not on IP, because a
family behind one NAT shares an address and would share a budget, and because
mobile data changes a device's address mid-session and would reset one. The
three unauthenticated routes are the exception and are IP-keyed, for the reason
§7.6 gives: they have no token to key on.

| Limit                  | Value                                | Applies to                                 |
| ---------------------- | ------------------------------------ | ------------------------------------------ |
| Requests               | **300 per minute**, burst 60         | every authenticated route                  |
| Bytes                  | **500 MB per hour** of response body | §11.2, §11.3, §9.5 — the ciphertext routes |
| Unauthenticated routes | 10 per 15 minutes per IP             | §7.6                                       |

**Provisional, every number.** A hundred-photo album is roughly a hundred
thumbnails plus one metadata fetch on open and two to twelve chunk fetches per
photograph viewed; 300/min with a burst of 60 lets a grid load and a viewer flick
through without touching the limit, and 500 MB/hour is several full albums.
**Tune in Phase 2** against real traffic, not now against a guess — but a
limiter sized against a guess is better than none, since none is what an
abandoned client loop or a scraped invite gets today.

**`429 RATE_LIMITED` with `Retry-After`, in seconds; the client backs off
silently.** No user-facing sentence, no retry button — a recipient scrolling a
grid should never learn the limit exists. `Retry-After` is in
`Access-Control-Expose-Headers` (§3) or the client cannot read it.

**The limiter is in-process state.** Correct on one instance, silently broken on
two — each instance keeps its own counters and the effective limit doubles with
no error anywhere. §7.6 says the same of the IP limiter, and it is true of both
from the moment either exists. Recorded so nobody adds Redis to Phase 0 to fix a
problem it does not have, and nobody scales to two instances in Phase 2 without
noticing the property they lost.

**The `429` reaches the envelope.** `@fastify/rate-limit`'s default
`errorResponseBuilder` produces its own body and bypasses `setErrorHandler`,
which would make it a second error shape — §1's one-shape rule broken by a
dependency's default. The limiter must throw an `ApiError("RATE_LIMITED")`, or
build the envelope by the same function, and §6.2's row asserts it.

**The hash, never the token string**, as the key (schema §6's rule against
comparing token strings; §7.2). The limiter's map is keyed by the same 32 bytes
the lookup used, and never sees the base64url form.

### 11.6 The access log — two events, two routes, and the rules that make each honest

`access_log` (schema §3): `recipient_id NOT NULL`, `media_id` nullable, `event
IN ('album_opened','asset_viewed')`, `occurred_at`. **It records what recipients
do. Owner calls write nothing** — the table has no column for an owner, and an
owner looking at their own album is not the question "María viewed this" asks.
Both events are written when the response is committed (the `200` or `206`
begins), never on a `4xx`.

#### `album_opened` ← the encrypted-metadata route (§9.5), every fetch

A recipient's client cannot lay out a grid without the dimensions inside the
metadata envelopes, so it must fetch §9.5 on every album open — **structurally
once per open**, not by convention. Every fetch by a recipient writes one row,
`media_id` NULL.

#### The album-details route (§9.4) does not log — and the contrast is the design

§9.4 may be called for reasons that are not an open: a client re-validating an
id after a `404`, a status refresh, a retry after a lost response. Logging it
would count those as opens. §9.5 is the route whose fetch _is_ the open, so §9.5
logs and §9.4 does not. Split across two sections the second half reads as
arbitrary — "why does this route not log?" — which is why PR 3 defined both
routes and said nothing about logging, and this section says it for both.

#### `asset_viewed` ← a range starting at byte 0 on the asset route, and nothing else

The envelope header is always the first 64 bytes, and an open must fetch it —
so the request whose `Range` starts at `0` is the request that opens the
photograph. That request writes one row with `media_id` set; every later range
on the same asset (`bytes=262208-…`) writes nothing. **Structurally once per
open**, because a client that did not fetch the header cannot decrypt anything.

**Thumbnails never log.** Opening a grid fetches every thumbnail in the album;
logging them would record a view of every photograph on every open, which is the
plausible-looking wrong number brief §10.1 warns about.

**The rule is airtight only because §11.2 refuses range-less requests.**
Otherwise a bare `GET` on the asset route would return the whole object —
header included — and be an unlogged open. That is the connection between the
range table and the log, and it is the reason the RFC 9110 deviation in §11.2
must not be "fixed".

#### Never deduplicate on write

Two opens are two rows. `COUNT(DISTINCT media_id)` at read time gives "opened 12
photos"; `COUNT(*)` gives "opened this album 5 times"; the raw rows give "last
opened 6 Aug". **Written next to the rule because duplicate rows look like a bug
to someone optimising later**: deduplicating on write would cost a read per
request to save a row, and would destroy information — repeat visits, the
timing of each — that cannot be recovered once the row was not written. The
indexes in schema §4 are shaped for the read-side aggregation, not for the write
to check anything.

#### The client must not prefetch full assets

If a client fetched byte 0 of every asset when the grid loaded, retrieval would
stop approximating display and every recipient would appear to have opened every
photograph. **Thumbnails may be prefetched freely** — they do not log, and
prefetching them _is_ the grid. **Assets are fetched when displayed and not
before.** Recorded here rather than in a client document because adding
prefetching later must force a review of what the log means, and the person
adding it will be reading the route.

#### What the log measures, and the permitted copy

**The metric is opens, not intentional viewings.** A refresh is an open. A retry
after a dropped connection is an open. Back-navigation to a photograph is an open.
The number is honest about retrieval and says nothing about attention. Brief §3's
discipline — never claim more than the mechanism delivers — applies to this
feature exactly as it does to screenshots, so the permitted phrasing is written
down:

| Permitted                          | Not permitted                    |
| ---------------------------------- | -------------------------------- |
| "María opened this album 3 times"  | "María visited 3 times"          |
| "María has opened 12 of 20 photos" | "María has seen 12 of 20 photos" |
| "Last opened 6 Aug"                | "Last viewed", "last looked at"  |
| "Opened by María, Abuelo"          | "Viewed by …", "Seen by …"       |

_Open_ is the word, because it names the retrieval and not the person's
experience of it. Every translation of these strings is gated by brief §15.3 on a
fluent speaker confirming the same distinction survives — "abrió" not "vio".

#### The log is behavioural, not authorisational

Access is album-granular: a recipient with a valid token may fetch any `ready`
asset in the album at any time. **A sparse log is not evidence of restricted
access**, and no feature may present it as one — "María has only seen 3 photos"
is a statement about what María did, not about what María could do. Recorded
because the read-side aggregation makes the two easy to confuse in copy.

#### A failed log write does not fail the fetch

The log is a feature (brief §9), not a control. If the `INSERT` fails, the
`206` is still served and the failure is logged server-side at `error`. The
alternative — refusing ciphertext because a bookkeeping row could not be written
— makes the album unavailable in exactly the outage where nothing else is wrong.

### 11.7 Reading the log — `GET /v1/albums/{album_id}/access-log`

Owner scheme; §9.3's `{album_id}` scope. Two views, because the two questions the
indexes were built for (schema §4) are different shapes:

**`GET /v1/albums/{album_id}/access-log`** — per-recipient summary. `200`:

```jsonc
{
  "recipients": [
    {
      "recipient_id": "…",
      "label": "María",
      "revoked_at": null,
      "album_opens": 3,
      "media_opened": 12, // COUNT(DISTINCT media_id) over asset_viewed
      "last_opened_at": "…", // MAX(occurred_at), or null
    },
  ],
}
```

Every recipient of the album appears, including those with no rows (zeros and
`null`) and those revoked — a revoked recipient's history is precisely what §7.8
refused to cascade away. Ordered by `last_opened_at` descending, nulls last.

**`GET /v1/albums/{album_id}/access-log/entries`** — the rows, newest first,
paginated. Query: `?recipient_id=<uuid>` and `?media_id=<uuid>`, both optional,
both identifiers and not tokens (§7.2's query-string rule is about credentials);
`?limit=` default 100, maximum 500; `?before=<id>` the `access_log.id` cursor.
`200`:

```jsonc
{
  "entries": [
    {
      "id": 8812,
      "recipient_id": "…",
      "media_id": "…",
      "event": "asset_viewed",
      "occurred_at": "…",
    },
  ],
  "next_before": 8712, // null when exhausted
}
```

`access_log.id` is a `bigint` identity (schema §3) and is the cursor because it
is monotonic where `occurred_at` is not guaranteed unique. **Pagination is
required here and nowhere else in v1** — this is the one table whose size grows
with use rather than with content.

- **Errors, both:** `400 VALIDATION_FAILED` (bad query) · `401` · `404`.
- Neither writes the log — an owner reading it is not an event in it.

### 11.8 Every route, in one table

The document's single enumeration — §7.9 covers owner auth, §9.1 the owner flow,
§10.1 and §11 stand alone, and until now no one place listed them all. Twenty-two
routes plus `/health`.

| Route                                          | Scheme            | PR  | Defined | Logs                                                 | `no-store`       |
| ---------------------------------------------- | ----------------- | --- | ------- | ---------------------------------------------------- | ---------------- |
| `GET /health`                                  | none              | 1   | §2      | —                                                    | —                |
| `POST /v1/signup`                              | none · IP-limited | 2b  | §7.5    | —                                                    | yes              |
| `POST /v1/login/params`                        | none · IP-limited | 2b  | §7.5    | —                                                    | yes              |
| `POST /v1/login`                               | none · IP-limited | 2   | §7.5    | —                                                    | yes              |
| `POST /v1/logout`                              | owner             | 2   | §7.5    | —                                                    | —                |
| `POST /v1/logout/all`                          | owner             | 2   | §7.5    | —                                                    | —                |
| `GET /v1/owner/key`                            | owner             | 2b  | §8.3    | —                                                    | yes (wrapping)   |
| `POST /v1/albums`                              | owner             | 3   | §9.2    | —                                                    | —                |
| `GET /v1/albums`                               | owner             | 3   | §9.2    | —                                                    | yes (wrappings)  |
| `GET /v1/albums/{album_id}`                    | owner · recipient | 3   | §9.4    | **no** (§11.6)                                       | —                |
| `GET /v1/albums/{album_id}/metadata`           | owner · recipient | 3   | §9.5    | **`album_opened`**, recipients (§11.6)               | yes (ciphertext) |
| `POST /v1/albums/{album_id}/media`             | owner             | 3   | §9.6    | —                                                    | —                |
| `GET /v1/media/{media_id}`                     | owner             | 3   | §9.8    | —                                                    | —                |
| `PUT /v1/media/{media_id}/asset`               | owner             | 3   | §9.7    | —                                                    | —                |
| `PUT /v1/media/{media_id}/thumbnail`           | owner             | 3   | §9.7    | —                                                    | —                |
| `POST /v1/albums/{album_id}/recipients`        | owner             | 2   | §7.7    | —                                                    | —                |
| `POST /v1/recipients/{recipient_id}/revoke`    | owner             | 2   | §7.8    | —                                                    | —                |
| `GET /v1/recipient`                            | recipient         | 5   | §11.4   | —                                                    | —                |
| `GET /v1/recipient/key`                        | recipient         | 4   | §10.1   | open (§10.5)                                         | yes (wrapping)   |
| `GET /v1/media/{media_id}/asset`               | owner · recipient | 5   | §11.2   | **`asset_viewed`**, recipients, range from 0 (§11.6) | yes (ciphertext) |
| `GET /v1/media/{media_id}/thumbnail`           | owner · recipient | 5   | §11.3   | **never**                                            | yes (ciphertext) |
| `GET /v1/albums/{album_id}/access-log`         | owner             | 5   | §11.7   | —                                                    | —                |
| `GET /v1/albums/{album_id}/access-log/entries` | owner             | 5   | §11.7   | —                                                    | —                |

Every authenticated row is behind §11.5's token-hash limiter; the three
`none` rows are behind §7.6's IP limiter; `/health` is behind neither. Methods
in use: `GET`, `POST`, `PUT` (§3). Three routes accept a wrapping (§4.1's inbound
walk: §7.5, §7.7, §9.2); three return one (§4.1's outbound walk: §8.3, §9.2,
§10.1). Four are shared between schemes — §9.4, §9.5, §11.2, §11.3 — and each
resolves to exactly one `Caller` (§7.1).

### 11.9 What this section changes elsewhere

- **§1.1 gains `RANGE_NOT_SATISFIABLE`/416**, handler-mapped from the store's
  `InvalidRange` on §11.2. Not a framework code.
- **§10.3's escalation is closed** by §11.4.
- **§9.4 and §9.5 have their logging stated** — the two forward references PR 3
  left open.
- **§6.2 gains the rows tagged PR 5.**

### 11.10 What PR 5 deliberately does not decide

- **The limiter's numbers** — provisional, Phase 2 tunes them.
- **Multi-instance rate limiting** — the in-process limiter is correct for one
  instance; the day there are two is the day this is a decision.
- **Signed URLs** — Phase 3, video, additive (§11.1).
- **`access_log` retention** — a Phase 2 GDPR item (schema §3); the read routes
  in §11.7 will need a floor date when it exists.
- **Whether a key fetch logs** — §10.5, unchanged.
- **Padding ciphertext to size buckets** — encryption spec §10's accepted
  limitation; `Content-Length` on §11.2 and §11.3 reveals object size, as the
  store would.

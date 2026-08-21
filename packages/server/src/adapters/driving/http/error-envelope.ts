/*
 * The one error shape, and the single choke point that produces it.
 *
 * vitrina-server-architecture.md §8 keeps this in one module so no route can hand-roll an
 * error. Two rules from the brief are enforced structurally here rather than by
 * anyone remembering them:
 *
 *   - Non-negotiable #15 (brief §6): "No error response ever echoes request
 *     content." A validation error that helpfully returns the offending value is
 *     how key material reaches a response body and then a log.
 *   - Brief §15.1: the API is locale-agnostic. `message` is developer-facing
 *     English; the client maps `code` to Spanish/Catalan. User-facing sentences
 *     never appear here.
 *
 * The mechanism for #15 is that `message` is looked up from `code` and is never
 * taken from the thrown exception. An interpolated string cannot reach the wire
 * even if someone writes one, because there is no path from an Error's own
 * message to the response body.
 */

import type {
  FastifyError,
  FastifyReply,
  FastifyRequest,
  FastifySchemaValidationError,
} from "fastify";
import type { ErrorCode, ErrorBody, ErrorDetails } from "@vitrina/shared";

/*
 * code → HTTP status.
 *
 * `ErrorCode` is imported rather than declared here: api-sketch §1.4 and
 * architecture §4 decision 5 put it in `@vitrina/shared`, because it is a wire
 * contract before it is an internal type — §1.3 has the client mapping `code` to
 * Spanish or Catalan, which it cannot do against a union it cannot import.
 *
 * `satisfies Record<ErrorCode, number>` rather than an annotation, so this table
 * is checked to be TOTAL over that union and still keyed by literals. That is
 * what removes the `?? 400` fallback: an unregistered code is a compile error at
 * the throw site, not a response that quietly carries the wrong status. A code
 * added to the union without an entry here — or here without a MESSAGES entry —
 * also fails to compile, in `pnpm build` on both packages.
 */

const STATUS = {
  VALIDATION_FAILED: 400,
  UNAUTHENTICATED: 401,
  INVALID_CREDENTIALS: 401,
  ACCESS_REVOKED: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  PAYLOAD_TOO_LARGE: 413,
  UNSUPPORTED_MEDIA_TYPE: 415,
  RATE_LIMITED: 429,
  INTERNAL: 500,
} as const satisfies Record<ErrorCode, number>;

/*
 * Static, developer-facing English. Every string here is a constant: no
 * interpolation, no request data, no exception text. Adding a code to STATUS
 * without adding it here does not compile.
 */
const MESSAGES = {
  VALIDATION_FAILED: "Request failed schema validation.",
  UNAUTHENTICATED: "Missing, unknown or expired token.",
  INVALID_CREDENTIALS: "Invalid credentials for logging in.",
  ACCESS_REVOKED: "Recipient access has been revoked.",
  NOT_FOUND: "Not found.",
  CONFLICT: "Conflict, duplicated value.",
  PAYLOAD_TOO_LARGE: "Body limit of the request exceeded.",
  UNSUPPORTED_MEDIA_TYPE: "Content type not supported.",
  RATE_LIMITED: "Rate limited.",
  INTERNAL: "An unexpected error occurred.",
} as const satisfies Record<ErrorCode, string>;

/*
 * status → code: api-sketch §1.2's hand-written inverse of the table above,
 * needed because `code → status` is a function and not a bijection.
 *
 * A 4xx arriving with no mapping falls to INTERNAL, which is wrong and is meant
 * to be: it is the signal that the union is short a code. Do not add a
 * fallback — that is the `?? 400` §1.1 removed, in a new place.
 *
 * The reply status is always `STATUS[code]` and never the number keyed here, so
 * a wrong row produces a self-consistent response to the wrong condition rather
 * than a status and a code that disagree.
 */
const FRAMEWORK_4XX: Readonly<Record<number, ErrorCode>> = {
  400: "VALIDATION_FAILED", // FST_ERR_CTP_{INVALID,EMPTY}_JSON_BODY
  401: "UNAUTHENTICATED", // never INVALID_CREDENTIALS — §1.2
  413: "PAYLOAD_TOO_LARGE", // FST_ERR_CTP_BODY_TOO_LARGE
  415: "UNSUPPORTED_MEDIA_TYPE", // FST_ERR_CTP_INVALID_MEDIA_TYPE
  /*
   * PROVISION FOR §7.6, not something the framework emits. Fastify core raises
   * no 429; only a limiter does, and none is installed. It is registered ahead
   * of use on §1.1's rule — "a code registered late is a 500 in the meantime" —
   * and it is the one row the framework-4xx test cannot reach, so it stays
   * unasserted until that route exists.
   *
   * Verify then rather than assume now: a limiter that builds its own reply, as
   * @fastify/rate-limit does via errorResponseBuilder, never reaches this
   * handler, and this row would be inert while looking live.
   */
  429: "RATE_LIMITED",
};

/**
 * Codes that may be thrown. `INTERNAL` is deliberately not one of them.
 *
 * api-sketch §1.2 stated this as prose — "do not throw INTERNAL as an ApiError,
 * let an unrecognised error fall through to the branch that logs a stack" — and
 * prose is the wrong home for it: the reason the rule exists is that
 * `new ApiError("INTERNAL")` with no cause answers 500 and logs NOTHING, which is
 * the one case where the cause-based logging rule below is silently wrong.
 *
 * Excluding it here makes that a compile error instead. Verified safe before
 * narrowing: nothing in `src/` constructs an `ApiError` with `INTERNAL`, and the
 * `500` envelope is built by `body("INTERNAL")` at the bottom of `errorEnvelope`
 * rather than by throwing — so the handler's own path is unaffected.
 *
 * To signal a 500, throw anything else — a plain `Error` reaches the unrecognised
 * branch, which logs a stack. That is the diagnostic an `INTERNAL` needs and the
 * one an `ApiError` cannot carry.
 */
type ThrowableCode = Exclude<ErrorCode, "INTERNAL">;

/**
 * The throwable. Carries a `code` and nothing that can leak.
 *
 * `details` is for machine-readable, non-echoing context the client needs in
 * order to act — field *names*, never field *values*. `ErrorDetails` is
 * `{fields: string[]}` for exactly that reason: a list of names has nowhere to
 * put a submitted value, so #15 is enforced by the type rather than by whoever
 * writes the throw. See its declaration in `@vitrina/shared`.
 *
 * `cause` is for chaining an underlying error. It never reaches the wire, and
 * it is what decides whether this error is logged at all (see errorEnvelope).
 *
 * CHAIN A MESSAGE YOU WROTE, NOT A DRIVER ERROR VERBATIM. This is a #15 guard,
 * not a style note, and it is the one rule `cause` needs. #15 stops request
 * content reaching a *response*; nothing stops it reaching a *log*, and a
 * driver's own message is the likeliest carrier. Postgres spells a unique
 * violation:
 *
 *     duplicate key value violates unique constraint "owners_email_key"
 *     Key (email)=(someone@example.com) already exists.
 *
 * — a submitted value, quoted by the driver, and `cause: pgError` puts it in
 * the log with no throw site having interpolated anything. So wrap it:
 *
 *     new ApiError("CONFLICT", {
 *       cause: new Error(`owners.email already taken (pg ${pgError.code})`),
 *     })
 *
 * THE LEAK IS BIGGER THAN THE MESSAGE, and this is the part worth knowing.
 * `errWithCause` copies the cause's **enumerable own properties** into the log
 * line, and a node-postgres error carries `code`, `detail`, `table` and `schema`
 * as exactly that. Postgres puts the submitted value in `detail`, not in
 * `message`:
 *
 *     message: 'duplicate key value violates unique constraint "owners_email_key"'
 *     detail:  'Key (email)=(victim@example.com) already exists.'
 *
 * Measured 21 August 2026: `cause: pgError` puts `detail` — and the address — in
 * the log under `errWithCause`, and does NOT under pino's default `err`, which
 * flattens a cause to message and stack only. So adopting `errWithCause` widened
 * this exposure rather than merely relocating it, and this rule is what closes
 * it. api-sketch §1.2 records the correction.
 *
 * The driver's `code` — "23505" — and its constraint name are both safe to name:
 * they describe the schema, not the request. Put them **in the message you
 * write**, not in a nested `cause`:
 *
 *     cause: new Error(`… (pg ${pgError.code})`)   // reaches the log
 *     cause: pgError.code                          // vanishes — see below
 *
 * A bare string cause vanishes *from this class specifically*, and the reason is
 * enumerability rather than type. `Error(msg, {cause})` defines `cause`
 * NON-enumerably, so neither serialiser picks up a non-Error value; `e.cause =
 * "23505"` defines it enumerably and both serialisers keep it. An Error cause is
 * walked either way, because both serialisers read `.cause` directly when it is
 * one. This class uses the constructor form below — so for an `ApiError`, a
 * string cause is silently dropped. **If that `super(...)` is ever changed to an
 * assignment, this paragraph inverts**, and a `cause: pgError.code` starts
 * reaching logs.
 *
 * This is throw-site discipline for the same reason §7.5 assigns the INTERNAL
 * path's residual risk to the throw site: the handler cannot inspect a chained
 * value and know whether it was submitted or authored.
 */
export class ApiError extends Error {
  readonly code: ThrowableCode;
  readonly details: ErrorDetails | undefined;

  constructor(
    code: ThrowableCode,
    options?: {
      details?: ErrorDetails;
      cause?: unknown;
    },
  ) {
    // Error.message mirrors the wire message so log lines read correctly.
    super(
      MESSAGES[code],
      options?.cause ? { cause: options.cause } : undefined,
    );
    this.name = "ApiError";
    this.code = code;
    this.details = options?.details;
  }
}

/**
 * What a validation failure is allowed to contribute to a log line.
 *
 * A path into a schema we wrote, the name of a rule we wrote, and — for
 * `required` only — the name of the field the schema declares. Nothing here can
 * hold a submitted value, whatever AJV is configured to emit.
 */
type ValidationLogEntry = {
  readonly instancePath: string;
  readonly keyword: string;
  readonly schemaPath: string;
  readonly missingProperty?: string;
};

/**
 * The value-free projection of `error.validation`, for the log.
 *
 * A WHITELIST, NOT A FILTER, and that is the whole point. These fields are safe
 * by *what they are*: schema-side names, authored here. Everything else on an
 * AJV error is safe only by what AJV currently chooses to emit, and every way
 * that changes is one line of configuration no test would catch:
 *
 *   - `verbose: true` attaches the submitted value to every error as `data`.
 *   - a custom keyword may put anything into `params`.
 *   - a changed message template, or a dependency bump, can put the value back
 *     into `message`.
 *
 * None of those goes red in CI. The log simply starts containing passphrases,
 * and it is an incident rather than a test that says so — the same shape as the
 * forgotten `no-store` header and the `?? 400` fallback: works, plausible,
 * wrong. Building the payload here rather than filtering the error means a
 * field added upstream is absent by default instead of present by default.
 *
 * `params` is excluded even though api-sketch §1.2 verifies it carries
 * schema-side values only today (`{format: "email"}`, `{allowedValues: [...]}`).
 * It echoes the schema, not the request, so it is safe now — and it adds nothing
 * `keyword` and `schemaPath` do not already give. Keeping it would mean
 * re-auditing this projection every time someone writes a custom keyword.
 *
 * ONE EXCEPTION — `params.missingProperty`. For a `required` failure AJV puts
 * the field name only there and in `message`: `instancePath` is the parent
 * object, usually `""`, and `schemaPath` is `#/required`. Without it a
 * missing-field failure logs nothing that identifies the field, which is worse
 * than the cost §1.2 accepts — that section trades an English sentence for a
 * field path, and here there would be no field path either. The name is
 * declared by our own schema, the same safety class as `instancePath`.
 *
 * Gated on `keyword === "required"` rather than on the key being present,
 * because `required` is an AJV builtin that cannot be redefined — so a custom
 * keyword cannot route anything through this branch — and on `typeof === "string"`,
 * so a non-string under that key is dropped rather than serialised.
 *
 * THE WHITELIST IS KEYWORD-SPECIFIC, NOT CATEGORY-SPECIFIC, AND THAT IS THE
 * WHOLE OF ITS SAFETY. It is not "params is fine for builtin keywords", and
 * generalising it to that — the obvious tidy-up, one condition shorter — leaks.
 *
 * `additionalProperties` is the counter-example, and it is one keyword over. Its
 * `params` carries `additionalProperty`: the same shape as `missingProperty`, a
 * bare string under `params`, on a builtin keyword — but the name in it is
 * CLIENT-CHOSEN, not schema-declared. A client that POSTs `{"S3CRET": 1}` puts
 * its own string there, and any rule phrased per-category hands it to the log.
 *
 * It cannot fire today: api-sketch §1.2 records that Fastify's default
 * `removeAdditional: true` strips an unexpected key rather than erroring, so no
 * client-chosen key name reaches an error object at all. That is the same kind
 * of guarantee as `verbose: true` being off — a default, one line from changing,
 * which is exactly why the gate is written per keyword instead of per category.
 * Adding a keyword here means arguing that keyword's `params` names something we
 * wrote, one keyword at a time.
 *
 * DEVIATION, owed to the document: §1.2 and §7.5 both say "never `params`".
 * Decided 20 August 2026 to allow this one key; both sections need the exception
 * recorded, or the code contradicts the spec.
 */
function projectValidation(
  validation: readonly FastifySchemaValidationError[],
): ValidationLogEntry[] {
  return validation.map((entry) => {
    const projected = {
      instancePath: entry.instancePath,
      keyword: entry.keyword,
      schemaPath: entry.schemaPath,
    };

    const missing =
      entry.keyword === "required" ? entry.params["missingProperty"] : undefined;

    // Conditional rather than `missingProperty: undefined`, for the reason
    // `body` below is conditional: exactOptionalPropertyTypes distinguishes an
    // absent key from an undefined one, and so does the serialised log line.
    return typeof missing === "string"
      ? { ...projected, missingProperty: missing }
      : projected;
  });
}

function body(code: ErrorCode, details?: ApiError["details"]): ErrorBody {
  // Built conditionally rather than with `details: undefined`, because
  // exactOptionalPropertyTypes distinguishes an absent key from an undefined
  // one — and so does the JSON on the wire.
  return details
    ? { code, message: MESSAGES[code], details }
    : { code, message: MESSAGES[code] };
}

export function errorEnvelope(
  error: FastifyError,
  request: FastifyRequest,
  reply: FastifyReply,
) {
  if (error instanceof ApiError) {
    /*
     * Logged when it carries a cause, silent when it does not — api-sketch
     * §1.2, decided 21 August 2026. A 404 with nothing underneath it is not an
     * event: the route answered the question it was asked, and a line per
     * missing album is noise that trains people to stop reading the log. A
     * cause is the signal that something happened the server had to interpret —
     * a unique violation behind a CONFLICT, a storage failure behind a
     * NOT_FOUND — and that is worth a line.
     *
     * `warn` and not `error`, matching the framework branch below: an ApiError
     * is a condition this server recognised and answered correctly. `error` is
     * reserved for the branch where it did not.
     *
     * `{err: error}` is safe to hand over because `ApiError`'s own message is
     * `MESSAGES[code]`, a constant. Everything in the chain below it is the
     * throw site's responsibility — see the note on `cause` above, which is the
     * whole of what keeps a driver's quoted request value out of this line.
     *
     * THE ONE CASE A CAUSE-BASED RULE CANNOT COVER is now unreachable rather
     * than merely discouraged: `new ApiError("INTERNAL")` with no cause would
     * answer 500 and log nothing, and `ThrowableCode` excludes `INTERNAL` so it
     * does not compile. Widening the condition here — "or status >= 500" —
     * would have been the handler doing a throw site's job; excluding the code
     * removes the case instead. See `ThrowableCode` above.
     */
    if (error.cause !== undefined) {
      request.log.warn({ err: error }, "request failed with an underlying cause");
    }
    return reply.code(STATUS[error.code]).send(body(error.code, error.details));
  }

  if (error.validation) {
    /*
     * Both directions are by construction, and neither depends on what AJV
     * emits.
     *
     * OUTWARD: Fastify's message names the offending field and the rule —
     * "body/email must match format \"email\"". §1.2 verifies it does not quote
     * the value, and that is exactly why it is dropped anyway: `verbose: true`
     * is one line away from putting the value in it, so the whole error is
     * replaced by the constant `VALIDATION_FAILED` rather than trusted.
     *
     * INWARD: a payload we build, never the error object. `{err: error}` handed
     * pino whatever AJV had attached; this hands it three named fields. See
     * projectValidation for why `params` is excluded and `missingProperty` is
     * the one exception.
     */
    request.log.warn(
      { validation: projectValidation(error.validation) },
      "schema validation failed",
    );
    return reply.code(STATUS.VALIDATION_FAILED).send(body("VALIDATION_FAILED"));
  }

  const framework =
    error.statusCode === undefined
      ? undefined
      : FRAMEWORK_4XX[error.statusCode];

  if (framework) {
    /*
     * The client's fault, not the server's: warn, not error. Fastify's code goes
     * to the log, where knowing *which* CTP error fired is what makes a client
     * bug diagnosable — and the wire stays constant.
     *
     * `{err: error}` and not a projection, unlike the branch above, because a
     * CTP error is *about* a content type or a byte count rather than about a
     * submitted value: there is nothing request-shaped in it to project away.
     * Where that stops holding is a plugin-raised 4xx whose message quotes the
     * request — the reason the 429 row is marked as unasserted provision.
     */
    request.log.warn({ err: error }, "framework rejected request");
    return reply.code(STATUS[framework]).send(body(framework));
  }

  /*
   * Anything unrecognised is opaque outward and COMPLETE INWARD, and the whole
   * error object is deliberate here.
   *
   * api-sketch §1.2 binds the projection to the validation path only: "an
   * unrecognised error is logged whole because a stack is the entire diagnostic
   * value" of one. Applying projectValidation here — the consistent-looking
   * tidy-up — would trade a leak that was measured for blind 500s, and there is
   * nothing to project from anyway: an unrecognised error has no `validation`.
   *
   * The residual risk is a throw site that interpolated a request value into a
   * message, which §7.5 assigns to the throw site rather than to this handler,
   * and which is why that row scopes its test to the validation and success
   * paths and not to this one.
   */
  request.log.error(error);
  return reply.code(500).send(body("INTERNAL"));
}

/**
 * Fastify routes route-not-found through setNotFoundHandler, not
 * setErrorHandler, so without this an unknown path returns Fastify's default
 * body — `{"message":"Route GET:/foo not found",...}` — which both echoes the
 * request (#15) and is a second error shape.
 *
 * B.6 may want to distinguish "no such route" from "album genuinely absent",
 * which track-b-plan §3 assigns 404. Both are NOT_FOUND here; splitting them is
 * a code-taxonomy decision, not this module's to make.
 */
export function notFoundEnvelope(
  _request: FastifyRequest,
  reply: FastifyReply,
) {
  return reply.code(STATUS.NOT_FOUND).send(body("NOT_FOUND"));
}

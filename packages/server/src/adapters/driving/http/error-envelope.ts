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
import type { ErrorCode, ErrorBody } from "@vitrina/shared";

/*
 * code → HTTP status. `satisfies` rather than an annotation, so that
 * `ErrorCode` below is the union of these exact keys instead of `string`.
 *
 * That is what removes the `?? 400` fallback: an unregistered code is now a
 * compile error at the throw site, not a response that quietly carries the
 * wrong status. A code added here without a MESSAGES entry also fails to
 * compile.
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

// A 4xx arriving with no mapping falls to INTERNAL, which is wrong and is meant to be.
const FRAMEWORK_4XX: Readonly<Record<number, ErrorCode>> = {
  400: "VALIDATION_FAILED", // FST_ERR_CTP_{INVALID,EMPTY}_JSON_BODY
  401: "UNAUTHENTICATED", // never INVALID_CREDENTIALS — §1.2
  413: "PAYLOAD_TOO_LARGE", // FST_ERR_CTP_BODY_TOO_LARGE
  415: "UNSUPPORTED_MEDIA_TYPE", // FST_ERR_CTP_INVALID_MEDIA_TYPE
  429: "RATE_LIMITED", // It may be inert. 429 won't come from Fastify core; it comes from the limiter
};

/**
 * The throwable. Carries a `code` and nothing that can leak.
 *
 * `details` is for machine-readable, non-echoing context the client needs in
 * order to act — a field *name*, never a field *value*. If you are tempted to
 * put the offending input in here, that is exactly non-negotiable #15.
 *
 * `cause` is for chaining an underlying error. It is logged and never
 * serialised.
 */
export class ApiError extends Error {
  readonly code: ErrorCode;
  readonly details: Readonly<Record<string, string>> | undefined;

  constructor(
    code: ErrorCode,
    options?: {
      details?: Readonly<Record<string, string>>;
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
    // The client's fault, not the server's: warn, not error. Fastify's code goes
    // to the log, where knowing *which* CTP error fired is what makes a client
    // bug diagnosable — and the wire stays constant.
    request.log.warn({ err: error }, "framework rejected request");
    return reply.code(STATUS[framework]).send(body(framework));
  }

  // Anything unrecognised is opaque outward and complete inward.
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

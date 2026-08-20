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

import type { FastifyError, FastifyReply, FastifyRequest } from "fastify";

/*
 * code → HTTP status. `satisfies` rather than an annotation, so that
 * `ErrorCode` below is the union of these exact keys instead of `string`.
 *
 * That is what removes the `?? 400` fallback: an unregistered code is now a
 * compile error at the throw site, not a response that quietly carries the
 * wrong status. A code added here without a MESSAGES entry also fails to
 * compile.
 */

export type ErrorCode =
  | "VALIDATION_FAILED"
  | "UNAUTHENTICATED"
  | "INVALID_CREDENTIALS"
  | "ACCESS_REVOKED"
  | "NOT_FOUND"
  | "CONFLICT"
  | "PAYLOAD_TOO_LARGE"
  | "UNSUPPORTED_MEDIA_TYPE"
  | "RATE_LIMITED"
  | "INTERNAL";

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

/** The wire shape. One envelope, every error, no exceptions. */
export type ErrorBody = {
  code: ErrorCode;
  message: string;
  details?: Readonly<Record<string, string>>;
};

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
     * Fastify's own validation message names the offending field *and quotes
     * its value* — "body/key must be string". That is #15, so the whole of
     * Fastify's error is dropped and replaced with a constant. The detail goes
     * to the log instead, where it is useful and not on the wire.
     */
    request.log.warn({ err: error }, "schema validation failed");
    return reply.code(400).send(body("VALIDATION_FAILED"));
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

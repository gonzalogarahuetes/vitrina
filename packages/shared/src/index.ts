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

/**
 * Optional machine-readable context — api-sketch §1.1, decided 21 August 2026.
 *
 * FIELD NAMES ONLY. The shape is what enforces that: `Record<string, string>`
 * held a name in the key and a *value* in the value, which is the one thing
 * non-negotiable #15 forbids, and `details: { field: "kind" }` versus
 * `details: { kind: "<what they sent>" }` are indistinguishable to a type. A
 * list of names cannot express the second, so a throw site that wants to echo a
 * value has nowhere to put it.
 *
 * A name is safe because the schema declared it — the same safety class as
 * `instancePath` in §1.2's log projection, and the same reasoning: we wrote it,
 * the client did not.
 *
 * `fields` is the only member and stays the only member. If a future code needs
 * context that is genuinely not a field name, it gets a sibling key with its own
 * #15 argument, not a widening of this one.
 */
export type ErrorDetails = {
  readonly fields: readonly string[];
};

/** The wire shape. One envelope, every error, no exceptions. */
export type ErrorBody = {
  code: ErrorCode;
  message: string;
  details?: ErrorDetails;
};

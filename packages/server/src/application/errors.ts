/*
 * What a use case throws. `application/` may not import the HTTP adapter
 * (architecture §6), so it cannot throw `ApiError` — these carry a code the
 * adapter maps to one, through a table that is total over the union below and
 * therefore fails to compile if a code is added without a mapping. Same move as
 * `STATUS` and `MESSAGES` in error-envelope.ts, one layer in.
 */

/**
 * Closed, and deliberately small. Add a member only with a mapping to an
 * `ErrorCode`, and only for a condition a use case can actually decide.
 */
export type ApplicationErrorCode =
  /** The address is empty after normalisation — §8.2, all three credential routes. */
  | "EMPTY_ADDRESS"
  /** Wrong proof or unknown address, indistinguishably — §4.3, §7.5. */
  | "INVALID_CREDENTIALS"
  /** The normalised address is registered. From the `UNIQUE`, never a prior `SELECT`. */
  | "DUPLICATE_ADDRESS";

/**
 * `message` is the code itself: a constant, never interpolated with request
 * content, so chaining one as a `cause` cannot carry a submitted value into a
 * log line (#15, and error-envelope.ts's note on `cause`).
 */
export class ApplicationError extends Error {
  readonly code: ApplicationErrorCode;

  constructor(code: ApplicationErrorCode, options?: { cause?: unknown }) {
    super(code, options);
    this.name = "ApplicationError";
    this.code = code;
  }
}

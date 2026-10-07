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
  | "DUPLICATE_ADDRESS"
  /** §9.2's `409`, meaning "already created" — a new id orphans the wrapping. */
  | "DUPLICATE_ALBUM_ID"
  /** §9.6's, meaning the same — a new id orphans the metadata envelope. */
  | "DUPLICATE_MEDIA_ID"
  /**
   * §9.3's `404`: the album is absent OR is not the caller's, indistinguishably.
   * One code for both, because a `403` would confirm the album exists — brief
   * §9.1's easiest way to leak album access.
   */
  | "ALBUM_NOT_FOUND"
  /** The same rule one level down — §9.3 resolves a media id through its album. */
  | "MEDIA_NOT_FOUND"
  /**
   * §9.7's `409`: the row is already `ready`, so an upload would replace an
   * object a recipient may be mid-fetch on. NOT a duplicate id — the other
   * three `CONFLICT` codes are, and this one is why the wire message cannot
   * say "duplicated value".
   */
  | "MEDIA_ALREADY_READY"
  /**
   * §7.3 step 4: a recipient whose grant is revoked, asking for THEIR OWN
   * album. Reachable only after step 3 has put the album in scope — probing
   * any other album is `ALBUM_NOT_FOUND`, identically to an unrevoked one.
   * Also §10.1's `403`: a revoked passphrase recipient fetching their own
   * wrapping. Named for the album because the grant IS one album.
   */
  | "ALBUM_ACCESS_REVOKED"
  /**
   * §7.7's `409`: the primary key OR `token_hash` collided — ONE code for
   * both, unlike the album and media ids. Naming the column is an oracle for
   * "is this hash in use"; the client's remedy is the same either way.
   */
  | "DUPLICATE_RECIPIENT"
  /**
   * §7.8's `404`: absent or not the caller's, indistinguishably — as albums.
   * Also §10.1's: the caller's own row has no wrapping (a qr recipient), so
   * the resource does not exist.
   */
  | "RECIPIENT_NOT_FOUND";

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

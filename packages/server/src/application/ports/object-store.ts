/*
 * Ciphertext in the bucket — api-sketch §9.7, §11.2, brief §10.1.
 * One object per asset and one per thumbnail; the relay is format-blind (§9.1),
 * so nothing here parses an envelope or knows about chunks.
 */

/*
 * FIRST PLATFORM TYPE IN A PORT, deliberately: Fastify hands the upload route
 * a `Readable` and the SDK takes one, so a web stream buys conversions at both
 * ends. The next platform type in a port is a decision, not a precedent.
 */
import type { Readable } from "node:stream";

/**
 * Opaque, and derived by `domain/media/object-key.ts` — §4.2's erasure worker
 * must enumerate the same strings. Carries no filename (CLAUDE.md), which is
 * also what makes a key safe to log.
 */
export type ObjectKey = string;

/**
 * Closed. Every rejection from this port is a `StorageError`, so `application/`
 * never sees an SDK type. `NOT_FOUND` and `INVALID_RANGE` are `get`'s (§11.2).
 */
export type StorageErrorCode = "NOT_FOUND" | "INVALID_RANGE" | "UNAVAILABLE";

/**
 * `message` is the code, a constant, as `ApplicationError`'s is (#15). The
 * adapter must chain a message it wrote: `errWithCause` copies a cause's
 * enumerable own properties, and an SDK error carries `$metadata`.
 */
export class StorageError extends Error {
  readonly code: StorageErrorCode;
  /**
   * Set with `INVALID_RANGE` and no other code: the size §11.2's 416 puts in
   * its `Content-Range`. Absent on other codes does not mean "size unknown".
   */
  readonly objectSize?: number;

  constructor(
    code: StorageErrorCode,
    options?: { cause?: unknown; objectSize?: number },
  ) {
    super(code, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = "StorageError";
    this.code = code;
    if (options?.objectSize !== undefined) this.objectSize = options.objectSize;
  }
}

/** Inclusive, already normalised by the caller to `bytes=X-Y` or `bytes=X-`. */
export type ByteRange = { readonly start: number; readonly end?: number };

/** The store's answer to a range, as values; the route renders the header. */
export type ContentRange = {
  readonly start: number;
  readonly end: number;
  readonly size: number;
};

/**
 * No slot for `ETag`, `Last-Modified` or `x-amz-*`: §11.2's forwarding
 * whitelist is this type. `contentRange` is present exactly when a range was.
 */
export type ObjectBody = {
  readonly body: Readable;
  readonly contentLength: number;
  readonly contentRange?: ContentRange;
};

export type StoredObject = {
  /** The store's `Content-Length` — what §9.7 compares its own count to. */
  readonly length: number;
};

export interface ObjectStore {
  /**
   * `length` is HTTP framing, not a client claim (§9.7 requires it, 411).
   * Reports no byte count: that is the use case's evidence, and it still holds
   * the number when this rejects. Any rejection means the object did not land.
   *
   * The length is also what lets the adapter stream: an S3 client handed a
   * Node stream without one buffers the whole body to discover the size.
   *
   * `PUT` replaces, because §9.7 permits re-upload in `pending`, `processing`
   * and `failed` — the second attempt is the client's latest, not a conflict.
   */
  put(key: ObjectKey, body: Readable, length: number): Promise<void>;

  /**
   * The confirming `HEAD` — §9.7. `null` for absent, THROWS for unreachable:
   * a not-found cannot distinguish "failed to land" from "not yet published",
   * so absence stays `processing` and a network blip cannot mark a row `failed`.
   *
   * THE ADAPTER MUST DECIDE THAT ON THE STATUS CODE, not the error's name. A
   * `HEAD` has no response body, so an S3 client cannot read an error code
   * from one and synthesises its own — which is a detail of whichever client
   * and store are in use, and SeaweedFS is not AWS. Verify it against the real
   * store; `infra/object-store-adapter.test.mjs` is where.
   */
  head(key: ObjectKey): Promise<StoredObject | null>;

  /**
   * §11.2, §11.3. Absent THROWS `NOT_FOUND`, unlike `head`: on a `ready` row it
   * is a broken invariant, not a state. 416 → `INVALID_RANGE` with
   * `objectSize`; decide both on the status code, as `head` does.
   */
  get(key: ObjectKey, range?: ByteRange): Promise<ObjectBody>;
}

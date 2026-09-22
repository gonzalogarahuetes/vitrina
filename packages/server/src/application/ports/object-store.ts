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
 * never sees an SDK type. `NOT_FOUND` and `INVALID_RANGE` are PR 5's (§11.2),
 * registered ahead of use on §1.1's rule and unthrown here.
 */
export type StorageErrorCode = "NOT_FOUND" | "INVALID_RANGE" | "UNAVAILABLE";

/**
 * `message` is the code, a constant, as `ApplicationError`'s is (#15). The
 * adapter must chain a message it wrote: `errWithCause` copies a cause's
 * enumerable own properties, and an SDK error carries `$metadata`.
 */
export class StorageError extends Error {
  readonly code: StorageErrorCode;

  constructor(code: StorageErrorCode, options?: { cause?: unknown }) {
    super(code, options);
    this.name = "StorageError";
    this.code = code;
  }
}

export type StoredObject = {
  /** The store's `Content-Length` — what §9.7 compares its own count to. */
  readonly length: number;
};

export interface ObjectStore {
  /**
   * `length` is HTTP framing, not a client claim (§9.7 requires it, §411).
   * Reports no byte count: that is the use case's evidence, and it still holds
   * the number when this rejects. Any rejection means the object did not land.
   */
  put(key: ObjectKey, body: Readable, length: number): Promise<void>;

  /**
   * The confirming `HEAD` — §9.7. `null` for absent, THROWS for unreachable:
   * a not-found cannot distinguish "failed to land" from "not yet published",
   * so absence stays `processing` and a network blip cannot mark a row `failed`.
   */
  head(key: ObjectKey): Promise<StoredObject | null>;
}

/*
 * Media rows and §9.7's ladder — api-sketch §9.4 to §9.8, schema §3.
 * No per-object state: the completing upload re-reads both objects with two
 * `HEAD`s (§9.7), so the row has nothing to remember between requests.
 */

import type { MediaKind, MediaStatus } from "../../domain/media/status.js";

export type NewMedia = {
  /** IS the envelope's `asset_id`, fixed before the client encrypted (§9.6). */
  readonly id: string;
  readonly albumId: string;
  /** §9.6's API enum of one. Widening to `MediaKind` is additive, Phase 3. */
  readonly kind: "photo";
  /** The complete metadata envelope, 81–4096 bytes, under `K_meta(id)` (§7). */
  readonly metadata: Uint8Array;
};

export type CreatedMedia = {
  readonly id: string;
  readonly createdAt: Date;
  /**
   * Read from the column, never asserted — §9.6's `201` would otherwise have
   * the route emit a status string, which is the one thing §9.7 forbids of
   * every route. The default makes it `pending`; this reports what it made.
   */
  readonly status: MediaStatus;
};

/** §9.8's shape, plus the `albums` join §9.3 resolves media scope against. */
export type MediaRow = CreatedMedia & {
  readonly albumId: string;
  readonly ownerId: string;
  readonly kind: MediaKind;
  /** Null until `ready`; then the sum of the two `HEAD` lengths (§9.7). */
  readonly byteSize: number | null;
  readonly updatedAt: Date;
};

/** §9.4's row. Every media row is listed, whatever its `status`. */
export type MediaListing = CreatedMedia & {
  readonly kind: MediaKind;
};

/** §9.5's row. The column verbatim — header and chunks, never inspected. */
export type MediaEnvelope = {
  readonly mediaId: string;
  readonly envelope: Uint8Array;
};

/**
 * Why `beginUpload` is three-valued: the guard is in the `UPDATE`'s `WHERE`, so
 * two concurrent `PUT`s cannot race a read-then-write — and a bare row count
 * then cannot tell "no such row" from "row is `ready`", which are `404`/`409`.
 */
export type UploadStart = "started" | "already_ready";

export interface MediaRepository {
  /**
   * Creates at `pending` with its envelope — no row ever exists without one.
   * Duplicates come from the primary key and surface as
   * `ApplicationError("DUPLICATE_MEDIA_ID")`; §9.6's `409` means "already
   * created", since a new id would orphan the envelope already encrypted.
   */
  create(media: NewMedia): Promise<CreatedMedia>;

  /** §9.8, and the scope lookup for §9.7's uploads. `ownerId` comes from the
   * join, so the use case resolves §9.3 exactly as it does for albums. */
  findById(mediaId: string): Promise<MediaRow | null>;

  /** §9.4, `created_at` ascending, every status. Not the same query as below,
   * deliberately: a `readyOnly` flag is how two routes' difference on purpose
   * becomes one call site someone flips. */
  listByAlbum(albumId: string): Promise<readonly MediaListing[]>;

  /** §9.5. The one place the server filters on status, and it filters in SQL
   * so §9.4's listing cannot inherit it. */
  listReadyEnvelopes(albumId: string): Promise<readonly MediaEnvelope[]>;

  /**
   * `pending | processing | failed → processing` — §9.7's first and fourth
   * edges. `null` for no such row. Guarded on `status <> 'ready'`, which is
   * the check "PUT is idempotent" removes.
   */
  beginUpload(mediaId: string): Promise<UploadStart | null>;

  /**
   * `processing → ready`, guarded on `status = 'processing'` so `pending →
   * ready` is inexpressible. `byteSize` is the sum of the two `HEAD` lengths;
   * no client-declared size is read at any point.
   */
  markReady(mediaId: string, byteSize: number): Promise<void>;

  /** `processing → failed`, guarded likewise. A zero row count is benign —
   * a concurrent request reached the row first. */
  markFailed(mediaId: string): Promise<void>;
}

// What recipients do — api-sketch §11.6, schema §3. Append-only: no update, no
// delete, and never a read-before-write — two opens are two rows, and
// deduplicating on write destroys what cannot be recovered.

/**
 * Mirrors `CHECK (event IN (…))` and `media_id`'s nullability: an
 * `album_opened` with a media id cannot be expressed. No owner field, so
 * an owner's request cannot be logged.
 */
export type AccessEvent =
  | { readonly event: "album_opened"; readonly recipientId: string }
  | {
      readonly event: "asset_viewed";
      readonly recipientId: string;
      readonly mediaId: string;
    };

/** §11.7's per-recipient row. Every recipient appears, zero-row and revoked. */
export type RecipientAccessSummary = {
  readonly recipientId: string;
  /** Ciphertext under K_label, verbatim (§5.3). */
  readonly label: Uint8Array;
  readonly revokedAt: Date | null;
  readonly albumOpens: number;
  /** `COUNT(DISTINCT media_id)` over `asset_viewed` — "opened 12 photos". */
  readonly mediaOpened: number;
  readonly lastOpenedAt: Date | null;
};

/**
 * `id` is the cursor: monotonic, where `occurred_at` is not unique. pg returns
 * the bigint as a string; the adapter converts, throwing if not a safe integer.
 */
export type AccessLogEntry = {
  readonly id: number;
  readonly recipientId: string;
  readonly mediaId: string | null;
  readonly event: AccessEvent["event"];
  readonly occurredAt: Date;
};

export type AccessLogQuery = {
  readonly albumId: string;
  readonly recipientId?: string;
  readonly mediaId?: string;
  readonly limit: number;
  /** Exclusive: rows with `id < before`. Absent for the first page. */
  readonly before?: number;
};

export type AccessLogPage = {
  readonly entries: readonly AccessLogEntry[];
  /** The last entry's id when more exist, else null (§11.7). */
  readonly nextBefore: number | null;
};

export interface AccessLogRepository {
  /**
   * One row, `occurred_at` the database's `now()`. A rejection must not fail
   * the fetch (§11.6): the caller catches it and serves anyway.
   */
  record(event: AccessEvent): Promise<void>;

  /**
   * §11.7's summary, `last_opened_at` descending, nulls last; `created_at, id`
   * break ties for determinism, not meaning. Counts converted from pg's strings.
   */
  summarise(albumId: string): Promise<readonly RecipientAccessSummary[]>;

  /**
   * Newest first by `id`, scoped through `recipients.album_id` — the log has no
   * album column. Fetches `limit + 1` to know whether a next page exists.
   */
  listEntries(query: AccessLogQuery): Promise<AccessLogPage>;
}

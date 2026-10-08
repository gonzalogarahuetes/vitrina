// The access log in Postgres — api-sketch §11.6, schema §3. One INSERT per
// event, `occurred_at` the database's; no read, no dedupe, no update.

import type { Pool } from "pg";
import type {
  AccessEvent,
  AccessLogPage,
  AccessLogQuery,
  AccessLogRepository,
  RecipientAccessSummary,
} from "../../../application/ports/access-log-repository.js";

class PostgresAccessLogRepository implements AccessLogRepository {
  private readonly pool: Pool;
  constructor(pool: Pool) {
    this.pool = pool;
  }

  async record(event: AccessEvent): Promise<void> {
    try {
      await this.pool.query(
        `INSERT INTO access_log (recipient_id, media_id, event) VALUES ($1, $2, $3)`,
        [
          event.recipientId,
          event.event === "asset_viewed" ? event.mediaId : null,
          event.event,
        ],
      );
    } catch (error) {
      // A pg error's `detail` names the ids; that pairing is viewing behaviour.
      throw new Error(`access_log insert failed (pg ${codeOf(error)})`);
    }
  }

  async summarise(albumId: string): Promise<readonly RecipientAccessSummary[]> {
    const { rows } = await this.pool.query(
      `SELECT r.id                                                               AS recipient_id,
              r.label,
              r.revoked_at,
              COUNT(*)                   FILTER (WHERE l.event = 'album_opened') AS album_opens,
              COUNT(DISTINCT l.media_id) FILTER (WHERE l.event = 'asset_viewed') AS media_opened,
              MAX(l.occurred_at)                                                 AS last_opened_at
        FROM recipients r
        LEFT JOIN access_log l ON l.recipient_id = r.id
        WHERE r.album_id = $1
        GROUP BY r.id
        ORDER BY last_opened_at DESC NULLS LAST, r.created_at, r.id`,
      [albumId],
    );

    return rows.map((recipientSummary) => ({
      recipientId: recipientSummary.recipient_id,
      label: recipientSummary.label,
      revokedAt: recipientSummary.revoked_at,
      albumOpens: Number(recipientSummary.album_opens),
      mediaOpened: Number(recipientSummary.media_opened),
      lastOpenedAt: recipientSummary.last_opened_at,
    }));
  }

  async listEntries(query: AccessLogQuery): Promise<AccessLogPage> {
    const values: unknown[] = [query.albumId];
    let filters = "";
    if (query.recipientId !== undefined) {
      values.push(query.recipientId);
      filters += ` AND l.recipient_id = $${values.length}`;
    }
    if (query.mediaId !== undefined) {
      values.push(query.mediaId);
      filters += ` AND l.media_id = $${values.length}`;
    }
    if (query.before !== undefined) {
      values.push(query.before);
      filters += ` AND l.id < $${values.length}`;
    }

    values.push(query.limit + 1);

    const { rows } = await this.pool.query(
      `SELECT l.id, l.recipient_id, l.media_id, l.event, l.occurred_at
        FROM access_log l
        JOIN recipients r ON r.id = l.recipient_id
        WHERE r.album_id = $1${filters}
        ORDER BY l.id DESC
        LIMIT $${values.length}`,
      values,
    );

    const page = rows.slice(0, query.limit).map((row) => ({
      id: safeId(row.id),
      recipientId: row.recipient_id,
      mediaId: row.media_id,
      event: row.event,
      occurredAt: row.occurred_at,
    }));

    return {
      entries: page,
      nextBefore: rows.length > query.limit ? page[page.length - 1]!.id : null,
    };
  }
}

export function createAccessLogRepository(pool: Pool): AccessLogRepository {
  return new PostgresAccessLogRepository(pool);
}

function codeOf(error: unknown): string | undefined {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
  ) {
    return error.code;
  }
  return undefined;
}

// pg returns bigint as a string; the port promises a safe-integer number.
function safeId(value: unknown): number {
  const id = Number(value);
  if (!Number.isSafeInteger(id))
    throw new Error("access_log.id is not a safe integer");
  return id;
}

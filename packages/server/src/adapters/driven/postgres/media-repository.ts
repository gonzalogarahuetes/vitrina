import type { Pool } from "pg";
import type {
  CreatedMedia,
  MediaEnvelope,
  MediaListing,
  MediaRepository,
  MediaRow,
  NewMedia,
  UploadStart,
} from "../../../application/ports/media-repository.js";
import { ApplicationError } from "../../../application/errors.js";

class PostgresMediaRepository implements MediaRepository {
  private readonly pool: Pool;
  constructor(pool: Pool) {
    this.pool = pool;
  }

  async create(media: NewMedia): Promise<CreatedMedia> {
    try {
      const {
        rows: [mediaRow],
      } = await this.pool.query(
        "INSERT INTO media (id, album_id, kind, metadata) VALUES ($1, $2, $3, $4) RETURNING id, created_at, status",
        [media.id, media.albumId, media.kind, Buffer.from(media.metadata)],
      );
      return {
        id: mediaRow.id,
        createdAt: mediaRow.created_at,
        status: mediaRow.status,
      };
    } catch (error) {
      if (isDuplicatedMedia(error)) {
        throw new ApplicationError("DUPLICATE_MEDIA_ID", {
          cause: new Error("media.id already taken (pg 23505)"),
        });
      }
      throw error;
    }
  }

  async findById(mediaId: string): Promise<MediaRow | null> {
    const {
      rows: [mediaRow],
    } = await this.pool.query(
      `SELECT m.id, m.album_id, a.owner_id, m.kind, m.status, m.byte_size, m.created_at, m.updated_at
        FROM media m JOIN albums a ON a.id = m.album_id
        WHERE m.id = $1`,
      [mediaId],
    );
    if (!mediaRow) return null;
    return {
      id: mediaRow.id,
      albumId: mediaRow.album_id,
      ownerId: mediaRow.owner_id,
      kind: mediaRow.kind,
      status: mediaRow.status,
      byteSize: mediaRow.byte_size === null ? null : Number(mediaRow.byte_size),
      updatedAt: mediaRow.updated_at,
      createdAt: mediaRow.created_at,
    };
  }

  async listByAlbum(albumId: string): Promise<readonly MediaListing[]> {
    const { rows } = await this.pool.query(
      `SELECT id, created_at, kind, status
        FROM media
        WHERE album_id = $1
        ORDER BY created_at ASC, id ASC`,
      [albumId],
    );

    return rows.map((mediaListByAlbum) => ({
      id: mediaListByAlbum.id,
      createdAt: mediaListByAlbum.created_at,
      kind: mediaListByAlbum.kind,
      status: mediaListByAlbum.status,
    }));
  }

  async listReadyEnvelopes(albumId: string): Promise<readonly MediaEnvelope[]> {
    const { rows } = await this.pool.query(
      `SELECT id, metadata
        FROM media
        WHERE album_id = $1 AND status = 'ready'
        ORDER BY created_at ASC`,
      [albumId],
    );

    return rows.map((row) => ({ mediaId: row.id, envelope: row.metadata }));
  }

  async beginUpload(mediaId: string): Promise<UploadStart | null> {
    const {
      rows: [mediaRow],
    } = await this.pool.query(
      `WITH updated AS (
        UPDATE media
            SET status = 'processing', updated_at = now()
        WHERE id = $1 AND status IN ('pending', 'processing', 'failed')
        RETURNING id
        )
        SELECT EXISTS (SELECT 1 FROM media WHERE id = $1) AS row_exists,
            EXISTS (SELECT 1 FROM updated)             AS started`,
      [mediaId],
    );
    if (mediaRow.started) return "started";
    return mediaRow.row_exists ? "already_ready" : null;
  }

  async markReady(mediaId: string, byteSize: number): Promise<void> {
    await this.pool.query(
      `UPDATE media
            SET status = 'ready', updated_at = now(), byte_size = $2
        WHERE id = $1 AND status = 'processing'`,
      [mediaId, byteSize],
    );
  }

  async markFailed(mediaId: string): Promise<void> {
    await this.pool.query(
      `UPDATE media SET status = 'failed', updated_at = now() WHERE id = $1 AND status = 'processing'`,
      [mediaId],
    );
  }
}

export function createMediaRepository(pool: Pool): MediaRepository {
  return new PostgresMediaRepository(pool);
}

function isDuplicatedMedia(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "23505" &&
    "constraint" in error &&
    error.constraint === "PK_media"
  );
}

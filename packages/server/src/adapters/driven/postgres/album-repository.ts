import { Pool } from "pg";
import { ApplicationError } from "../../../application/errors.js";
import type {
  AlbumRepository,
  AlbumRow,
  CreatedAlbum,
  NewAlbum,
  OwnerAlbum,
} from "../../../application/ports/album-repository.js";

class PostgresAlbumRepository implements AlbumRepository {
  private readonly pool: Pool;
  constructor(pool: Pool) {
    this.pool = pool;
  }

  async create(album: NewAlbum): Promise<CreatedAlbum> {
    try {
      const {
        rows: [albumRow],
      } = await this.pool.query(
        "INSERT INTO albums (id, owner_id, title, wrapped_key, wrap_nonce) VALUES ($1, $2, $3, $4, $5) RETURNING id, created_at",
        [
          album.id,
          album.ownerId,
          album.title,
          Buffer.from(album.wrappedKey),
          Buffer.from(album.wrapNonce),
        ],
      );
      return {
        id: albumRow.id,
        createdAt: albumRow.created_at,
      };
    } catch (error) {
      if (isDuplicatedAlbum(error)) {
        throw new ApplicationError("DUPLICATE_ALBUM_ID", {
          cause: new Error("album.id already taken (pg 23505)"),
        });
      }
      throw error;
    }
  }

  async listForOwner(ownerId: string): Promise<readonly OwnerAlbum[]> {
    const { rows } = await this.pool.query(
      `SELECT a.id,
              a.title,
              a.created_at,
              a.wrapped_key,
              a.wrap_nonce,
              (SELECT COUNT(*)::int FROM media m WHERE m.album_id = a.id) AS media_count
        FROM albums a
        WHERE a.owner_id = $1
        ORDER BY a.created_at DESC, a.id DESC`,
      [ownerId],
    );

    return rows.map((ownerAlbum) => ({
      id: ownerAlbum.id,
      createdAt: ownerAlbum.created_at,
      title: ownerAlbum.title,
      wrappedKey: ownerAlbum.wrapped_key,
      wrapNonce: ownerAlbum.wrap_nonce,
      mediaCount: ownerAlbum.media_count,
    }));
  }

  async findById(albumId: string): Promise<AlbumRow | null> {
    const {
      rows: [albumRow],
    } = await this.pool.query(
      `SELECT id, owner_id, created_at, title FROM albums WHERE id = $1`,
      [albumId],
    );

    if (!albumRow) return null;
    return {
      id: albumRow.id,
      createdAt: albumRow.created_at,
      ownerId: albumRow.owner_id,
      title: albumRow.title,
    };
  }
}

export function createAlbumRepository(pool: Pool): AlbumRepository {
  return new PostgresAlbumRepository(pool);
}

function isDuplicatedAlbum(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "23505" &&
    "constraint" in error &&
    error.constraint === "PK_albums"
  );
}

import type { Pool } from "pg";
import type {
  RecipientGrant,
  RecipientRepository,
} from "../../../application/ports/recipient-repository.js";

class PostgresRecipientRepository implements RecipientRepository {
  private readonly pool: Pool;
  constructor(pool: Pool) {
    this.pool = pool;
  }

  async findGrantByTokenHash(
    tokenHash: Uint8Array,
  ): Promise<RecipientGrant | null> {
    const {
      rows: [recipientRow],
    } = await this.pool.query(
      `SELECT id, album_id, revoked_at FROM recipients WHERE token_hash = $1`,
      [Buffer.from(tokenHash)],
    );
    if (!recipientRow) return null;
    return {
      id: recipientRow.id,
      albumId: recipientRow.album_id,
      revokedAt: recipientRow.revoked_at,
    };
  }
}

export function createRecipientRepository(pool: Pool): RecipientRepository {
  return new PostgresRecipientRepository(pool);
}

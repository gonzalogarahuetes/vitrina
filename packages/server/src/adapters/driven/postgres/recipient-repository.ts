import type { Pool } from "pg";
import type {
  CreatedRecipient,
  NewRecipient,
  RecipientGrant,
  RecipientRepository,
  RecipientScope,
} from "../../../application/ports/recipient-repository.js";
import { ApplicationError } from "../../../application/errors.js";

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

  async create(recipient: NewRecipient): Promise<CreatedRecipient> {
    try {
      const query =
        recipient.kind === "qr"
          ? "INSERT INTO recipients (id, album_id, kind, label, token_hash) VALUES ($1, $2, $3, $4, $5) RETURNING id, created_at"
          : "INSERT INTO recipients (id, album_id, kind, label, token_hash, wrapped, wrap_nonce, kdf_salt, kdf_memory_kib, kdf_iterations, kdf_parallelism) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id, created_at";

      const extraFields =
        recipient.kind === "qr"
          ? []
          : [
              Buffer.from(recipient.wrap.wrapped),
              Buffer.from(recipient.wrap.wrapNonce),
              Buffer.from(recipient.wrap.kdfSalt),
              recipient.wrap.params.memoryKib,
              recipient.wrap.params.iterations,
              recipient.wrap.params.parallelism,
            ];

      const {
        rows: [recipientRow],
      } = await this.pool.query(query, [
        recipient.id,
        recipient.albumId,
        recipient.kind,
        Buffer.from(recipient.label),
        Buffer.from(recipient.tokenHash),
        ...extraFields,
      ]);
      return {
        id: recipientRow.id,
        createdAt: recipientRow.created_at,
      };
    } catch (error) {
      if (isDuplicatedRecipient(error)) {
        throw new ApplicationError("DUPLICATE_RECIPIENT", {
          cause: new Error("recipient.id already taken (pg 23505)"),
        });
      }

      if (isDuplicatedTokenHash(error)) {
        throw new ApplicationError("DUPLICATE_RECIPIENT", {
          cause: new Error("recipients token_hash collided (pg 23505)"),
        });
      }
      throw error;
    }
  }

  async findScopeById(recipientId: string): Promise<RecipientScope | null> {
    const {
      rows: [recipientRow],
    } = await this.pool.query(
      `SELECT r.id, r.album_id, a.owner_id
      FROM recipients r JOIN albums a ON a.id = r.album_id
      WHERE r.id = $1`,
      [recipientId],
    );
    if (!recipientRow) return null;
    return {
      id: recipientRow.id,
      albumId: recipientRow.album_id,
      ownerId: recipientRow.owner_id,
    };
  }

  async revoke(recipientId: string): Promise<Date> {
    const {
      rows: [updatedRow],
    } = await this.pool.query(
      `UPDATE recipients SET revoked_at = COALESCE(revoked_at, now()) WHERE id = $1 RETURNING revoked_at`,
      [recipientId],
    );
    if (!updatedRow) throw new Error("revoked_at missing from row");
    return updatedRow.revoked_at;
  }
}

export function createRecipientRepository(pool: Pool): RecipientRepository {
  return new PostgresRecipientRepository(pool);
}

function isDuplicatedRecipient(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "23505" &&
    "constraint" in error &&
    error.constraint === "PK_recipients"
  );
}

function isDuplicatedTokenHash(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "23505" &&
    "constraint" in error &&
    error.constraint === "UQ_recipients_token_hash"
  );
}

import { Pool } from "pg";
import { ApplicationError } from "../../../application/errors.js";
import type {
  CreatedOwner,
  NewOwner,
  NewOwnerToken,
  OwnerCredential,
  OwnerKdfRow,
  OwnerPasswordKey,
  OwnerRepository,
  OwnerToken,
} from "../../../application/ports/owner-repository.js";

class PostgresOwnerRepository implements OwnerRepository {
  private readonly pool: Pool;
  constructor(pool: Pool) {
    this.pool = pool;
  }

  async createWithPasswordKey(owner: NewOwner): Promise<CreatedOwner> {
    const client = await this.pool.connect();

    let poisoned: Error | undefined;
    try {
      await client.query(`BEGIN;`);

      const {
        rows: [ownerRow],
      } = await client.query(
        "INSERT INTO owners (email, auth_hash) VALUES ($1, $2) RETURNING id, created_at",
        [owner.email, Buffer.from(owner.authHash)],
      );
      const key = owner.passwordKey;
      await client.query(
        `INSERT INTO owner_keys
                    (owner_id, kind, wrapped_master, wrap_nonce,
                    kdf_salt, kdf_memory_kib, kdf_iterations, kdf_parallelism)
                    VALUES ($1, 'password', $2, $3, $4, $5, $6, $7);`,
        [
          ownerRow.id,
          Buffer.from(key.wrappedMaster),
          Buffer.from(key.wrapNonce),
          Buffer.from(key.kdfSalt),
          key.params.memoryKib,
          key.params.iterations,
          key.params.parallelism,
        ],
      );

      await client.query("COMMIT");

      return {
        id: ownerRow.id,
        createdAt: ownerRow.created_at,
      };
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch (rollbackFailure) {
        poisoned = rollbackFailure as Error; // the connection, not the query, is suspect
      }
      if (isDuplicateAddress(error)) {
        throw new ApplicationError("DUPLICATE_ADDRESS", {
          cause: new Error("owners.email already taken (pg 23505)"),
        });
      }
      throw error;
    } finally {
      client.release(poisoned);
    }
  }

  async findCredentialByEmail(
    normalisedEmail: string,
  ): Promise<OwnerCredential | null> {
    const {
      rows: [ownerRow],
    } = await this.pool.query(
      `SELECT id, auth_hash FROM owners WHERE email = $1`,
      [normalisedEmail],
    );

    if (!ownerRow) return null;
    return { id: ownerRow.id, authHash: ownerRow.auth_hash };
  }

  async findKdfByEmail(normalisedEmail: string): Promise<OwnerKdfRow | null> {
    const {
      rows: [ownerKeyRow],
    } = await this.pool.query(
      `SELECT k.kdf_salt, k.kdf_memory_kib, k.kdf_iterations, k.kdf_parallelism
        FROM owner_keys k JOIN owners o ON o.id = k.owner_id
        WHERE o.email = $1 AND k.kind = 'password';`,
      [normalisedEmail],
    );

    if (!ownerKeyRow) return null;
    return {
      kdfSalt: ownerKeyRow.kdf_salt,
      params: {
        memoryKib: ownerKeyRow.kdf_memory_kib,
        iterations: ownerKeyRow.kdf_iterations,
        parallelism: ownerKeyRow.kdf_parallelism,
      },
    };
  }

  async findPasswordKeyByOwnerId(
    ownerId: string,
  ): Promise<OwnerPasswordKey | null> {
    const {
      rows: [ownerKeyRow],
    } = await this.pool.query(
      `SELECT k.kdf_salt, k.kdf_memory_kib, k.kdf_iterations, k.kdf_parallelism, k.wrapped_master, k.wrap_nonce
        FROM owner_keys k
        WHERE owner_id = $1 AND kind = 'password';`,
      [ownerId],
    );

    if (!ownerKeyRow) return null;
    return {
      wrapNonce: ownerKeyRow.wrap_nonce,
      wrappedMaster: ownerKeyRow.wrapped_master,
      kdfSalt: ownerKeyRow.kdf_salt,
      params: {
        memoryKib: ownerKeyRow.kdf_memory_kib,
        iterations: ownerKeyRow.kdf_iterations,
        parallelism: ownerKeyRow.kdf_parallelism,
      },
    };
  }

  async insertToken(token: NewOwnerToken): Promise<void> {
    await this.pool.query(
      `INSERT INTO owner_tokens (owner_id, token_hash, expires_at) VALUES ($1, $2, $3)`,
      [token.ownerId, Buffer.from(token.tokenHash), token.expiresAt],
    );
  }

  async findTokenByHash(tokenHash: Uint8Array): Promise<OwnerToken | null> {
    const {
      rows: [ownerTokenRow],
    } = await this.pool.query(
      `SELECT owner_id, expires_at, revoked_at FROM owner_tokens WHERE token_hash = $1`,
      [Buffer.from(tokenHash)],
    );
    if (!ownerTokenRow) return null;
    return {
      ownerId: ownerTokenRow.owner_id,
      expiresAt: ownerTokenRow.expires_at,
      revokedAt: ownerTokenRow.revoked_at,
    };
  }
}

export function createOwnerRepository(pool: Pool): OwnerRepository {
  return new PostgresOwnerRepository(pool);
}

function isDuplicateAddress(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "23505" &&
    "constraint" in error &&
    error.constraint === "UQ_owners_email"
  );
}

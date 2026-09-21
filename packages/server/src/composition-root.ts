/*
 * The only file permitted to name a concrete adapter (vitrina-server-architecture.md §5).
 *
 * It constructs the driven adapters, injects them into the use-case factories,
 * and returns the finished use cases. `buildServer` receives those use cases and
 * never a repository — which is what keeps the web app one caller of the API
 * rather than its owner (non-negotiable #5).
 */

import { randomBytes } from "node:crypto";
import { Pool } from "pg";

import { createCredentialHasher } from "./adapters/driven/hashing/credential-hasher.js";
import { createTokenHasher } from "./adapters/driven/hashing/token-hasher.js";
import { createOwnerRepository } from "./adapters/driven/postgres/owner-repository.js";
import { createSystemClock } from "./adapters/driven/system-clock.js";
import type { Clock } from "./application/ports/clock.js";
import type { OwnerKdfParameters, OwnerRepository } from "./application/ports/owner-repository.js";
import type { CredentialHasher } from "./application/ports/credential-hasher.js";
import type { TokenHasher } from "./application/ports/token-hasher.js";
import type { UseCases } from "./application/use-cases/index.js";
import { authenticateOwner } from "./application/use-cases/authenticate-owner.js";
import { login } from "./application/use-cases/login.js";
import { loginParams } from "./application/use-cases/login-params.js";
import { makeMintSession } from "./application/use-cases/mint-session.js";
import { ownerKey } from "./application/use-cases/owner-key.js";
import { signup } from "./application/use-cases/signup.js";
import { makeVerifyProof } from "./application/use-cases/verify-proof.js";

/**
 * Argon2id v1, client-side — encryption spec §6.2, confirmed by phase-0-plan
 * §8's V.1 on 14 September 2026. Returned by /login/params on a MISS, so a
 * decoy carries what every real row carries; §8.1's floors are separate and
 * live in the signup JSON Schema.
 *
 * §8.1 wants this in `packages/shared`, since the client build needs the same
 * three integers. That package exports only a `types` condition today and
 * cannot hold a runtime value — flagged, not worked around here.
 */
export const OWNER_KDF_V1: OwnerKdfParameters = {
  memoryKib: 65536,
  iterations: 3,
  parallelism: 1,
};

export type Adapters = {
  readonly pool: Pool;
  readonly owners: OwnerRepository;
  readonly tokenHasher: TokenHasher;
  readonly clock: Clock;
};

/** What the use cases need, with no vendor in sight. */
export type UseCaseAdapters = {
  readonly owners: OwnerRepository;
  readonly credentialHasher: CredentialHasher;
  readonly tokenHasher: TokenHasher;
  readonly clock: Clock;
};

export type UseCaseOptions = {
  readonly kdfV1: OwnerKdfParameters;
  /**
   * The dummy `auth_hash` /login verifies against on a miss (§7.5). Any 32
   * bytes satisfy the property — the miss path runs the same HMAC and the same
   * comparison either way — so it is drawn rather than configured, and drawn
   * randomly so no crafted proof can match it. Not the #17 failure the reflex
   * flags: nothing is silently absent, because every value works.
   */
  readonly dummyAuthHash: Uint8Array;
};

/**
 * The wiring itself, over adapters someone else built. Separate from the
 * function below so a test can drive the REAL graph with a fake repository
 * instead of reimplementing it and asserting against its own copy.
 */
export function buildUseCases(adapters: UseCaseAdapters, options: UseCaseOptions): UseCases {
  const { owners, credentialHasher, tokenHasher, clock } = adapters;
  const mintSession = makeMintSession(owners, tokenHasher, clock);

  return {
    signup: signup({ owners, hasher: credentialHasher, mintSession }),
    loginParams: loginParams({ owners, hasher: credentialHasher, kdfV1: options.kdfV1 }),
    login: login({
      owners,
      verifyProof: makeVerifyProof(credentialHasher),
      mintSession,
      dummyAuthHash: options.dummyAuthHash,
    }),
    ownerKey: ownerKey({ owners }),
    authenticateOwner: authenticateOwner({ owners, tokenHasher, clock }),
  };
}

export type CompositionConfig = {
  readonly serverSecret: Uint8Array;
  readonly databaseUrl: string;
};

/**
 * Builds the adapters and the use cases over them. The secret arrives as a
 * value from the validated config and is read nowhere else (§8.2).
 */
export function buildComposition(config: CompositionConfig): {
  adapters: Adapters;
  useCases: UseCases;
} {
  const pool = new Pool({ connectionString: config.databaseUrl });
  const adapters = {
    owners: createOwnerRepository(pool),
    credentialHasher: createCredentialHasher(config.serverSecret),
    tokenHasher: createTokenHasher(),
    clock: createSystemClock(),
  };

  return {
    adapters: { pool, ...adapters },
    useCases: buildUseCases(adapters, {
      kdfV1: OWNER_KDF_V1,
      dummyAuthHash: randomBytes(32),
    }),
  };
}

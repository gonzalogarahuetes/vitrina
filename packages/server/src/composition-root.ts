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
import { OWNER_KDF_V1 } from "@vitrina/shared";

import type { StorageConfig } from "./config.js";
import { createCredentialHasher } from "./adapters/driven/hashing/credential-hasher.js";
import { createTokenHasher } from "./adapters/driven/hashing/token-hasher.js";
import { createOwnerRepository } from "./adapters/driven/postgres/owner-repository.js";
import { createSystemClock } from "./adapters/driven/system-clock.js";
import type { Clock } from "./application/ports/clock.js";
import type {
  OwnerKdfParameters,
  OwnerRepository,
} from "./application/ports/owner-repository.js";
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
import { authenticateRecipient } from "./application/use-cases/authenticate-recipient.js";
import type { RecipientRepository } from "./application/ports/recipient-repository.js";
import { createRecipientRepository } from "./adapters/driven/postgres/recipient-repository.js";
import { createAlbum } from "./application/use-cases/create-album.js";
import type { AlbumRepository } from "./application/ports/album-repository.js";
import { listAlbums } from "./application/use-cases/list-albums.js";
import { createAlbumRepository } from "./adapters/driven/postgres/album-repository.js";
import type { MediaRepository } from "./application/ports/media-repository.js";
import { createMedia } from "./application/use-cases/create-media.js";
import { createMediaRepository } from "./adapters/driven/postgres/media-repository.js";
import { findMediaById } from "./application/use-cases/find-media-by-id.js";
import type { ObjectStore } from "./application/ports/object-store.js";
import { createObjectStore } from "./adapters/driven/s3/object-store.js";
import { S3Client } from "@aws-sdk/client-s3";
import { uploadMediaObject } from "./application/use-cases/upload-media-object.js";
import { findAlbumById } from "./application/use-cases/find-album-by-id.js";
import { getAlbumMetadata } from "./application/use-cases/get-album-metadata.js";
import { logout } from "./application/use-cases/logout.js";
import { logoutAll } from "./application/use-cases/logout-all.js";
import { createRecipient } from "./application/use-cases/create-recipient.js";
import { revokeRecipient } from "./application/use-cases/revoke-recipient.js";
import { getRecipientKey } from "./application/use-cases/get-recipient-key.js";
import { getOwnRecipient } from "./application/use-cases/get-own-recipient.js";
import { getMediaThumbnail } from "./application/use-cases/get-media-thumbnail.js";
import { getMediaAsset } from "./application/use-cases/get-media-asset.js";
import type { AccessLogRepository } from "./application/ports/access-log-repository.js";
import { createAccessLogRepository } from "./adapters/driven/postgres/access-log-repository.js";
import { getAccessLogEntries } from "./application/use-cases/get-access-log-entries.js";
import { getAccessLogSummary } from "./application/use-cases/get-access-log-summary.js";

/**
 * The v1 Argon2id parameters, declared in `@vitrina/shared` because the client
 * derives with the same three integers (§8.1). The annotation is not decoration:
 * shared's `KdfParameters` and the port's `OwnerKdfParameters` are separate
 * declarations, and this assignment is the only thing that goes red if they
 * drift. It belongs here because this is the one file allowed to see both.
 */
const kdfV1: OwnerKdfParameters = OWNER_KDF_V1;

export type Adapters = {
  readonly pool: Pool;
  readonly client: S3Client;
  readonly owners: OwnerRepository;
  readonly media: MediaRepository;
  readonly albums: AlbumRepository;
  readonly recipients: RecipientRepository;
  readonly tokenHasher: TokenHasher;
  readonly clock: Clock;
  readonly objectStore: ObjectStore;
};

/** What the use cases need, with no vendor in sight. */
export type UseCaseAdapters = {
  readonly owners: OwnerRepository;
  readonly media: MediaRepository;
  readonly albums: AlbumRepository;
  readonly recipients: RecipientRepository;
  readonly accessLogs: AccessLogRepository;
  readonly credentialHasher: CredentialHasher;
  readonly tokenHasher: TokenHasher;
  readonly clock: Clock;
  readonly objectStore: ObjectStore;
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
export function buildUseCases(
  adapters: UseCaseAdapters,
  options: UseCaseOptions,
): UseCases {
  const {
    owners,
    recipients,
    credentialHasher,
    tokenHasher,
    clock,
    albums,
    media,
    objectStore,
    accessLogs,
  } = adapters;
  const mintSession = makeMintSession(owners, tokenHasher, clock);

  return {
    signup: signup({ owners, hasher: credentialHasher, mintSession }),
    loginParams: loginParams({
      owners,
      hasher: credentialHasher,
      kdfV1: options.kdfV1,
    }),
    login: login({
      owners,
      verifyProof: makeVerifyProof(credentialHasher),
      mintSession,
      dummyAuthHash: options.dummyAuthHash,
    }),
    logout: logout({ owners, tokenHasher }),
    logoutAll: logoutAll({ owners }),
    ownerKey: ownerKey({ owners }),
    authenticateOwner: authenticateOwner({ owners, tokenHasher, clock }),
    authenticateRecipient: authenticateRecipient({ recipients, tokenHasher }),
    createAlbum: createAlbum({ albums }),
    listAlbums: listAlbums({ albums }),
    createMedia: createMedia({ media, albums }),
    findMediaById: findMediaById({ media }),
    uploadMediaObject: uploadMediaObject({ media, objectStore }),
    findAlbumById: findAlbumById({ albums, media }),
    getAlbumMetadata: getAlbumMetadata({ albums, media, accessLogs }),
    createRecipient: createRecipient({ recipients, albums }),
    revokeRecipient: revokeRecipient({ recipients }),
    getRecipientKey: getRecipientKey({ recipients }),
    getOwnRecipient: getOwnRecipient({ recipients }),
    getMediaThumbnail: getMediaThumbnail({ media, objectStore }),
    getMediaAsset: getMediaAsset({ media, objectStore, accessLogs }),
    getAccessLogEntries: getAccessLogEntries({ accessLogs, albums }),
    getAccessLogSummary: getAccessLogSummary({ accessLogs, albums }),
  };
}

export type CompositionConfig = {
  readonly serverSecret: Uint8Array;
  readonly databaseUrl: string;
  readonly storage: StorageConfig;
};

/**
 * Builds the adapters and the use cases over them. The secret arrives as a
 * value from the validated config and is read nowhere else (§8.2).
 */
export function buildComposition(config: CompositionConfig): {
  adapters: Adapters;
  useCases: UseCases;
} {
  const client = new S3Client({
    endpoint: config.storage.endpoint,
    region: config.storage.region,
    credentials: {
      accessKeyId: config.storage.accessKeyId,
      secretAccessKey: config.storage.secretAccessKey,
    },
    forcePathStyle: true,
  });
  const pool = new Pool({ connectionString: config.databaseUrl });
  const adapters = {
    owners: createOwnerRepository(pool),
    albums: createAlbumRepository(pool),
    recipients: createRecipientRepository(pool),
    media: createMediaRepository(pool),
    accessLogs: createAccessLogRepository(pool),
    credentialHasher: createCredentialHasher(config.serverSecret),
    tokenHasher: createTokenHasher(),
    clock: createSystemClock(),
    objectStore: createObjectStore(client, config.storage.bucket),
  };

  return {
    adapters: { pool, client, ...adapters },
    useCases: buildUseCases(adapters, {
      kdfV1,
      dummyAuthHash: randomBytes(32),
    }),
  };
}

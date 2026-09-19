import { normaliseAddress } from "../../domain/owner/normalise-address.js";
import { ApplicationError } from "../errors.js";
import type { CredentialHasher } from "../ports/credential-hasher.js";
import type {
  OwnerKdfParameters,
  OwnerRepository,
} from "../ports/owner-repository.js";
import type { MintSession } from "./mint-session.js";

export type SignupDeps = {
  readonly owners: OwnerRepository;
  readonly hasher: CredentialHasher;
  readonly mintSession: MintSession;
};

export type SignupInput = {
  readonly email: string;
  readonly proof: Uint8Array;
  readonly kdfSalt: Uint8Array;
  readonly params: OwnerKdfParameters;
  readonly wrappedMaster: Uint8Array;
  readonly wrapNonce: Uint8Array;
};

export type SignupResult = {
  readonly id: string;
  readonly createdAt: Date;
  readonly token: Uint8Array;
  readonly expiresAt: Date;
};

export function signup(deps: SignupDeps) {
  return async (input: SignupInput): Promise<SignupResult> => {
    const normalised = normaliseAddress(input.email);
    if (normalised === "") {
      throw new ApplicationError("EMPTY_ADDRESS");
    }

    const authHash = deps.hasher.authHash(input.proof);
    const row = await deps.owners.createWithPasswordKey({
      email: normalised,
      authHash,
      passwordKey: {
        wrapNonce: input.wrapNonce,
        wrappedMaster: input.wrappedMaster,
        kdfSalt: input.kdfSalt,
        params: input.params,
      },
    });

    const mintedSession = await deps.mintSession(row.id);
    return {
      id: row.id,
      createdAt: row.createdAt,
      token: mintedSession.token,
      expiresAt: mintedSession.expiresAt,
    };
  };
}

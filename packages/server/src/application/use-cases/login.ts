import { normaliseAddress } from "../../domain/owner/normalise-address.js";
import { ApplicationError } from "../errors.js";
import type { OwnerRepository } from "../ports/owner-repository.js";
import type { MintedSession, MintSession } from "./mint-session.js";
import type { VerifyProof } from "./verify-proof.js";

export type LoginDeps = {
  readonly owners: OwnerRepository;
  readonly verifyProof: VerifyProof;
  readonly mintSession: MintSession;
  readonly dummyAuthHash: Uint8Array; // 32
};

export type LoginInput = {
  readonly email: string;
  readonly proof: Uint8Array;
};
export function login(deps: LoginDeps) {
  return async (input: LoginInput): Promise<MintedSession> => {
    const normalised = normaliseAddress(input.email);
    if (normalised === "") {
      throw new ApplicationError("EMPTY_ADDRESS");
    }

    const row = await deps.owners.findCredentialByEmail(normalised);
    const verified = deps.verifyProof(
      row?.authHash ?? deps.dummyAuthHash,
      input.proof,
    );

    if (row === null || !verified) {
      throw new ApplicationError("INVALID_CREDENTIALS");
    }

    return await deps.mintSession(row.id);
  };
}

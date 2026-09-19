import { normaliseAddress } from "../../domain/owner/normalise-address.js";
import { ApplicationError } from "../errors.js";
import type { CredentialHasher } from "../ports/credential-hasher.js";
import type {
  OwnerKdfParameters,
  OwnerKdfRow,
  OwnerRepository,
} from "../ports/owner-repository.js";

export type LoginParamsDeps = {
  readonly owners: OwnerRepository;
  readonly hasher: CredentialHasher;
  readonly kdfV1: OwnerKdfParameters;
};

export type LoginParamsInput = { readonly email: string }; // as typed

export function loginParams(deps: LoginParamsDeps) {
  return async (input: LoginParamsInput): Promise<OwnerKdfRow> => {
    const normalised = normaliseAddress(input.email);
    if (normalised === "") {
      throw new ApplicationError("EMPTY_ADDRESS");
    }

    const row = await deps.owners.findKdfByEmail(normalised);
    if (row === null) {
      const kdfSalt = deps.hasher.decoySalt(normalised);

      return {
        kdfSalt,
        params: deps.kdfV1,
      };
    }

    return { kdfSalt: row.kdfSalt, params: row.params };
  };
}

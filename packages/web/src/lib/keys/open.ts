import type { Envelope } from "$lib/envelope";
import { decodeBase64url, MalformedEncodingError } from "@vitrina/shared";
import type {
  OpenDirectKey,
  OpenPassphraseKey,
  RecipientKeyMaterial,
} from "./types";
import { MalformedId, uuidToBytes } from "$lib/ids";
import type { WrapParams, WrappedKey } from "@vitrina/envelope/wasm/envelope";
import { withinKdfCeiling } from "./kdf-ceiling";

export const openDirectKey: OpenDirectKey = (
  env: Envelope,
  key: Uint8Array,
) => {
  try {
    return { ok: true, albumKey: env.AlbumKey.fromBytes(key) };
  } catch (error) {
    return { ok: false, error: "could-not-derive" };
  } finally {
    key.fill(0);
  }
};

export const openPassphraseKey: OpenPassphraseKey = async (
  env: Envelope,
  passphrase: string,
  material: RecipientKeyMaterial,
) => {
  let wrappedKey: WrappedKey | undefined;
  let params: WrapParams | undefined;
  try {
    const kdfSalt = decodeBase64url(material.kdf_salt, 16);
    const wrapped = decodeBase64url(material.wrapped, 48);
    const wrapNonce = decodeBase64url(material.wrap_nonce, 24);
    const recipientIdBytes = uuidToBytes(material.id);

    if (
      !withinKdfCeiling({
        memoryKib: material.kdf_memory_kib,
        iterations: material.kdf_iterations,
        parallelism: material.kdf_parallelism,
      })
    ) {
      return { ok: false, error: "unusable-material" };
    }

    params = new env.WrapParams(
      material.kdf_memory_kib,
      material.kdf_iterations,
      material.kdf_parallelism,
    );

    wrappedKey = env.WrappedKey.fromParts(wrapped, wrapNonce, kdfSalt);

    const albumKey = env.unwrapAlbumKey(
      passphrase,
      params,
      recipientIdBytes,
      wrappedKey,
    );
    return {
      ok: true,
      albumKey,
    };
  } catch (error) {
    if (
      error instanceof MalformedEncodingError ||
      error instanceof MalformedId
    ) {
      return { ok: false, error: "unusable-material" };
    }

    switch (envelopeCode(error)) {
      case "EmptyPassphrase":
        return { ok: false, error: "empty" };
      case "AuthenticationFailed":
      case "UnpairedSurrogate":
        return { ok: false, error: "wrong-passphrase" };
      case "InvalidParams":
      case "NotUint32":
      case "WrongLength":
      case "UnexpectedKeyLength":
      case "UnexpectedWrappedLength":
        return { ok: false, error: "unusable-material" };
      default:
        return { ok: false, error: "could-not-derive" };
    }
  } finally {
    try {
      params?.free();
    } catch {
      // After a trap the poisoned loader throws on every call, free included. That's why these catch are empty
    }
    try {
      wrappedKey?.free();
    } catch {
      // After a trap the poisoned loader throws on every call, free included. That's why these catch are empty
    }
  }
};

/** The binding's `code` if this is one of its errors, otherwise undefined. */
function envelopeCode(e: unknown): string | undefined {
  if (
    e instanceof Error &&
    e.name === "EnvelopeError" &&
    "code" in e &&
    typeof e.code === "string"
  ) {
    return e.code;
  }
  return undefined;
}

import type { Envelope } from "$lib/envelope";
import { decodeBase64url, MalformedEncodingError } from "@vitrina/shared";
import type {
  OpenDirectKey,
  OpenPassphraseKey,
  RecipientKeyMaterial,
} from "./types";
import { MalformedId, uuidToBytes } from "$lib/ids";
import type { WrapParams, WrappedKey } from "@vitrina/envelope/wasm/envelope";

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

    // Relay-supplied Argon2id params have no upper bound in the crate: a bad row could freeze the tab.
    // Cap memory × iterations at 4 × v1 (~9 s on the slowest target) and memory at 2 × v1 (low-end Android).
    // Interop rule: raising v1's params for new invites means raising these ceilings in every client first.
    const m = material.kdf_memory_kib,
      t = material.kdf_iterations,
      p = material.kdf_parallelism;
    if (m > 131_072 || p > 4 || m * t > 786_432)
      return { ok: false, error: "unusable-material" };

    params = new env.WrapParams(m, t, p);

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

import type { Envelope } from "$lib/envelope";
import type {
  AlbumKey,
  MasterWrappedKey,
  WrappedMaster,
  OwnerCredential,
  OwnerKek,
  WrapParams,
  InviteKey,
  InviteWrappedKey,
  WrappedKey,
} from "@vitrina/envelope/wasm/envelope";
import type {
  MasterKey,
  CreateAccountKeys,
  OpenAlbumKey,
  AlbumWrapping,
  DeriveLoginCredential,
  LoginParams,
  OpenMasterKey,
  OwnerKeyMaterial,
  UnlockMasterKey,
  CreateAlbumKey,
  CreatePassphraseInvite,
  CreateQrInvite,
  Wordlist,
} from "./owner-types";
import {
  decodeBase64url,
  encodeBase64url,
  OWNER_KDF_V1,
  RECIPIENT_KDF_V1,
} from "@vitrina/shared";
import { MalformedId, uuidToBytes } from "$lib/ids";
import { withinKdfCeiling } from "./kdf-ceiling";
import { MalformedEncodingError } from "@vitrina/shared";

export const createAccountKeys: CreateAccountKeys = async (
  env: Envelope,
  password: string,
) => {
  let master: MasterKey | undefined;
  let params: WrapParams | undefined;
  let credential: OwnerCredential | undefined;
  let kek: OwnerKek | undefined;
  let wrappedMaster: WrappedMaster | undefined;
  try {
    master = env.MasterKey.generate();
    const kdfSalt = crypto.getRandomValues(new Uint8Array(16));
    params = new env.WrapParams(
      OWNER_KDF_V1.memoryKib,
      OWNER_KDF_V1.iterations,
      OWNER_KDF_V1.parallelism,
    );
    credential = env.deriveOwnerCredential(password, kdfSalt, params);
    // copying the proof out of credential before intoKek() consumes it
    const proof = credential.proof;
    kek = credential.intoKek();
    credential = undefined;
    wrappedMaster = env.wrapMasterKey(kek, master);
    const wrapNonce = wrappedMaster.wrapNonce;
    const wrapped = wrappedMaster.wrapped;
    wrappedMaster.free();
    wrappedMaster = undefined;
    return {
      ok: true,
      keys: {
        master,
        proof,
        kdfSalt,
        params: OWNER_KDF_V1,
        wrappedMaster: wrapped,
        wrapNonce,
      },
    };
  } catch (error) {
    try {
      master?.free();
    } catch {
      // After a trap the poisoned loader throws on every call, free included. That's why these catch are empty
    }
    try {
      wrappedMaster?.free();
    } catch {
      // After a trap the poisoned loader throws on every call, free included. That's why these catch are empty
    }
    switch (envelopeCode(error)) {
      case "EmptyPassword":
        return { ok: false, error: "empty" };
      case "UnpairedSurrogate":
      case "NotString":
        return { ok: false, error: "invalid-password" };
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
      credential?.free();
    } catch {
      // After a trap the poisoned loader throws on every call, free included. That's why these catch are empty
    }
    try {
      kek?.free();
    } catch {
      // After a trap the poisoned loader throws on every call, free included. That's why these catch are empty
    }
  }
};

export const openAlbumKey: OpenAlbumKey = (
  env: Envelope,
  master: MasterKey,
  album: AlbumWrapping,
) => {
  let wrapped: MasterWrappedKey | undefined;
  try {
    const albumIdBytes = uuidToBytes(album.id);
    wrapped = env.MasterWrappedKey.fromParts(
      decodeBase64url(album.wrapped_key, 48),
      decodeBase64url(album.wrap_nonce, 24),
    );
    const albumKey = env.unwrapAlbumKeyWithMaster(
      wrapped,
      master,
      albumIdBytes,
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
      case "AuthenticationFailed":
      case "UnexpectedKeyLength":
        return { ok: false, error: "cannot-open" };
      case "UnexpectedWrappedLength":
      case "WrongLength":
        return { ok: false, error: "unusable-material" };
      default:
        return { ok: false, error: "could-not-derive" };
    }
  } finally {
    try {
      wrapped?.free();
    } catch {
      // After a trap the poisoned loader throws on every call, free included. That's why these catch are empty
    }
  }
};

export const deriveLoginCredential: DeriveLoginCredential = async (
  env: Envelope,
  password: string,
  params: LoginParams,
) => {
  let wrapParams: WrapParams | undefined;
  let credential: OwnerCredential | undefined;
  try {
    const kdfSalt = decodeBase64url(params.kdf_salt, 16);
    if (
      !withinKdfCeiling({
        memoryKib: params.kdf_memory_kib,
        iterations: params.kdf_iterations,
        parallelism: params.kdf_parallelism,
      })
    ) {
      return { ok: false, error: "unusable-material" };
    }
    wrapParams = new env.WrapParams(
      params.kdf_memory_kib,
      params.kdf_iterations,
      params.kdf_parallelism,
    );
    credential = env.deriveOwnerCredential(password, kdfSalt, wrapParams);
    // copying the KEK and the proof out of credential before intoKek() consumes it
    const proof = credential.proof;
    const kek = credential.intoKek();
    credential = undefined;
    return {
      ok: true,
      kek,
      proof,
    };
  } catch (error) {
    if (
      error instanceof MalformedEncodingError ||
      error instanceof MalformedId
    ) {
      return { ok: false, error: "unusable-material" };
    }
    switch (envelopeCode(error)) {
      case "EmptyPassword":
        return { ok: false, error: "empty" };
      case "UnpairedSurrogate":
      case "NotString":
        return { ok: false, error: "invalid-password" };
      case "InvalidParams":
      case "NotUint32":
      case "WrongLength":
        return { ok: false, error: "unusable-material" };
      default:
        return { ok: false, error: "could-not-derive" };
    }
  } finally {
    try {
      credential?.free();
    } catch {
      // After a trap the poisoned loader throws on every call, free included. That's why these catch are empty
    }
    try {
      wrapParams?.free();
    } catch {
      // After a trap the poisoned loader throws on every call, free included. That's why these catch are empty
    }
  }
};

export const openMasterKey: OpenMasterKey = (
  env: Envelope,
  kek: OwnerKek,
  material: OwnerKeyMaterial,
) => {
  let wrapped: WrappedMaster | undefined;
  let master: MasterKey | undefined;
  try {
    wrapped = env.WrappedMaster.fromParts(
      decodeBase64url(material.wrapped_master, 48),
      decodeBase64url(material.wrap_nonce, 24),
    );
    master = env.unwrapMasterKey(kek, wrapped);
    return {
      ok: true,
      master,
    };
  } catch (error) {
    if (
      error instanceof MalformedEncodingError ||
      error instanceof MalformedId
    ) {
      return { ok: false, error: "unusable-material" };
    }
    switch (envelopeCode(error)) {
      case "AuthenticationFailed":
      case "UnexpectedKeyLength":
        return { ok: false, error: "cannot-unlock" };
      case "WrongLength":
      case "UnexpectedWrappedLength":
        return { ok: false, error: "unusable-material" };
      default:
        return { ok: false, error: "could-not-derive" };
    }
  } finally {
    try {
      kek.free();
    } catch {
      // After a trap the poisoned loader throws on every call, free included. That's why these catch are empty
    }
    try {
      wrapped?.free();
    } catch {
      // After a trap the poisoned loader throws on every call, free included. That's why these catch are empty
    }
  }
};

export const unlockMasterKey: UnlockMasterKey = async (
  env: Envelope,
  password: string,
  material: OwnerKeyMaterial,
) => {
  let wrapped: WrappedMaster | undefined;
  let params: WrapParams | undefined;
  let credential: OwnerCredential | undefined;
  let kek: OwnerKek | undefined;
  let master: MasterKey | undefined;
  try {
    const kdfSalt = decodeBase64url(material.kdf_salt, 16);
    wrapped = env.WrappedMaster.fromParts(
      decodeBase64url(material.wrapped_master, 48),
      decodeBase64url(material.wrap_nonce, 24),
    );

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
    credential = env.deriveOwnerCredential(password, kdfSalt, params);
    kek = credential.intoKek();
    credential = undefined;

    master = env.unwrapMasterKey(kek, wrapped);

    return {
      ok: true,
      master,
    };
  } catch (error) {
    if (
      error instanceof MalformedEncodingError ||
      error instanceof MalformedId
    ) {
      return { ok: false, error: "unusable-material" };
    }
    switch (envelopeCode(error)) {
      case "EmptyPassword":
        return { ok: false, error: "empty" };
      case "AuthenticationFailed":
      case "UnpairedSurrogate":
        return { ok: false, error: "wrong-password" };
      case "InvalidParams":
      case "WrongLength":
      case "UnexpectedKeyLength":
      case "NotUint32":
        return { ok: false, error: "unusable-material" };
      default:
        return { ok: false, error: "could-not-derive" };
    }
  } finally {
    try {
      credential?.free();
    } catch {
      // After a trap the poisoned loader throws on every call, free included. That's why these catch are empty
    }
    try {
      params?.free();
    } catch {
      // After a trap the poisoned loader throws on every call, free included. That's why these catch are empty
    }
    try {
      wrapped?.free();
    } catch {
      // After a trap the poisoned loader throws on every call, free included. That's why these catch are empty
    }
    try {
      kek?.free();
    } catch {
      // After a trap the poisoned loader throws on every call, free included. That's why these catch are empty
    }
  }
};

export const createAlbumKey: CreateAlbumKey = (
  env: Envelope,
  master: MasterKey,
  albumId: string,
) => {
  let albumKey: AlbumKey | undefined;
  let wrappedAlbumKey: MasterWrappedKey | undefined;
  try {
    albumKey = env.AlbumKey.generate();
    wrappedAlbumKey = env.wrapAlbumKeyWithMaster(
      albumKey,
      master,
      uuidToBytes(albumId),
    );
    const wrapNonce = wrappedAlbumKey.wrapNonce;
    const wrapped = wrappedAlbumKey.wrapped;
    return {
      ok: true,
      albumKey,
      wrapNonce: wrapNonce,
      wrappedKey: wrapped,
    };
  } catch (error) {
    try {
      albumKey?.free();
    } catch {
      // After a trap the poisoned loader throws on every call, free included. That's why these catch are empty
    }
    return { ok: false, error: "could-not-derive" };
  } finally {
    try {
      wrappedAlbumKey?.free();
    } catch {
      // After a trap the poisoned loader throws on every call, free included. That's why these catch are empty
    }
  }
};

export const createQrInvite: CreateQrInvite = async (
  env: Envelope,
  albumKey: AlbumKey,
) => {
  let raw: Uint8Array<ArrayBuffer> | undefined;
  let inviteKey: InviteKey | undefined;
  let wrappedKey: InviteWrappedKey | undefined;
  try {
    const recipientId = crypto.randomUUID();
    const recipientIdBytes = uuidToBytes(recipientId);
    raw = crypto.getRandomValues(new Uint8Array(32));
    const token = encodeBase64url(raw);
    const tokenHash = await hashToken(raw);
    raw.fill(0);
    inviteKey = env.InviteKey.generate();
    wrappedKey = env.wrapAlbumKeyForInvite(
      albumKey,
      inviteKey,
      recipientIdBytes,
    );
    const wrapped = wrappedKey.wrapped;
    const wrapNonce = wrappedKey.wrapNonce;

    const bytes = inviteKey.toInviteBytes();
    const k = encodeBase64url(bytes);
    bytes.fill(0);

    return {
      ok: true,
      invite: {
        kind: "qr",
        recipientId,
        token,
        tokenHash,
        wrapped,
        wrapNonce,
        inviteKey: k,
      },
    };
  } catch {
    return {
      ok: false,
      error: "could-not-derive",
    };
  } finally {
    raw?.fill(0);
    // After a trap the poisoned loader throws on every call, free included.
    try {
      wrappedKey?.free();
    } catch {}
    try {
      inviteKey?.free();
    } catch {}
  }
};

const WORDLIST_MIN_LENGTH = 7776;
export const PASSPHRASE_WORDS = 5;

export const createPassphraseInvite: CreatePassphraseInvite = async (
  env: Envelope,
  albumKey: AlbumKey,
  wordlist: Wordlist,
) => {
  let raw: Uint8Array<ArrayBuffer> | undefined;
  let params: WrapParams | undefined;
  let wrappedKey: WrappedKey | undefined;
  try {
    const n = wordlist.words.length;
    if (n < WORDLIST_MIN_LENGTH) {
      return { ok: false, error: "unusable-wordlist" };
    }
    const words = Array.from(
      { length: PASSPHRASE_WORDS },
      () => wordlist.words[uniformIndex(n, (b) => crypto.getRandomValues(b))]!,
    );

    const passphrase = words.join(" ");
    const recipientId = crypto.randomUUID();
    const recipientIdBytes = uuidToBytes(recipientId);
    raw = crypto.getRandomValues(new Uint8Array(32));
    const token = encodeBase64url(raw);
    const tokenHash = await hashToken(raw);
    raw.fill(0);

    params = new env.WrapParams(
      RECIPIENT_KDF_V1.memoryKib,
      RECIPIENT_KDF_V1.iterations,
      RECIPIENT_KDF_V1.parallelism,
    );
    wrappedKey = env.wrapAlbumKey(
      albumKey,
      passphrase,
      params,
      recipientIdBytes,
    );
    const wrapped = wrappedKey.wrapped;
    const wrapNonce = wrappedKey.wrapNonce;
    const kdfSalt = wrappedKey.kdfSalt;
    wrappedKey.free();
    params.free();

    return {
      ok: true,
      invite: {
        kind: "passphrase",
        recipientId,
        token,
        tokenHash,
        wrapped,
        wrapNonce,
        kdfSalt,
        words,
        params: RECIPIENT_KDF_V1,
      },
    };
  } catch {
    return {
      ok: false,
      error: "could-not-derive",
    };
  } finally {
    raw?.fill(0);
    // After a trap the poisoned loader throws on every call, free included.
    try {
      wrappedKey?.free();
    } catch {}
    try {
      params?.free();
    } catch {}
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

export async function hashToken(raw: Uint8Array<ArrayBuffer>) {
  if (raw.length !== 32) {
    throw Error("Raw token wrong length");
  }
  return new Uint8Array(await crypto.subtle.digest("SHA-256", raw));
}

/** A uniform index in [0, n): rejection sampling, never a bare `% n` (see above). */
export function uniformIndex(
  n: number,
  fill: (b: Uint32Array<ArrayBuffer>) => void,
): number {
  if (!Number.isInteger(n) || n < 1 || n > 2 ** 32)
    throw new RangeError("n out of range");
  const limit = 2 ** 32 - (2 ** 32 % n);
  const buf = new Uint32Array(1);
  for (;;) {
    fill(buf);
    if (buf[0]! < limit) return buf[0]! % n;
  }
}

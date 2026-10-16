/*
 * The owner's six key functions (./owner-open.ts) against the real envelope
 * build. The session tests (lib/owner/session.test.ts) run against fakes, so
 * this file is the only place that checks the real functions: that a handle
 * returned on success is alive, that a handle handed in is left alone, that
 * the KEK is freed, and that each failure lands on the error the session maps
 * to the right screen.
 *
 * A handle is "alive" if the binding still accepts it, and "freed" if a
 * second free() throws. Keys expose no bytes, so a successful unwrap is shown
 * by a round trip.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { loadEnvelope, type Envelope, type Poison } from "$lib/envelope";
import { uuidToBytes } from "$lib/ids";
import { encodeBase64url, OWNER_KDF_V1 } from "@vitrina/shared";
import { createAccountKeys, createAlbumKey, deriveLoginCredential, openAlbumKey, openMasterKey, unlockMasterKey } from "./owner-open";
import type { MasterKey, OwnerKeyMaterial, SignupKeys } from "./owner-types";

const PASSWORD = "copper kettle under the stairs 47";
const ALBUM = "6f1c2a8e-3b4d-4e5f-8a9b-0c1d2e3f4a5b";
const OTHER_ALBUM = "7a2d3b9f-4c5e-4f60-9bac-1d2e3f4a5b6c";
const SLOW = 60_000;

let env: Envelope;
let poison: Poison;
let account: SignupKeys;
let material: OwnerKeyMaterial;

/** The OwnerKeyMaterial GET /v1/owner/key would return for a signup's keys. */
const materialOf = (k: { kdfSalt: Uint8Array; params: typeof OWNER_KDF_V1; wrappedMaster: Uint8Array; wrapNonce: Uint8Array }): OwnerKeyMaterial => ({
  kdf_salt: encodeBase64url(k.kdfSalt),
  kdf_memory_kib: k.params.memoryKib,
  kdf_iterations: k.params.iterations,
  kdf_parallelism: k.params.parallelism,
  wrapped_master: encodeBase64url(k.wrappedMaster),
  wrap_nonce: encodeBase64url(k.wrapNonce),
});

/** The binding still accepts it as K_master. */
function alive(master: MasterKey): boolean {
  const probe = env.AlbumKey.generate();
  try {
    env.wrapAlbumKeyWithMaster(probe, master, uuidToBytes(ALBUM)).free();
    return true;
  } catch {
    return false;
  } finally {
    try {
      probe.free();
    } catch {
      // A call refused mid-borrow (a dead `master`) can leave the probe unfreeable; it is test-local.
    }
  }
}

/** Already freed: a second free() is refused. */
const freed = (h: { free(): void }): boolean => {
  try {
    h.free();
    return false;
  } catch {
    return true;
  }
};

/** A fresh KEK from the binding, for the openMasterKey tests. */
function kekFor(password: string) {
  const params = new env.WrapParams(OWNER_KDF_V1.memoryKib, OWNER_KDF_V1.iterations, OWNER_KDF_V1.parallelism);
  try {
    return env.deriveOwnerCredential(password, account.kdfSalt, params).intoKek();
  } finally {
    params.free();
  }
}

async function timed<T>(f: () => Promise<T>): Promise<{ value: T; ms: number }> {
  const t = performance.now();
  const value = await f();
  return { value, ms: performance.now() - t };
}

beforeAll(async () => {
  ({ envelope: env, poison } = await loadEnvelope());
  const r = await createAccountKeys(env, PASSWORD);
  if (!r.ok) throw new Error(`signup failed: ${r.error}`);
  account = r.keys;
  material = materialOf(account);
}, SLOW);

describe("createAccountKeys (flows §3.2)", () => {
  it("returns a live K_master and the body's fields at their lengths", () => {
    expect(alive(account.master)).toBe(true);
    expect(account.proof).toHaveLength(32);
    expect(account.kdfSalt).toHaveLength(16);
    expect(account.wrappedMaster).toHaveLength(48);
    expect(account.wrapNonce).toHaveLength(24);
    expect(account.params).toEqual(OWNER_KDF_V1);
    expect(Object.keys(account).sort()).toEqual(["kdfSalt", "master", "params", "proof", "wrapNonce", "wrappedMaster"]);
  });

  it("draws a fresh salt and K_master each time", async () => {
    const again = await createAccountKeys(env, PASSWORD);
    if (!again.ok) throw new Error(again.error);
    expect(encodeBase64url(again.keys.kdfSalt)).not.toBe(encodeBase64url(account.kdfSalt));
    expect(encodeBase64url(again.keys.proof)).not.toBe(encodeBase64url(account.proof));
    again.keys.master.free();
  }, SLOW);

  it("refuses the empty string, and an unpaired surrogate as an invalid password", async () => {
    expect(await createAccountKeys(env, "")).toEqual({ ok: false, error: "empty" });
    expect(await createAccountKeys(env, "abcdefghijkl\uD800")).toEqual({ ok: false, error: "invalid-password" });
  });
});

describe("deriveLoginCredential and openMasterKey (flows §3.3)", () => {
  it("derives the proof signup sent, and a KEK that opens K_master", async () => {
    const d = await deriveLoginCredential(env, PASSWORD, material);
    if (!d.ok) throw new Error(`derive failed: ${d.error}`);
    expect(encodeBase64url(d.proof)).toBe(encodeBase64url(account.proof));
    const o = openMasterKey(env, d.kek, material);
    if (!o.ok) throw new Error(`open failed: ${o.error}`);
    expect(alive(o.master)).toBe(true);
    expect(freed(d.kek), "openMasterKey frees the KEK on success").toBe(true);
    o.master.free();
  }, SLOW);

  it("a wrong password derives a different proof (the relay answers 401)", async () => {
    const d = await deriveLoginCredential(env, "not the password", material);
    if (!d.ok) throw new Error(d.error);
    expect(encodeBase64url(d.proof)).not.toBe(encodeBase64url(account.proof));
    d.kek.free();
  }, SLOW);

  it("refuses parameters over the ceiling without running Argon2id", async () => {
    const { value, ms } = await timed(() => deriveLoginCredential(env, PASSWORD, { ...material, kdf_memory_kib: 1_000_000 }));
    expect(value).toEqual({ ok: false, error: "unusable-material" });
    expect(ms).toBeLessThan(200);
  });

  it("maps malformed parameters to unusable-material", async () => {
    for (const bad of [{ kdf_salt: "!!" }, { kdf_salt: encodeBase64url(new Uint8Array(15)) }, { kdf_iterations: 0 }, { kdf_iterations: 1.5 }, { kdf_memory_kib: -1 }]) {
      expect(await deriveLoginCredential(env, PASSWORD, { ...material, ...bad }), JSON.stringify(bad)).toEqual({ ok: false, error: "unusable-material" });
    }
  });

  it("refuses the empty string, and an unpaired surrogate as an invalid password", async () => {
    expect(await deriveLoginCredential(env, "", material)).toEqual({ ok: false, error: "empty" });
    expect(await deriveLoginCredential(env, "x\uDC00", material)).toEqual({ ok: false, error: "invalid-password" });
  });

  it("returns a live K_master and frees the KEK, with a KEK made by the binding directly", () => {
    const kek = kekFor(PASSWORD);
    const o = openMasterKey(env, kek, material);
    if (!o.ok) throw new Error(`open failed: ${o.error}`);
    expect(alive(o.master), "the returned K_master is not freed").toBe(true);
    expect(freed(kek)).toBe(true);
    o.master.free();
  }, SLOW);

  it("a KEK that does not open K_master is cannot-unlock, never a password error, and the KEK is freed", () => {
    const kek = kekFor("a different password entirely");
    expect(openMasterKey(env, kek, material)).toEqual({ ok: false, error: "cannot-unlock" });
    expect(freed(kek)).toBe(true);
  }, SLOW);

  it("malformed material is unusable-material, and the KEK is still freed", () => {
    for (const bad of [{ wrapped_master: "!!" }, { wrap_nonce: encodeBase64url(new Uint8Array(23)) }]) {
      const kek = kekFor(PASSWORD);
      expect(openMasterKey(env, kek, { ...material, ...bad }), JSON.stringify(bad)).toEqual({ ok: false, error: "unusable-material" });
      expect(freed(kek)).toBe(true);
    }
  }, SLOW);
});

describe("unlockMasterKey (flows §3.1)", () => {
  it("opens K_master with the right password", async () => {
    const u = await unlockMasterKey(env, PASSWORD, material);
    if (!u.ok) throw new Error(`unlock failed: ${u.error}`);
    expect(alive(u.master)).toBe(true);
    u.master.free();
  }, SLOW);

  it("a wrong password is wrong-password, and so is whitespace, which derives", async () => {
    expect(await unlockMasterKey(env, "not the password", material)).toEqual({ ok: false, error: "wrong-password" });
    // Encryption spec §6.6.2: reject "" and nothing else. "   " is a legal password.
    expect(await unlockMasterKey(env, "   ", material)).toEqual({ ok: false, error: "wrong-password" });
    expect(await unlockMasterKey(env, "x\uD800", material)).toEqual({ ok: false, error: "wrong-password" });
  }, SLOW);

  it("refuses the empty string before deriving", async () => {
    expect(await unlockMasterKey(env, "", material)).toEqual({ ok: false, error: "empty" });
  });

  it("applies no password policy: a short password opens an account made with it", async () => {
    const short = await createAccountKeys(env, "abc");
    if (!short.ok) throw new Error(short.error);
    const u = await unlockMasterKey(env, "abc", materialOf(short.keys));
    expect(u.ok).toBe(true);
    if (u.ok) u.master.free();
    short.keys.master.free();
  }, SLOW);

  it("derives with the row's own parameters, not v1's", async () => {
    // An account written with t = 4, as a raised Phase 2 default would write it.
    const master = env.MasterKey.generate();
    const salt = new Uint8Array(16).fill(9);
    const params = new env.WrapParams(OWNER_KDF_V1.memoryKib, 4, 1);
    const kek = env.deriveOwnerCredential(PASSWORD, salt, params).intoKek();
    const wrapped = env.wrapMasterKey(kek, master);
    const row = materialOf({ kdfSalt: salt, params: { ...OWNER_KDF_V1, iterations: 4 }, wrappedMaster: wrapped.wrapped, wrapNonce: wrapped.wrapNonce });
    for (const h of [kek, wrapped, params, master]) h.free();
    const u = await unlockMasterKey(env, PASSWORD, row);
    expect(u.ok).toBe(true);
    if (u.ok) u.master.free();
  }, SLOW);

  it("refuses parameters over the ceiling without running Argon2id", async () => {
    const { value, ms } = await timed(() => unlockMasterKey(env, PASSWORD, { ...material, kdf_iterations: 100 }));
    expect(value).toEqual({ ok: false, error: "unusable-material" });
    expect(ms).toBeLessThan(200);
  });

  it("malformed material is unusable-material, never wrong-password", async () => {
    for (const bad of [{ kdf_salt: "!!" }, { wrapped_master: "!!" }, { wrap_nonce: "" }, { kdf_parallelism: 0 }]) {
      expect(await unlockMasterKey(env, PASSWORD, { ...material, ...bad }), JSON.stringify(bad)).toEqual({ ok: false, error: "unusable-material" });
    }
  });
});

describe("createAlbumKey and openAlbumKey (flows §3.4, §3.5)", () => {
  it("creates a key whose wrapping opens again to the same key, and leaves K_master alive", () => {
    const c = createAlbumKey(env, account.master, ALBUM);
    if (!c.ok) throw new Error(c.error);
    expect(c.wrappedKey).toHaveLength(48);
    expect(c.wrapNonce).toHaveLength(24);
    expect(alive(account.master), "the given K_master is not freed").toBe(true);
    const o = openAlbumKey(env, account.master, { id: ALBUM, wrapped_key: encodeBase64url(c.wrappedKey), wrap_nonce: encodeBase64url(c.wrapNonce) });
    if (!o.ok) throw new Error(o.error);
    const blob = env.encryptAlbumTitle(c.albumKey, uuidToBytes(ALBUM), "Verano 2026");
    expect(env.decryptAlbumTitle(o.albumKey, uuidToBytes(ALBUM), blob)).toBe("Verano 2026");
    expect(alive(account.master), "openAlbumKey does not free it either").toBe(true);
    c.albumKey.free();
    o.albumKey.free();
  });

  it("draws a fresh K_album and nonce each time", () => {
    const a = createAlbumKey(env, account.master, ALBUM);
    const b = createAlbumKey(env, account.master, ALBUM);
    if (!a.ok || !b.ok) throw new Error("create failed");
    expect(encodeBase64url(a.wrappedKey)).not.toBe(encodeBase64url(b.wrappedKey));
    expect(encodeBase64url(a.wrapNonce)).not.toBe(encodeBase64url(b.wrapNonce));
    a.albumKey.free();
    b.albumKey.free();
  });

  it("a wrapping moved to another album id, or opened under another K_master, is cannot-open", () => {
    const c = createAlbumKey(env, account.master, ALBUM);
    if (!c.ok) throw new Error(c.error);
    const row = { wrapped_key: encodeBase64url(c.wrappedKey), wrap_nonce: encodeBase64url(c.wrapNonce) };
    expect(openAlbumKey(env, account.master, { id: OTHER_ALBUM, ...row })).toEqual({ ok: false, error: "cannot-open" });
    const stranger = env.MasterKey.generate();
    expect(openAlbumKey(env, stranger, { id: ALBUM, ...row })).toEqual({ ok: false, error: "cannot-open" });
    stranger.free();
    c.albumKey.free();
  });

  it("malformed rows are unusable-material", () => {
    const ok = { id: ALBUM, wrapped_key: encodeBase64url(new Uint8Array(48)), wrap_nonce: encodeBase64url(new Uint8Array(24)) };
    for (const bad of [{ id: "nope" }, { id: ALBUM.toUpperCase() }, { wrapped_key: "!!" }, { wrapped_key: encodeBase64url(new Uint8Array(47)) }, { wrap_nonce: "" }]) {
      expect(openAlbumKey(env, account.master, { ...ok, ...bad }), JSON.stringify(bad)).toEqual({ ok: false, error: "unusable-material" });
    }
  });

  it("an id that is not a uuid is could-not-derive, the one failure its signature has", () => {
    expect(createAlbumKey(env, account.master, "nope")).toEqual({ ok: false, error: "could-not-derive" });
    expect(alive(account.master)).toBe(true);
  });
});

describe("the whole file", () => {
  it("never poisons the instance on any of the above", () => {
    expect(poison.poisoned).toBe(false);
  });
});

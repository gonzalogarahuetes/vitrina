/*
 * Acceptance tests for the owner's two invite functions (approved 22 October
 * 2026) against the real envelope build, written before the implementations
 * as failing-test suggestions: each says what the real function must do.
 *
 * Keys expose no bytes, so "wraps K_album" is shown by a round trip through
 * the recipient's own open functions (./open.ts) and a label sealed under the
 * original K_album opening under the unwrapped one.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { loadEnvelope, type Envelope } from "$lib/envelope";
import { uuidToBytes } from "$lib/ids";
import { decodeBase64url, encodeBase64url, RECIPIENT_KDF_V1 } from "@vitrina/shared";
import { openInviteKey, openPassphraseKey } from "./open";
import { createPassphraseInvite, createQrInvite, hashToken, PASSPHRASE_WORDS, uniformIndex } from "./owner-open";
import type { AlbumKey, Wordlist } from "./owner-types";

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const B64_32 = /^[A-Za-z0-9_-]{43}$/;
const SLOW = 60_000;

const VECTORS = new URL("../../../../../spec/vectors/vitrina-vectors.json", import.meta.url);
const tokenVector = (JSON.parse(readFileSync(VECTORS, "utf8")) as { protocol: { token: { token_raw: string; token_base64url: string; sha256: string } } }).protocol.token;
const hex = (s: string) => Uint8Array.from(s.match(/../g) ?? [], (h) => parseInt(h, 16));
const toHex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const sha256 = (b: Uint8Array) => new Uint8Array(createHash("sha256").update(b).digest());

/** 7,776 distinct synthetic words: the minimum §6.3 allows, and not a language. */
const LIST: Wordlist = { language: "xx", words: Array.from({ length: 7776 }, (_, i) => `w${i.toString().padStart(4, "0")}`) };

let env: Envelope;
let album: AlbumKey;
const ALBUM_ID = "6f1c2a8e-3b4d-4e5f-8a9b-0c1d2e3f4a5b";

beforeAll(async () => {
  env = (await loadEnvelope()).envelope;
  album = env.AlbumKey.generate();
});

/** True if `other` is the same K_album as `album`: a title sealed under one opens under the other. */
function sameAlbumKey(other: AlbumKey): boolean {
  const blob = env.encryptAlbumTitle(album, uuidToBytes(ALBUM_ID), "probe");
  try {
    return env.decryptAlbumTitle(other, uuidToBytes(ALBUM_ID), blob) === "probe";
  } catch {
    return false;
  }
}

describe("hashToken (schema §6)", () => {
  it("is SHA-256 over the 32 raw bytes, matching the vector", async () => {
    expect(toHex(await hashToken(hex(tokenVector.token_raw)))).toBe(tokenVector.sha256);
  });
});

describe("uniformIndex (rejection sampling, never % n)", () => {
  /** A fill that hands out these 32-bit values in order, however many are asked for at once. */
  const scripted = (values: number[]) => (b: Uint32Array<ArrayBuffer>) => {
    for (let i = 0; i < b.length; i++) b[i] = values.shift() ?? 0;
  };
  const limit = (n: number) => 2 ** 32 - (2 ** 32 % n);

  it("rejects a draw in the biased tail and takes the next", () => {
    expect(uniformIndex(7776, scripted([0xffffffff, 5]))).toBe(5);
    expect(uniformIndex(7776, scripted([limit(7776), limit(7776) + 1, 7777]))).toBe(1);
  });

  it("accepts the last unbiased value", () => {
    expect(uniformIndex(7776, scripted([limit(7776) - 1]))).toBe(7775);
  });

  it("stays in [0, n) for every n, including 1 and a power of two (no tail to reject)", () => {
    expect(uniformIndex(1, scripted([0xffffffff]))).toBe(0);
    expect(uniformIndex(4096, scripted([0xffffffff]))).toBe(4095);
    for (let i = 0; i < 1000; i++) {
      const v = uniformIndex(7776, (b) => void crypto.getRandomValues(b));
      expect(Number.isInteger(v) && v >= 0 && v < 7776).toBe(true);
    }
  });
});

describe("createQrInvite (encryption spec §6.1, schema §6)", () => {
  it("makes every secret an invite needs, and the wrapping opens to this album's K_album", async () => {
    const r = await createQrInvite(env, album);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const inv = r.invite;
    expect(inv.kind).toBe("qr");
    expect(inv.recipientId).toMatch(UUID_V4);
    expect(inv.token).toMatch(B64_32);
    expect(inv.inviteKey).toMatch(B64_32);
    expect(inv.tokenHash).toHaveLength(32);
    expect(inv.wrapped).toHaveLength(48);
    expect(inv.wrapNonce).toHaveLength(24);
    expect(toHex(inv.tokenHash), "the hash is over the decoded token bytes").toBe(toHex(sha256(decodeBase64url(inv.token, 32))));
    expect(inv.token).not.toBe(inv.inviteKey);

    const opened = openInviteKey(env, decodeBase64url(inv.inviteKey, 32), { kind: "qr", id: inv.recipientId, wrapped: encodeBase64url(inv.wrapped), wrap_nonce: encodeBase64url(inv.wrapNonce) });
    expect(opened.ok).toBe(true);
    if (opened.ok) {
      expect(sameAlbumKey(opened.albumKey)).toBe(true);
      opened.albumKey.free();
    }
  });

  it("binds the id: the same wrapping under another recipient id does not open", async () => {
    const r = await createQrInvite(env, album);
    if (!r.ok) throw new Error("createQrInvite failed");
    const other = "00000000-0000-4000-8000-000000000001";
    const opened = openInviteKey(env, decodeBase64url(r.invite.inviteKey, 32), { kind: "qr", id: other, wrapped: encodeBase64url(r.invite.wrapped), wrap_nonce: encodeBase64url(r.invite.wrapNonce) });
    expect(opened).toEqual({ ok: false, error: "damaged-link" });
  });

  it("is fresh every call: a 409 retry gets a new id, token, key and nonce", async () => {
    const a = await createQrInvite(env, album);
    const b = await createQrInvite(env, album);
    if (!a.ok || !b.ok) throw new Error("createQrInvite failed");
    expect(b.invite.recipientId).not.toBe(a.invite.recipientId);
    expect(b.invite.token).not.toBe(a.invite.token);
    expect(b.invite.inviteKey).not.toBe(a.invite.inviteKey);
    expect(toHex(b.invite.wrapNonce)).not.toBe(toHex(a.invite.wrapNonce));
  });

  it("leaves the borrowed K_album alive", async () => {
    await createQrInvite(env, album);
    expect(sameAlbumKey(album)).toBe(true);
  });

  it("zeroes toInviteBytes()'s copy once encoded, and frees the InviteKey handle", async () => {
    const exportedCopies: Uint8Array[] = [];
    const handles: { free(): void }[] = [];
    const spy = new Proxy(env, {
      get(target, prop, receiver) {
        const v = Reflect.get(target, prop, receiver) as unknown;
        if (prop !== "InviteKey") return v;
        return new Proxy(v as object, {
          get(cls, p, r) {
            const m = Reflect.get(cls, p, r) as unknown;
            if (p !== "generate") return m;
            return () => {
              const h = (m as () => { toInviteBytes(): Uint8Array; free(): void })();
              handles.push(h);
              return new Proxy(h, {
                get(t, q) {
                  if (q !== "toInviteBytes") return Reflect.get(t, q, t);
                  return () => {
                    const bytes = t.toInviteBytes();
                    exportedCopies.push(bytes);
                    return bytes;
                  };
                },
              });
            };
          },
        });
      },
    }) as Envelope;
    const r = await createQrInvite(spy, album);
    expect(r.ok).toBe(true);
    expect(exportedCopies.length).toBeGreaterThan(0);
    for (const c of exportedCopies) expect(c.every((b) => b === 0), "the exported copy is zeroed").toBe(true);
    for (const h of handles) expect(() => h.free(), "the handle was freed already").toThrow();
  });
});

describe("createPassphraseInvite (encryption spec §6.2, §6.3)", () => {
  it("draws PASSPHRASE_WORDS words from the list and wraps under them with RECIPIENT_KDF_V1", async () => {
    expect(PASSPHRASE_WORDS).toBeGreaterThanOrEqual(5);
    const r = await createPassphraseInvite(env, album, LIST);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const inv = r.invite;
    expect(inv.kind).toBe("passphrase");
    expect(inv.recipientId).toMatch(UUID_V4);
    expect(inv.token).toMatch(B64_32);
    expect(toHex(inv.tokenHash)).toBe(toHex(sha256(decodeBase64url(inv.token, 32))));
    expect(inv.words).toHaveLength(PASSPHRASE_WORDS);
    for (const w of inv.words) expect(LIST.words).toContain(w);
    expect(inv.params).toEqual(RECIPIENT_KDF_V1);
    expect(inv.kdfSalt).toHaveLength(16);
    expect(inv.wrapped).toHaveLength(48);
    expect(inv.wrapNonce).toHaveLength(24);
    expect("inviteKey" in inv).toBe(false);

    const material = {
      kind: "passphrase" as const,
      id: inv.recipientId,
      kdf_salt: encodeBase64url(inv.kdfSalt),
      wrapped: encodeBase64url(inv.wrapped),
      wrap_nonce: encodeBase64url(inv.wrapNonce),
      kdf_memory_kib: inv.params.memoryKib,
      kdf_iterations: inv.params.iterations,
      kdf_parallelism: inv.params.parallelism,
    };
    const opened = await openPassphraseKey(env, inv.words.join(" "), material);
    expect(opened.ok).toBe(true);
    if (opened.ok) {
      expect(sameAlbumKey(opened.albumKey)).toBe(true);
      opened.albumKey.free();
    }
    // As a recipient types it: other case and spacing, same KEK (§6.3).
    const typed = await openPassphraseKey(env, `  ${inv.words.map((w) => w.toUpperCase()).join("   ")} `, material);
    expect(typed.ok).toBe(true);
    if (typed.ok) typed.albumKey.free();
  }, SLOW);

  it("refuses a list shorter than 7,776 words before drawing anything", async () => {
    const short: Wordlist = { language: "xx", words: LIST.words.slice(1) };
    expect(await createPassphraseInvite(env, album, short)).toEqual({ ok: false, error: "unusable-wordlist" });
  });

  it("is fresh every call: new id, token, words and salt", async () => {
    const a = await createPassphraseInvite(env, album, LIST);
    const b = await createPassphraseInvite(env, album, LIST);
    if (!a.ok || !b.ok) throw new Error("createPassphraseInvite failed");
    expect(b.invite.recipientId).not.toBe(a.invite.recipientId);
    expect(b.invite.token).not.toBe(a.invite.token);
    expect(b.invite.words).not.toEqual(a.invite.words);
    expect(toHex(b.invite.kdfSalt)).not.toBe(toHex(a.invite.kdfSalt));
    expect(sameAlbumKey(album), "the borrowed K_album is left alive").toBe(true);
  }, SLOW);
});

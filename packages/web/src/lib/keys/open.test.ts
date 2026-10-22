/*
 * openPassphraseKey and openInviteKey against the real envelope build, with
 * the passphrase-wrap vectors (category 9, `wrap`) and the invite-wrap vector
 * (category 20, `invite_wrap`) in spec/vectors/vitrina-vectors.json.
 *
 * AlbumKey exposes no bytes, so a successful unwrap is proved by a round trip:
 * a title encrypted under a key built from the vector's `k_album` must decrypt
 * under the key the function returned.
 */
import { readFileSync } from "node:fs";
import { guard, loadEnvelope } from "$lib/envelope";
import { encodeBase64url } from "@vitrina/shared";
import { describe, expect, it } from "vitest";
import { openInviteKey, openPassphraseKey } from "./open";
import type { AlbumKey, InviteKeyMaterial, PassphraseKeyMaterial } from "./types";

type WrapVector = {
  name: string;
  k_album: string;
  passphrase: string;
  salt: string;
  params: { m_cost_kib: number; t_cost: number; p_cost: number };
  recipient_id: string;
  wrap_nonce: string;
  wrapped: string;
};

const VECTORS = new URL(
  "../../../../../spec/vectors/vitrina-vectors.json",
  import.meta.url,
);
type InviteWrapVector = {
  name: string;
  k_album: string;
  k_invite: string;
  recipient_id: string;
  wrap_nonce: string;
  wrapped: string;
};

const vectorFile = JSON.parse(readFileSync(VECTORS, "utf8")) as {
  wrap: WrapVector[];
  invite_wrap: InviteWrapVector[];
};
const wrapVectors = vectorFile.wrap;
const inviteVector = vectorFile.invite_wrap[0];

const hex = (s: string) =>
  Uint8Array.from(s.match(/../g) ?? [], (h) => parseInt(h, 16));
const uuidText = (h: string) =>
  `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;

/** The vector as GET /v1/recipient/key would send it (api-sketch §10.1). */
function asMaterial(v: WrapVector): PassphraseKeyMaterial {
  return {
    kind: "passphrase",
    id: uuidText(v.recipient_id),
    kdf_salt: encodeBase64url(hex(v.salt)),
    wrapped: encodeBase64url(hex(v.wrapped)),
    wrap_nonce: encodeBase64url(hex(v.wrap_nonce)),
    kdf_memory_kib: v.params.m_cost_kib,
    kdf_iterations: v.params.t_cost,
    kdf_parallelism: v.params.p_cost,
  };
}

/** The cheapest vector, for the failure cases: only the outcome matters there. */
const cheapest = [...wrapVectors].sort(
  (x, y) => x.params.m_cost_kib - y.params.m_cost_kib,
)[0];

describe("openPassphraseKey", () => {
  it("has vectors to run", () => {
    expect(wrapVectors.length).toBeGreaterThan(0);
  });

  for (const v of wrapVectors) {
    it(`${v.name}: unwraps to the vector's k_album`, async () => {
      const { envelope } = await loadEnvelope();
      const r = await openPassphraseKey(envelope, v.passphrase, asMaterial(v));
      if (!r.ok) throw new Error(`expected success, got ${r.error}`);
      const reference = envelope.AlbumKey.fromBytes(hex(v.k_album));
      const albumId = new Uint8Array(16);
      const blob = envelope.encryptAlbumTitle(reference, albumId, "round trip");
      expect(envelope.decryptAlbumTitle(r.albumKey, albumId, blob)).toBe(
        "round trip",
      );
      reference.free();
      r.albumKey.free();
    }, 30_000);
  }

  it("normalisation is the crate's: case, accents and spacing do not matter", async () => {
    if (cheapest === undefined) throw new Error("no vectors");
    const { envelope } = await loadEnvelope();
    const shouted = `  ${cheapest.passphrase.toUpperCase()}  `;
    const r = await openPassphraseKey(envelope, shouted, asMaterial(cheapest));
    expect(r.ok).toBe(true);
    if (r.ok) r.albumKey.free();
  });

  const failures: [
    string,
    string | undefined,
    Partial<PassphraseKeyMaterial>,
    string,
  ][] = [
    ["a wrong passphrase", "definitely not it", {}, "wrong-passphrase"],
    ["an unpaired surrogate", "caf\uD800", {}, "wrong-passphrase"],
    ["an entry that is empty after normalisation", "   ", {}, "empty"],
    [
      "a 15-byte salt",
      undefined,
      { kdf_salt: encodeBase64url(new Uint8Array(15)) },
      "unusable-material",
    ],
    [
      "a non-canonical wrap_nonce",
      undefined,
      { wrap_nonce: "!".repeat(32) },
      "unusable-material",
    ],
    [
      "a wrapped of the wrong length",
      undefined,
      { wrapped: encodeBase64url(new Uint8Array(47)) },
      "unusable-material",
    ],
    [
      "an id that is not a uuid",
      undefined,
      { id: "nope" },
      "unusable-material",
    ],
    [
      "a fractional memory cost",
      undefined,
      { kdf_memory_kib: 1.5 },
      "unusable-material",
    ],
    [
      "parameters Argon2id refuses",
      undefined,
      { kdf_memory_kib: 1 },
      "unusable-material",
    ],
  ];

  for (const [what, passphrase, patch, expected] of failures) {
    it(`${what} → ${expected}`, async () => {
      if (cheapest === undefined) throw new Error("no vectors");
      const { envelope } = await loadEnvelope();
      const r = await openPassphraseKey(
        envelope,
        passphrase ?? cheapest.passphrase,
        { ...asMaterial(cheapest), ...patch },
      );
      expect(r).toEqual({ ok: false, error: expected });
    });
  }

  /*
   * Ceilings on the relay's Argon2id parameters (open.ts): a corrupted or buggy
   * row must not freeze the tab. Three limits, each tested at its boundary:
   * exactly at the limit derives, one above is refused before any WrapParams
   * is built, so Argon2id never starts. Keep these numbers in step with
   * open.ts: they are an interop rule, not a tuning knob.
   */
  describe("parameter ceilings", () => {
    const MAX_MEMORY_KIB = 131_072; // 128 MiB, twice v1
    const MAX_PARALLELISM = 4;
    const MAX_COST = 786_432; // memory × iterations: four times v1's 65,536 × 3

    /** The real module, except that deriving is recorded and never actually run. */
    async function spying() {
      const { envelope } = await loadEnvelope();
      const calls = { wrapParams: 0, unwrap: 0 };
      const env = {
        ...envelope,
        WrapParams: class {
          constructor(m: number, t: number, p: number) {
            calls.wrapParams++;
            return new envelope.WrapParams(m, t, p);
          }
        },
        unwrapAlbumKey: () => {
          calls.unwrap++;
          throw Object.assign(new Error("authentication failed"), {
            name: "EnvelopeError",
            code: "AuthenticationFailed",
          });
        },
      } as unknown as typeof envelope;
      return { env, calls };
    }

    type Params = Pick<
      PassphraseKeyMaterial,
      "kdf_memory_kib" | "kdf_iterations" | "kdf_parallelism"
    >;
    const P = (
      kdf_memory_kib: number,
      kdf_iterations: number,
      kdf_parallelism = 1,
    ): Params => ({ kdf_memory_kib, kdf_iterations, kdf_parallelism });

    async function attempt(params: Params) {
      if (cheapest === undefined) throw new Error("no vectors");
      const { env, calls } = await spying();
      const result = await openPassphraseKey(env, cheapest.passphrase, {
        ...asMaterial(cheapest),
        ...params,
      });
      return { result, calls };
    }

    async function accepted(params: Params) {
      const { result, calls } = await attempt(params);
      // The spy's unwrap was reached, so the parameters were let through.
      expect(result).toEqual({ ok: false, error: "wrong-passphrase" });
      expect(calls.unwrap).toBe(1);
    }

    async function refused(params: Params) {
      const { result, calls } = await attempt(params);
      expect(result).toEqual({ ok: false, error: "unusable-material" });
      expect(calls).toEqual({ wrapParams: 0, unwrap: 0 });
    }

    // Each "one above" case breaks exactly one limit and stays inside the other two.
    describe("memory: 128 MiB", () => {
      it("exactly at the limit is accepted", () =>
        accepted(P(MAX_MEMORY_KIB, 1)));
      it("one KiB above is refused", () => refused(P(MAX_MEMORY_KIB + 1, 1)));
    });

    describe("parallelism: 4", () => {
      it("exactly at the limit is accepted", () =>
        accepted(P(65_536, 3, MAX_PARALLELISM)));
      it("one above is refused", () =>
        refused(P(65_536, 3, MAX_PARALLELISM + 1)));
    });

    describe("cost, memory × iterations: four times v1", () => {
      it("exactly at the limit is accepted (64 MiB × 12)", () =>
        accepted(P(65_536, MAX_COST / 65_536)));
      it("exactly at the limit is accepted (128 MiB × 6)", () =>
        accepted(P(MAX_MEMORY_KIB, MAX_COST / MAX_MEMORY_KIB)));
      it("one iteration above is refused (64 MiB × 13)", () =>
        refused(P(65_536, MAX_COST / 65_536 + 1)));
      it("one iteration above is refused (128 MiB × 7), with memory still at its limit", () =>
        refused(P(MAX_MEMORY_KIB, MAX_COST / MAX_MEMORY_KIB + 1)));
    });

    it("a corrupted row's 1,000,000 iterations never reaches Argon2id", () =>
      refused(P(65_536, 1_000_000)));
    it("256 MiB × 3 is refused", () => refused(P(262_144, 3)));
  });

  it("a trap is could-not-derive, never wrong-passphrase", async () => {
    if (cheapest === undefined) throw new Error("no vectors");
    const { envelope } = await loadEnvelope();
    // A separate guard over a module whose unwrap traps: the real one stays unpoisoned.
    const { envelope: trapping, poison } = guard({
      ...envelope,
      unwrapAlbumKey: () => {
        throw new RangeError("Out of memory");
      },
    } as typeof envelope);
    const r = await openPassphraseKey(
      trapping,
      cheapest.passphrase,
      asMaterial(cheapest),
    );
    expect(r).toEqual({ ok: false, error: "could-not-derive" });
    expect(poison.poisoned).toBe(true);
  });

  it("frees the handles it made, on success and on failure", async () => {
    if (cheapest === undefined) throw new Error("no vectors");
    const { envelope } = await loadEnvelope();
    const freed: string[] = [];
    const watch = <T extends object>(name: string, make: () => T): T => {
      const h = make() as T & { free(): void };
      const free = h.free.bind(h);
      h.free = () => {
        freed.push(name);
        free();
      };
      return h;
    };
    const spying = {
      ...envelope,
      WrapParams: class {
        constructor(m: number, t: number, p: number) {
          return watch("params", () => new envelope.WrapParams(m, t, p));
        }
      },
      WrappedKey: {
        fromParts: (...a: Parameters<typeof envelope.WrappedKey.fromParts>) =>
          watch("wrappedKey", () => envelope.WrappedKey.fromParts(...a)),
      },
    } as unknown as typeof envelope;

    const ok = await openPassphraseKey(
      spying,
      cheapest.passphrase,
      asMaterial(cheapest),
    );
    expect(ok.ok).toBe(true);
    expect(freed.sort()).toEqual(["params", "wrappedKey"]);
    if (ok.ok) ok.albumKey.free();

    freed.length = 0;
    const wrong = await openPassphraseKey(
      spying,
      "definitely not it",
      asMaterial(cheapest),
    );
    expect(wrong.ok).toBe(false);
    expect(freed.sort()).toEqual(["params", "wrappedKey"]);
  });
});

describe("openInviteKey", () => {
  if (inviteVector === undefined) throw new Error("no category 20 vector");
  const v = inviteVector;

  /** The vector as GET /v1/recipient/key sends it for a QR recipient (api-sketch §10.1). */
  const material = (patch: Partial<InviteKeyMaterial> = {}): InviteKeyMaterial => ({
    kind: "qr",
    id: uuidText(v.recipient_id),
    wrapped: encodeBase64url(hex(v.wrapped)),
    wrap_nonce: encodeBase64url(hex(v.wrap_nonce)),
    ...patch,
  });

  /** A fresh copy each time: openInviteKey zeroes what it is given. */
  const inviteKey = () => hex(v.k_invite);

  /** Proves `key` is the vector's K_album by what it decrypts. */
  async function assertIsTheAlbumKey(key: AlbumKey) {
    const { envelope } = await loadEnvelope();
    const reference = envelope.AlbumKey.fromBytes(hex(v.k_album));
    const albumId = new Uint8Array(16);
    const blob = envelope.encryptAlbumTitle(reference, albumId, "round trip");
    expect(envelope.decryptAlbumTitle(key, albumId, blob)).toBe("round trip");
    reference.free();
  }

  /** One byte of a base64url field's decoded value flipped, re-encoded canonically. */
  const flipped = (field: string, at: number) => {
    const bytes = hex(field);
    bytes[at]! ^= 0x01;
    return encodeBase64url(bytes);
  };

  it(`${v.name}: unwraps to the vector's k_album, synchronously`, async () => {
    const { envelope } = await loadEnvelope();
    const r = openInviteKey(envelope, inviteKey(), material());
    if (!r.ok) throw new Error(r.error);
    await assertIsTheAlbumKey(r.albumKey);
    r.albumKey.free();
  });

  it("zeroes the invite key on success", async () => {
    const { envelope } = await loadEnvelope();
    const key = inviteKey();
    const r = openInviteKey(envelope, key, material());
    expect(Array.from(key)).toEqual(new Array(32).fill(0));
    if (r.ok) r.albumKey.free();
  });

  const failures: [string, Partial<InviteKeyMaterial>, string][] = [
    // AuthenticationFailed: the link and the relay's answer do not belong together.
    ["another recipient id in the AAD", { id: uuidText(v.recipient_id.slice(0, 30) + "35") }, "damaged-link"],
    ["a flipped byte of wrapped (in the tag)", { wrapped: flipped(v.wrapped, 47) }, "damaged-link"],
    ["a flipped byte of wrapped (in the ciphertext)", { wrapped: flipped(v.wrapped, 0) }, "damaged-link"],
    ["a flipped byte of wrap_nonce", { wrap_nonce: flipped(v.wrap_nonce, 0) }, "damaged-link"],
    // The relay's answer is unusable before any key is tried.
    ["a non-canonical wrap_nonce", { wrap_nonce: "!".repeat(32) }, "unusable-material"],
    ["a 47-byte wrapped", { wrapped: encodeBase64url(new Uint8Array(47)) }, "unusable-material"],
    ["a 49-byte wrapped", { wrapped: encodeBase64url(new Uint8Array(49)) }, "unusable-material"],
    ["a 23-byte wrap_nonce", { wrap_nonce: encodeBase64url(new Uint8Array(23)) }, "unusable-material"],
    ["padded base64url", { wrapped: `${encodeBase64url(hex(v.wrapped))}=` }, "unusable-material"],
    ["an id that is not a uuid", { id: "nope" }, "unusable-material"],
  ];

  for (const [what, patch, expected] of failures) {
    it(`${what} → ${expected}, and the invite key is zeroed`, async () => {
      const { envelope } = await loadEnvelope();
      const key = inviteKey();
      expect(openInviteKey(envelope, key, material(patch))).toEqual({ ok: false, error: expected });
      expect(Array.from(key)).toEqual(new Array(32).fill(0));
    });
  }

  it("a wrong K_invite is damaged-link", async () => {
    const { envelope } = await loadEnvelope();
    const other = inviteKey();
    other[0]! ^= 0x01;
    expect(openInviteKey(envelope, other, material())).toEqual({ ok: false, error: "damaged-link" });
  });

  it("an invite key of the wrong length is could-not-derive, not unusable-material: the relay did not cause it", async () => {
    const { envelope } = await loadEnvelope();
    const short = new Uint8Array(31).fill(7);
    expect(openInviteKey(envelope, short, material())).toEqual({ ok: false, error: "could-not-derive" });
    expect(Array.from(short)).toEqual(new Array(31).fill(0));
  });

  it("a trap is could-not-derive, never damaged-link", async () => {
    const { envelope } = await loadEnvelope();
    // A separate guard over a module whose unwrap traps: the real one stays unpoisoned.
    const { envelope: trapping, poison } = guard({
      ...envelope,
      unwrapAlbumKeyWithInvite: () => {
        throw new RangeError("Out of memory");
      },
    } as typeof envelope);
    const key = inviteKey();
    expect(openInviteKey(trapping, key, material())).toEqual({ ok: false, error: "could-not-derive" });
    expect(poison.poisoned).toBe(true);
    expect(Array.from(key)).toEqual(new Array(32).fill(0));
  });

  it("frees the handles it made, on success and on failure", async () => {
    const { envelope } = await loadEnvelope();
    const freed: string[] = [];
    const watch = <T extends object>(name: string, make: () => T): T => {
      const h = make() as T & { free(): void };
      const free = h.free.bind(h);
      h.free = () => {
        freed.push(name);
        free();
      };
      return h;
    };
    const spying = {
      ...envelope,
      InviteKey: {
        fromBytes: (...a: Parameters<typeof envelope.InviteKey.fromBytes>) =>
          watch("inviteKey", () => envelope.InviteKey.fromBytes(...a)),
      },
      InviteWrappedKey: {
        fromParts: (...a: Parameters<typeof envelope.InviteWrappedKey.fromParts>) =>
          watch("wrappedKey", () => envelope.InviteWrappedKey.fromParts(...a)),
      },
    } as unknown as typeof envelope;

    const ok = openInviteKey(spying, inviteKey(), material());
    expect(ok.ok).toBe(true);
    expect(freed.sort()).toEqual(["inviteKey", "wrappedKey"]);
    if (ok.ok) ok.albumKey.free();

    freed.length = 0;
    const wrong = openInviteKey(spying, inviteKey(), material({ wrapped: flipped(v.wrapped, 47) }));
    expect(wrong).toEqual({ ok: false, error: "damaged-link" });
    expect(freed.sort()).toEqual(["inviteKey", "wrappedKey"]);
  });
});

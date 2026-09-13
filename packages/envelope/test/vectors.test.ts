// Encryption spec §9: "CI MUST run every vector against every implementation,
// not only against the Rust crate." This file is the second implementation.
// spec/vectors/vitrina-vectors.json is read, never written.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { REPO_ROOT, caught, hex, loadEnvelope, unhex } from "./load.js";
import type { AlbumKey } from "./load.js";

interface Params {
  m_cost_kib: number;
  t_cost: number;
  p_cost: number;
}
interface EnvelopeVector {
  category: number;
  name: string;
  k_album: string;
  asset_id: string;
  base_nonce: string;
  chunk_size: number;
  plaintext: string;
  object: string;
  expect: "accept" | "reject";
}
interface NegativeVector {
  category: number;
  name: string;
  k_album: string;
  asset_id: string;
  object: string;
  expect: "accept" | "reject";
}
interface WrapVector {
  category: number;
  name: string;
  k_album: string;
  passphrase: string;
  salt: string;
  params: Params;
  recipient_id: string;
  wrap_nonce: string;
  wrapped: string;
}
interface SaltLengthVector extends Omit<WrapVector, "wrapped" | "category"> {
  vector: number;
  wrapped?: string;
  expect: "accept" | "reject";
}
interface EmptyPassphraseVector {
  vector: number;
  name: string;
  passphrase: string;
  normalized: string;
  salt: string;
  params: Params;
  expect: "accept" | "reject";
}
interface VectorFile {
  envelope_version: number;
  envelope: EnvelopeVector[];
  envelope_negative: NegativeVector[];
  key_derivation: { category: number }[];
  anchors: Record<string, { category: number }>;
  wrap: WrapVector[];
  protocol: {
    token: { vector: number; token_raw: string; token_base64url: string; sha256: string; expect: string };
    token_noncanonical: { vector: number; token_base64url: string; expect: string };
    passphrase_empty: EmptyPassphraseVector[];
    passphrase_normalisation: { vector: number; passphrase: string; normalized: string; salt: string; params: Params; kek: string };
    wrap_aad: { vector: number; recipient_id: string; aad: string };
    wrap_salt_length: SaltLengthVector[];
  };
}

const e = await loadEnvelope();
const file = JSON.parse(
  await readFile(new URL("spec/vectors/vitrina-vectors.json", REPO_ROOT), "utf8"),
) as VectorFile;

const params = (p: Params) => new e.WrapParams(p.m_cost_kib, p.t_cost, p.p_cost);

/** Every vector shares one K_album; decrypting category 1 with a key proves it is that key. */
const reference = file.envelope[0]!;
function assertIsTheAlbumKey(key: AlbumKey) {
  assert.equal(hex(e.decryptAsset(key, unhex(reference.asset_id), unhex(reference.object))), reference.plaintext);
}

test("vector file targets envelope version 1", () => {
  assert.equal(file.envelope_version, 1);
  assert.deepEqual(file.envelope.map((v) => v.category), [1, 2, 3, 4]);
  assert.deepEqual(file.envelope_negative.map((v) => v.category), [10, 11, 12, 13, 14, 15]);
});

// Categories 1–4 — decrypt direction is byte-exact. The encrypt direction
// cannot be: §4.1 draws a fresh base_nonce and the writer fixes chunk_size,
// both outside the binding's reach, so the writer's layout is asserted instead.
for (const v of file.envelope) {
  test(`category ${v.category}: ${v.name} — decrypts to the expected plaintext`, () => {
    assert.equal(v.expect, "accept");
    const key = e.AlbumKey.fromBytes(unhex(v.k_album));
    assert.equal(hex(e.decryptAsset(key, unhex(v.asset_id), unhex(v.object))), v.plaintext);
  });

  test(`category ${v.category}: ${v.name} — encrypts to the same layout and round-trips`, () => {
    const key = e.AlbumKey.fromBytes(unhex(v.k_album));
    const plaintext = unhex(v.plaintext);
    const expected = unhex(v.object);
    const object = e.encryptAsset(key, unhex(v.asset_id), plaintext);

    const chunks = Math.ceil(plaintext.length / e.chunkSize());
    assert.equal(object.length, 64 + plaintext.length + 16 * chunks);
    assert.equal(hex(object.subarray(0, 8)), hex(expected.subarray(0, 8)), "magic, version, cipher, reserved");
    assert.notEqual(hex(object.subarray(8, 24)), v.base_nonce, "base_nonce is fresh (§4.1)");
    assert.equal(hex(object.subarray(28, 64)), hex(expected.subarray(28, 64)), "plaintext_length, asset_id, padding");
    if (v.chunk_size === e.chunkSize()) {
      assert.equal(object.length, expected.length);
      assert.equal(hex(object.subarray(24, 28)), hex(expected.subarray(24, 28)), "chunk_size");
    }
    assert.equal(hex(e.decryptAsset(key, unhex(v.asset_id), object)), v.plaintext);
  });
}

/** §3.2's total_object_size, from the header's own fields (all little-endian). */
function declaredTotal(object: Uint8Array): number {
  const view = new DataView(object.buffer, object.byteOffset, object.byteLength);
  const chunkSize = view.getUint32(24, true);
  const plaintextLength = Number(view.getBigUint64(28, true));
  return 64 + plaintextLength + 16 * Math.ceil(plaintextLength / chunkSize);
}

interface NegativeExpectation {
  code: string;
  reason?: string;
  fields?: (object: Uint8Array) => Record<string, number>;
}

// Categories 10–15 — the §8 rejection each must surface, no default. 13, 14
// and 15 are header and length conditions a caller can act on; the rest are
// AEAD failures and carry no reason. 15's lengths match the crate's assertion.
const negativeExpectations: Record<number, NegativeExpectation> = {
  10: { code: "AuthenticationFailed" },
  11: { code: "AuthenticationFailed" },
  12: { code: "AuthenticationFailed" },
  13: { code: "Header", reason: "WrongVersion", fields: (o) => ({ version: o[4]! }) },
  14: { code: "Header", reason: "WrongCipher", fields: (o) => ({ cipher: o[5]! }) },
  15: { code: "ObjectTooShort", fields: (o) => ({ expected: declaredTotal(o), got: o.length }) },
};

test("every envelope_negative category has an expectation row", () => {
  const missing = file.envelope_negative.map((v) => v.category).filter((c) => !(c in negativeExpectations));
  assert.equal(missing.length, 0, `no expectation defined for category ${missing.join(", ")}`);
});

for (const v of file.envelope_negative) {
  test(`category ${v.category}: ${v.name} — rejected`, () => {
    assert.equal(v.expect, "reject");
    const expected = negativeExpectations[v.category];
    assert.ok(expected, `no expectation defined for category ${v.category}`);
    const key = e.AlbumKey.fromBytes(unhex(v.k_album));
    const object = unhex(v.object);
    const err = caught(() => e.decryptAsset(key, unhex(v.asset_id), object));
    assert.equal(err.code, expected.code);
    assert.equal(err.reason, expected.reason);
    for (const [k, value] of Object.entries(expected.fields?.(object) ?? {})) {
      assert.equal((err as unknown as Record<string, unknown>)[k], value, k);
    }
  });
}

test("categories 5–8 are primitive-level and have no binding entry point", { skip: true }, () => {
  // Key derivation and the three external anchors are verified inside the
  // crate. The binding exports no primitive, so they are exercised here only
  // transitively: categories 1–4 decrypting proves K_asset derivation agrees.
  assert.equal(file.key_derivation[0]?.category, 5);
  assert.deepEqual(Object.values(file.anchors).map((a) => a.category), [6, 7, 8]);
});

// Category 9 — unwrap direction, both parameter sets. The wrap direction draws
// its own salt and nonce (§6.2), so the vector's bytes are unreachable; the
// wrap+unwrap round trip is asserted instead.
for (const v of file.wrap) {
  test(`category 9: ${v.name} — unwraps to K_album`, () => {
    const wrapped = e.WrappedKey.fromParts(unhex(v.wrapped), unhex(v.wrap_nonce), unhex(v.salt));
    const key = e.unwrapAlbumKey(v.passphrase, params(v.params), unhex(v.recipient_id), wrapped);
    assertIsTheAlbumKey(key);
  });

  test(`category 9: ${v.name} — wrap then unwrap round-trips`, () => {
    const album = e.AlbumKey.fromBytes(unhex(v.k_album));
    const wrapped = e.wrapAlbumKey(album, v.passphrase, params(v.params), unhex(v.recipient_id));
    assert.equal(wrapped.wrapped.length, e.wrappedLen());
    assert.equal(wrapped.wrapNonce.length, e.wrapNonceLen());
    assert.equal(wrapped.kdfSalt.length, e.saltLen());
    assertIsTheAlbumKey(e.unwrapAlbumKey(v.passphrase, params(v.params), unhex(v.recipient_id), wrapped));
  });
}

// §9.1 protocol vectors 1 and 2 — vitrina-schema.md §6. The crate has no token
// code, so this is the TypeScript rule itself, run against the vector.
function strictDecodeToken(s: string): Uint8Array | undefined {
  if (s.length !== 43 || !/^[A-Za-z0-9_-]{43}$/.test(s)) return undefined;
  const bytes = Buffer.from(s, "base64url");
  if (bytes.length !== 32 || bytes.toString("base64url") !== s) return undefined;
  return new Uint8Array(bytes);
}

test("protocol 1: token hashes over the 32 raw bytes and encodes canonically", () => {
  const t = file.protocol.token;
  assert.equal(t.expect, "accept");
  const raw = unhex(t.token_raw);
  assert.equal(createHash("sha256").update(raw).digest("hex"), t.sha256);
  assert.equal(Buffer.from(raw).toString("base64url"), t.token_base64url);
  assert.equal(hex(strictDecodeToken(t.token_base64url)!), t.token_raw);
});

test("protocol 2: a non-canonical spelling of the same token is rejected", () => {
  const t = file.protocol.token_noncanonical;
  assert.equal(t.expect, "reject");
  // A lenient decoder yields the same bytes — that is exactly why rule 3 re-encodes.
  assert.equal(Buffer.from(t.token_base64url, "base64url").toString("hex"), file.protocol.token.token_raw);
  assert.equal(strictDecodeToken(t.token_base64url), undefined);
});

// Protocol vector 3 — §6.3: empty after normalisation is refused before any
// KDF runs, on both the wrap and the unwrap path (§9.3: unwrapAlbumKey is the
// public entry point). Whatever entries the file carries are all run.
test("protocol 3: passphrases that normalise to empty are rejected, not hashed", () => {
  assert.ok(file.protocol.passphrase_empty.length > 0);
  const stored = file.wrap.find((w) => w.params.m_cost_kib === 8)!;
  const album = e.AlbumKey.fromBytes(unhex(stored.k_album));
  const recipient = unhex(stored.recipient_id);
  const wrapped = e.WrappedKey.fromParts(unhex(stored.wrapped), unhex(stored.wrap_nonce), unhex(stored.salt));
  for (const v of file.protocol.passphrase_empty) {
    assert.equal(v.vector, 3, v.name);
    assert.equal(v.expect, "reject", v.name);
    assert.equal(v.normalized, "", v.name);
    assert.equal(caught(() => e.wrapAlbumKey(album, v.passphrase, params(v.params), recipient)).code, "EmptyPassphrase", v.name);
    assert.equal(caught(() => e.unwrapAlbumKey(v.passphrase, params(v.params), recipient, wrapped)).code, "EmptyPassphrase", v.name);
  }
});

// Protocol vector 4 — the KEK is not exposed, so normalisation is shown by a
// blob wrapped under the messy spelling unwrapping under the normalised one.
test("protocol 4: messy and normalised passphrases derive the same KEK", () => {
  const p = file.protocol.passphrase_normalisation;
  const album = e.AlbumKey.fromBytes(unhex(reference.k_album));
  const recipient = unhex(file.protocol.wrap_aad.recipient_id);
  const wrapped = e.wrapAlbumKey(album, p.passphrase, params(p.params), recipient);
  assertIsTheAlbumKey(e.unwrapAlbumKey(p.normalized, params(p.params), recipient, wrapped));
  const wrappedNormalised = e.wrapAlbumKey(album, p.normalized, params(p.params), recipient);
  assertIsTheAlbumKey(e.unwrapAlbumKey(p.passphrase, params(p.params), recipient, wrappedNormalised));
});

// Protocol vector 5 — the AAD bytes are not exposed; the recipient_id being
// bound into the wrap is shown by a one-byte change failing to unwrap.
test("protocol 5: the wrap is bound to recipient_id", () => {
  const v = file.wrap.find((w) => w.params.m_cost_kib === 8)!;
  assert.equal(v.recipient_id, file.protocol.wrap_aad.recipient_id);
  const wrapped = e.WrappedKey.fromParts(unhex(v.wrapped), unhex(v.wrap_nonce), unhex(v.salt));
  const other = unhex(v.recipient_id);
  other[15]! ^= 0x01;
  assert.equal(caught(() => e.unwrapAlbumKey(v.passphrase, params(v.params), other, wrapped)).code, "AuthenticationFailed");
});

// Protocol vector 6 — the one the Rust verifier cannot fail: Salt is [u8; 16]
// there. From JavaScript a 32-byte salt is representable, and must be refused
// at fromParts, before any KDF runs.
for (const v of file.protocol.wrap_salt_length) {
  test(`protocol 6: ${v.name} — ${v.expect}`, () => {
    const salt = unhex(v.salt);
    if (v.expect === "accept") {
      const wrapped = e.WrappedKey.fromParts(unhex(v.wrapped!), unhex(v.wrap_nonce), salt);
      assertIsTheAlbumKey(e.unwrapAlbumKey(v.passphrase, params(v.params), unhex(v.recipient_id), wrapped));
    } else {
      const err = caught(() => e.WrappedKey.fromParts(new Uint8Array(e.wrappedLen()), unhex(v.wrap_nonce), salt));
      assert.equal(err.code, "WrongLength");
      assert.equal(err.param, "kdfSalt");
      assert.equal(err.expected, 16);
      assert.equal(err.got, salt.length);
    }
  });
}

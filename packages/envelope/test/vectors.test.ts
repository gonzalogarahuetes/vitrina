// Encryption spec §9: "CI MUST run every vector against every implementation,
// not only against the Rust crate." This file is the second implementation.
// spec/vectors/vitrina-vectors.json is read, never written.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { REPO_ROOT, caught, hex, loadEnvelope, unhex } from "./load.js";
import type { AlbumKey, MasterKey } from "./load.js";

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
interface AlbumWrapVector {
  category: number;
  name: string;
  k_album: string;
  k_master: string;
  album_id: string;
  wrap_nonce: string;
  wrapped: string;
}
interface OwnerWrapVector {
  category: number;
  name: string;
  password: string;
  salt: string;
  params: Params;
  k_master: string;
  root: string;
  kek: string;
  proof: string;
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
interface PassphraseVector {
  vector: number;
  passphrase: string;
  normalized: string;
  salt: string;
  params: Params;
  recipient_id: string;
  wrap_nonce: string;
  wrapped: string;
  kek: string;
}
interface VectorFile {
  envelope_version: number;
  envelope: EnvelopeVector[];
  envelope_negative: NegativeVector[];
  key_derivation: { category: number }[];
  anchors: Record<string, { category: number }>;
  wrap: WrapVector[];
  album_wrap: AlbumWrapVector[];
  owner_wrap: OwnerWrapVector[];
  protocol: {
    token: { vector: number; token_raw: string; token_base64url: string; sha256: string; expect: string };
    token_noncanonical: { vector: number; token_base64url: string; expect: string };
    passphrase_empty: EmptyPassphraseVector[];
    passphrase_normalisation: PassphraseVector;
    wrap_aad: { vector: number; recipient_id: string; aad: string };
    wrap_salt_length: SaltLengthVector[];
    passphrase_spacing_mark: PassphraseVector;
    album_wrap_aad: { vector: number; album_id: string; aad: string };
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
  assert.deepEqual(file.album_wrap.map((v) => v.category), [16]);
  assert.deepEqual(file.owner_wrap.map((v) => v.category), [17, 17]);
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

// Category 16 — §2's wrap of K_album under K_master. Unwrap direction from the
// committed blob; the wrap direction draws its own nonce, so round trip instead.
// The unwrapped key is proven by what it opens, never read (§2.2, §9.3).
for (const v of file.album_wrap) {
  test(`category 16: ${v.name} — unwraps to K_album`, () => {
    const master = e.MasterKey.fromBytes(unhex(v.k_master));
    const wrapped = e.MasterWrappedKey.fromParts(unhex(v.wrapped), unhex(v.wrap_nonce));
    assertIsTheAlbumKey(e.unwrapAlbumKeyWithMaster(wrapped, master, unhex(v.album_id)));

    const other = unhex(v.album_id);
    other[15]! ^= 0x01;
    assert.equal(caught(() => e.unwrapAlbumKeyWithMaster(wrapped, master, other)).code, "AuthenticationFailed");
  });

  test(`category 16: ${v.name} — wrap then unwrap round-trips`, () => {
    const album = e.AlbumKey.fromBytes(unhex(v.k_album));
    const master = e.MasterKey.fromBytes(unhex(v.k_master));
    const wrapped = e.wrapAlbumKeyWithMaster(album, master, unhex(v.album_id));
    assert.equal(wrapped.wrapped.length, e.masterWrappedLen());
    assert.equal(wrapped.wrapNonce.length, e.masterWrapNonceLen());
    assert.notEqual(hex(wrapped.wrapNonce), v.wrap_nonce, "wrap_nonce is fresh (§2)");
    assertIsTheAlbumKey(e.unwrapAlbumKeyWithMaster(wrapped, master, unhex(v.album_id)));
  });
}

// Category 17 — §6.6.2, both parameter sets. The proof is the one derived
// value the binding returns as bytes, so it is asserted byte-exactly; root and
// kek are internal (§9.3). The recovered K_master is proven by the chain: it
// opens category 16's blob, whose K_album opens category 1's object.
const c16 = file.album_wrap[0]!;
function assertIsTheMasterKey(master: MasterKey) {
  const stored = e.MasterWrappedKey.fromParts(unhex(c16.wrapped), unhex(c16.wrap_nonce));
  assertIsTheAlbumKey(e.unwrapAlbumKeyWithMaster(stored, master, unhex(c16.album_id)));
}

for (const v of file.owner_wrap) {
  test(`category 17: ${v.name} — derives the expected proof and unwraps to K_master`, () => {
    assert.equal(v.k_master, c16.k_master, "category 17 wraps category 16's K_master");
    const credential = e.deriveOwnerCredential(v.password, unhex(v.salt), params(v.params));
    assert.equal(hex(credential.proof), v.proof, "the proof is a known answer through the binding");
    assert.notEqual(v.proof, v.kek, "§6.6: KEK and proof are independent");

    const stored = e.WrappedMaster.fromParts(unhex(v.wrapped), unhex(v.wrap_nonce));
    assertIsTheMasterKey(e.unwrapMasterKey(credential.intoKek(), stored));
  });

  test(`category 17: ${v.name} — wrap then unwrap round-trips`, () => {
    const master = e.MasterKey.fromBytes(unhex(v.k_master));
    const kek = e.deriveOwnerCredential(v.password, unhex(v.salt), params(v.params)).intoKek();
    const wrapped = e.wrapMasterKey(kek, master);
    assert.equal(wrapped.wrapped.length, e.ownerWrappedLen());
    assert.equal(wrapped.wrapNonce.length, e.ownerWrapNonceLen());
    assert.notEqual(hex(wrapped.wrapNonce), v.wrap_nonce, "wrap_nonce is fresh (§6.6.2)");
    assertIsTheMasterKey(e.unwrapMasterKey(kek, wrapped));
  });
}

// §9: every vector against every implementation. Each group under
// file.protocol names the test below that exercises it; a group with no row
// fails by name, as the negatives table does for categories.
const protocolTests: Record<string, string> = {
  token: "protocol 1: token hashes over the 32 raw bytes and encodes canonically",
  token_noncanonical: "protocol 2: a non-canonical spelling of the same token is rejected",
  passphrase_empty: "protocol 3: passphrases that normalise to empty are rejected, not hashed",
  passphrase_normalisation: "protocol 4: the committed blob unwraps under the messy passphrase and its normalised form",
  wrap_aad: "protocol 5: the wrap is bound to recipient_id",
  wrap_salt_length: "protocol 6: salt length is enforced at fromParts",
  passphrase_spacing_mark: "protocol 7: the committed blob unwraps under a passphrase carrying a spacing mark",
  album_wrap_aad: "protocol 8: the album wrap is bound to album_id",
};

test("every protocol group has a test", () => {
  const missing = Object.keys(file.protocol).filter((k) => !(k in protocolTests));
  assert.equal(missing.length, 0, `no test defined for protocol group ${missing.join(", ")}`);
});

// §9.1 protocol vectors 1 and 2 — vitrina-schema.md §6. The crate has no token
// code, so this is the TypeScript rule itself, run against the vector.
function strictDecodeToken(s: string): Uint8Array | undefined {
  if (s.length !== 43 || !/^[A-Za-z0-9_-]{43}$/.test(s)) return undefined;
  const bytes = Buffer.from(s, "base64url");
  if (bytes.length !== 32 || bytes.toString("base64url") !== s) return undefined;
  return new Uint8Array(bytes);
}

test(protocolTests.token!, () => {
  const t = file.protocol.token;
  assert.equal(t.expect, "accept");
  const raw = unhex(t.token_raw);
  assert.equal(createHash("sha256").update(raw).digest("hex"), t.sha256);
  assert.equal(Buffer.from(raw).toString("base64url"), t.token_base64url);
  assert.equal(hex(strictDecodeToken(t.token_base64url)!), t.token_raw);
});

test(protocolTests.token_noncanonical!, () => {
  const t = file.protocol.token_noncanonical;
  assert.equal(t.expect, "reject");
  // A lenient decoder yields the same bytes — that is exactly why rule 3 re-encodes.
  assert.equal(Buffer.from(t.token_base64url, "base64url").toString("hex"), file.protocol.token.token_raw);
  assert.equal(strictDecodeToken(t.token_base64url), undefined);
});

// Protocol vector 3 — §6.3: empty after normalisation is refused before any
// KDF runs, on both the wrap and the unwrap path (§9.3: unwrapAlbumKey is the
// public entry point). Whatever entries the file carries are all run.
test(protocolTests.passphrase_empty!, () => {
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

// Protocol vectors 4 and 7 — the KEK is not exposed, so the committed blob is
// unwrapped with the vector's own inputs and must open the album key, as
// category 9 does (§9.3). A wrong KEK fails here without any key being read.
for (const [group, p] of [
  ["passphrase_normalisation", file.protocol.passphrase_normalisation],
  ["passphrase_spacing_mark", file.protocol.passphrase_spacing_mark],
] as const) {
  test(protocolTests[group]!, () => {
    assert.equal(p.recipient_id, file.protocol.wrap_aad.recipient_id, "§9.1: vector 5's recipient_id");
    const wrapped = e.WrappedKey.fromParts(unhex(p.wrapped), unhex(p.wrap_nonce), unhex(p.salt));
    for (const passphrase of [p.passphrase, p.normalized]) {
      assertIsTheAlbumKey(e.unwrapAlbumKey(passphrase, params(p.params), unhex(p.recipient_id), wrapped));
    }
  });
}

// Protocol vector 5 — the AAD bytes are not exposed; the recipient_id being
// bound into the wrap is shown by a one-byte change failing to unwrap.
test(protocolTests.wrap_aad!, () => {
  const v = file.wrap.find((w) => w.params.m_cost_kib === 8)!;
  assert.equal(v.recipient_id, file.protocol.wrap_aad.recipient_id);
  const wrapped = e.WrappedKey.fromParts(unhex(v.wrapped), unhex(v.wrap_nonce), unhex(v.salt));
  const other = unhex(v.recipient_id);
  other[15]! ^= 0x01;
  assert.equal(caught(() => e.unwrapAlbumKey(v.passphrase, params(v.params), other, wrapped)).code, "AuthenticationFailed");
});

// Protocol vector 8 — vector 5's proxy for the 37-byte AAD (§9.3): the vector's
// own album_id must open category 16's blob, and a one-byte change must not.
test(protocolTests.album_wrap_aad!, () => {
  const v = file.protocol.album_wrap_aad;
  const c16 = file.album_wrap[0]!;
  const master = e.MasterKey.fromBytes(unhex(c16.k_master));
  const wrapped = e.MasterWrappedKey.fromParts(unhex(c16.wrapped), unhex(c16.wrap_nonce));
  assertIsTheAlbumKey(e.unwrapAlbumKeyWithMaster(wrapped, master, unhex(v.album_id)));
  assert.equal(v.album_id, c16.album_id, "§9.1: vector 8's album_id is category 16's");
  assert.equal(v.aad.length / 2, 37);
  const other = unhex(v.album_id);
  other[15]! ^= 0x01;
  assert.equal(caught(() => e.unwrapAlbumKeyWithMaster(wrapped, master, other)).code, "AuthenticationFailed");
});

// Protocol vector 6 — the one the Rust verifier cannot fail: Salt is [u8; 16]
// there. From JavaScript a 32-byte salt is representable, and must be refused
// at fromParts, before any KDF runs.
for (const v of file.protocol.wrap_salt_length) {
  test(`${protocolTests.wrap_salt_length!}: ${v.name} — ${v.expect}`, () => {
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

// §9.1: every salt a derivation reads must differ from every other. Pinned,
// not inferred from the file: vector 3 is refused before any KDF runs and
// vector 6's 32-byte entry at fromParts, so neither consumes its salt.
const consumedSalts: { entry: string; salt: string }[] = [
  { entry: "category 9: v1 parameters (§6.2)", salt: file.wrap[0]!.salt },
  { entry: "category 9: low parameters", salt: file.wrap[1]!.salt },
  { entry: "protocol 4: passphrase_normalisation", salt: file.protocol.passphrase_normalisation.salt },
  { entry: "protocol 6: 16-byte salt (accept)", salt: file.protocol.wrap_salt_length[0]!.salt },
  { entry: "protocol 7: passphrase_spacing_mark", salt: file.protocol.passphrase_spacing_mark.salt },
  { entry: "category 17: v1 parameters (§6.6.2)", salt: file.owner_wrap[0]!.salt },
  { entry: "category 17: low parameters", salt: file.owner_wrap[1]!.salt },
];

test("§9.1: the pinned salt entries are the ones the file carries", () => {
  assert.deepEqual(file.wrap.map((w) => w.name), ["v1 parameters (§6.2)", "low parameters"]);
  assert.equal(file.protocol.passphrase_normalisation.vector, 4);
  assert.deepEqual(
    file.protocol.wrap_salt_length.map((v) => [v.vector, v.expect, v.salt.length / 2]),
    [[6, "accept", 16], [6, "reject", 32]],
  );
  assert.equal(file.protocol.passphrase_spacing_mark.vector, 7);
  assert.equal(file.protocol.passphrase_empty.length, 3, "vector 3: out of scope, but its shape is pinned");
  assert.deepEqual(file.owner_wrap.map((w) => w.name), ["v1 parameters (§6.6.2)", "low parameters"]);
});

test("§9.1: every consumed salt in the file is pairwise distinct", () => {
  const entriesBySalt = new Map<string, string[]>();
  for (const { entry, salt } of consumedSalts) {
    assert.equal(salt.length, 32, `${entry}: salt must be 16 bytes`);
    entriesBySalt.set(salt, [...(entriesBySalt.get(salt) ?? []), entry]);
  }
  const shared = [...entriesBySalt].filter(([, entries]) => entries.length > 1);
  const report = shared.map(([salt, entries]) => `${salt} is carried by: ${entries.join(", ")}`).join("\n");
  assert.equal(shared.length, 0, `§9.1: consumed salts must be distinct\n${report}`);
});

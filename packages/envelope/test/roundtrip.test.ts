import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { caught, loadEnvelope } from "./load.js";

const e = await loadEnvelope();

const ALBUM_KEY = Uint8Array.from({ length: 32 }, (_, i) => 0xc0 + i);
const ASSET_ID = Uint8Array.from({ length: 16 }, (_, i) => 0xb0 + i);
const key = e.AlbumKey.fromBytes(ALBUM_KEY);
// Owner-path fixtures. Argon2's floor, not v1's 64 MiB — this is a smoke test.
const OWNER_SALT = Uint8Array.from({ length: 16 }, (_, i) => 0xd0 + i);
const lowParams = new e.WrapParams(8, 1, 1);

// Phase-0 plan §9's third exit criterion. 3 MiB is exactly 12 chunks at the
// v1 chunk size, so the final chunk is full rather than partial.
test("round-trips a 3 MiB buffer through encryptAsset and decryptAsset", () => {
  const plaintext = new Uint8Array(randomBytes(3 * 1024 * 1024));
  const object = e.encryptAsset(key, ASSET_ID, plaintext);

  const chunks = Math.ceil(plaintext.length / e.chunkSize());
  assert.equal(chunks, 12);
  assert.equal(object.length, 64 + plaintext.length + 16 * chunks);

  assert.deepEqual(e.decryptAsset(key, ASSET_ID, object), plaintext);
});

test("round-trips a partial final chunk (3 MiB + 1)", () => {
  const plaintext = new Uint8Array(randomBytes(3 * 1024 * 1024 + 1));
  const object = e.encryptAsset(key, ASSET_ID, plaintext);
  assert.equal(object.length, 64 + plaintext.length + 16 * 13);
  assert.deepEqual(e.decryptAsset(key, ASSET_ID, object), plaintext);
});

test("thumb and meta round-trip and are not interchangeable with asset (§2.1)", () => {
  const plaintext = new Uint8Array(randomBytes(1000));
  const thumb = e.encryptThumb(key, ASSET_ID, plaintext);
  const meta = e.encryptMeta(key, ASSET_ID, plaintext);
  assert.deepEqual(e.decryptThumb(key, ASSET_ID, thumb), plaintext);
  assert.deepEqual(e.decryptMeta(key, ASSET_ID, meta), plaintext);

  assert.equal(caught(() => e.decryptAsset(key, ASSET_ID, thumb)).code, "AuthenticationFailed");
  assert.equal(caught(() => e.decryptMeta(key, ASSET_ID, thumb)).code, "AuthenticationFailed");
  assert.equal(caught(() => e.decryptThumb(key, ASSET_ID, meta)).code, "AuthenticationFailed");
});

test("every encryption draws a fresh base_nonce (§4.1)", () => {
  const plaintext = new Uint8Array([1, 2, 3]);
  const a = e.encryptAsset(key, ASSET_ID, plaintext);
  const b = e.encryptAsset(key, ASSET_ID, plaintext);
  assert.notDeepEqual(a.subarray(8, 24), b.subarray(8, 24));
});

test("a zero-length plaintext is rejected, not encrypted (§3.2)", () => {
  const err = caught(() => e.encryptAsset(key, ASSET_ID, new Uint8Array(0)));
  assert.equal(err.code, "Header");
  assert.equal(err.reason, "PlaintextLengthZero");
});

// §2.2: K_album crosses inward only. The handle exposes nothing but the
// wasm-bindgen lifecycle methods, and serialising it yields a pointer, not bytes.
test("AlbumKey is opaque: no method or property returns its bytes", () => {
  // Double-underscore names are wasm-bindgen's own plumbing, not API.
  const visible = (o: object) => Object.getOwnPropertyNames(o).filter((n) => !n.startsWith("__"));
  assert.deepEqual(visible(e.AlbumKey.prototype), ["constructor", "free"]);
  assert.deepEqual(visible(e.AlbumKey), ["length", "name", "prototype", "fromBytes"]);
  assert.doesNotMatch(JSON.stringify(key), new RegExp(Buffer.from(ALBUM_KEY).toString("hex")));
});

// §2.2 one level up: K_master unwraps every album in the account.
test("MasterKey is opaque: no method or property returns its bytes", () => {
  const MASTER_KEY = Uint8Array.from({ length: 32 }, (_, i) => 0xe0 + i);
  const master = e.MasterKey.fromBytes(MASTER_KEY);
  const visible = (o: object) => Object.getOwnPropertyNames(o).filter((n) => !n.startsWith("__"));
  assert.deepEqual(visible(e.MasterKey.prototype), ["constructor", "free"]);
  assert.deepEqual(visible(e.MasterKey).sort(), ["fromBytes", "generate", "length", "name", "prototype"]);
  assert.doesNotMatch(JSON.stringify(master), new RegExp(Buffer.from(MASTER_KEY).toString("hex")));
});

// §6.6.2 / §2.2: the KEK survives a network round trip as a handle and nothing
// else. Unlike MasterKey there is no fromBytes — deriveOwnerCredential is the
// only way to obtain one.
test("OwnerKek is opaque and has no constructor", () => {
  const visible = (o: object) => Object.getOwnPropertyNames(o).filter((n) => !n.startsWith("__"));
  assert.deepEqual(visible(e.OwnerKek.prototype), ["constructor", "free"]);
  assert.deepEqual(visible(e.OwnerKek).sort(), ["length", "name", "prototype"]);
});

// The one new type with a getter: it exposes the proof and nothing key-shaped.
test("OwnerCredential exposes the proof, and intoKek consumes it", () => {
  const visible = (o: object) => Object.getOwnPropertyNames(o).filter((n) => !n.startsWith("__"));
  assert.deepEqual(visible(e.OwnerCredential.prototype).sort(), ["constructor", "free", "intoKek", "proof"]);

  const credential = e.deriveOwnerCredential("Tr3s Pájaros!", OWNER_SALT, lowParams);
  const proof = credential.proof;
  assert.equal(proof.length, e.loginProofLen());
  assert.deepEqual(credential.proof, proof, "the getter is stable");

  const kek = credential.intoKek();
  assert.ok(kek instanceof e.OwnerKek);
  // wasm-bindgen nulled the handle: this is its own error, not an EnvelopeError.
  assert.throws(() => credential.intoKek());
  assert.throws(() => credential.proof);
});

// api-sketch §8.4, steps 2 and 4, with a fresh derivation in between as a
// second device would do. §9.3's pattern proves the recovered K_master without
// reading it: an album key wrapped under the original must unwrap under it.
test("K_master round-trips under the owner KEK across two derivations (§6.6.2)", () => {
  const master = e.MasterKey.generate();
  const plaintext = new Uint8Array(randomBytes(100));
  const albumId = new Uint8Array(randomBytes(16));
  const albumUnderMaster = e.wrapAlbumKeyWithMaster(key, master, albumId);

  // Same order as the client: the proof is read (and sent) before the KEK is
  // taken, because intoKek consumes the credential and the proof with it.
  const signup = e.deriveOwnerCredential("Tr3s Pájaros!", OWNER_SALT, lowParams);
  const signupProof = signup.proof;
  const stored = e.wrapMasterKey(signup.intoKek(), master);
  assert.equal(stored.wrapped.length, 48);
  assert.equal(stored.wrapNonce.length, 24);

  const login = e.deriveOwnerCredential("Tr3s Pájaros!", OWNER_SALT, lowParams);
  assert.deepEqual(login.proof, signupProof, "the proof is deterministic or login never works");
  const reloaded = e.WrappedMaster.fromParts(stored.wrapped, stored.wrapNonce);
  const recovered = e.unwrapMasterKey(login.intoKek(), reloaded);

  const albumAgain = e.unwrapAlbumKeyWithMaster(albumUnderMaster, recovered, albumId);
  const object = e.encryptAsset(key, ASSET_ID, plaintext);
  assert.deepEqual(e.decryptAsset(albumAgain, ASSET_ID, object), plaintext);
});

test("wrapMasterKey draws a fresh wrap_nonce per call", () => {
  const master = e.MasterKey.generate();
  const kek = e.deriveOwnerCredential("Tr3s Pájaros!", OWNER_SALT, lowParams).intoKek();
  const a = e.wrapMasterKey(kek, master);
  const b = e.wrapMasterKey(kek, master);
  assert.notDeepEqual(a.wrapNonce, b.wrapNonce);
});

// §6.6.2: NFC only. Composition is folded; case, marks and spacing are not.
test("the owner password is NFC-normalised and nothing else", () => {
  const proofOf = (password: string) => e.deriveOwnerCredential(password, OWNER_SALT, lowParams).proof;
  const nfc = proofOf("Tr3s Pájaros!");
  // ́ is written as an escape so an editor that normalises on save cannot
  // silently turn this into a second copy of the NFC spelling.
  assert.deepEqual(proofOf("Tr3s Pájaros!"), nfc);
  assert.notDeepEqual(proofOf("tr3s pajaros!"), nfc, "case and marks are kept");
  assert.notDeepEqual(proofOf("Tr3s Pájaros! "), nfc, "whitespace is not trimmed");
  assert.notDeepEqual(proofOf("Tr3s  Pájaros!"), nfc, "whitespace is not collapsed");
});

test("generate draws a distinct K_master every time", () => {
  const kek = e.deriveOwnerCredential("Tr3s Pájaros!", OWNER_SALT, lowParams).intoKek();
  const a = e.wrapMasterKey(kek, e.MasterKey.generate());
  const b = e.unwrapMasterKey(kek, e.WrappedMaster.fromParts(a.wrapped, a.wrapNonce));
  // No bytes to compare, so: a blob wrapped for one K_master must not open
  // an album wrapped under another.
  const albumId = new Uint8Array(randomBytes(16));
  const underOther = e.wrapAlbumKeyWithMaster(key, e.MasterKey.generate(), albumId);
  assert.equal(caught(() => e.unwrapAlbumKeyWithMaster(underOther, b, albumId)).code, "AuthenticationFailed");
});

// §2: the album wrap binds album_id through the AAD, so the wrong id is an
// unwrap failure rather than a wrong K_album that fails several layers later.
test("K_album round-trips under K_master and is bound to album_id (§2)", () => {
  const master = e.MasterKey.fromBytes(new Uint8Array(randomBytes(32)));
  const albumId = new Uint8Array(randomBytes(16));
  const plaintext = new Uint8Array(randomBytes(100));

  const stored = e.wrapAlbumKeyWithMaster(key, master, albumId);
  assert.equal(stored.wrapped.length, 48);
  assert.equal(stored.wrapNonce.length, 24);
  const again = e.wrapAlbumKeyWithMaster(key, master, albumId);
  assert.notDeepEqual(again.wrapNonce, stored.wrapNonce, "fresh wrap_nonce per wrap");

  const reloaded = e.MasterWrappedKey.fromParts(stored.wrapped, stored.wrapNonce);
  const unwrapped = e.unwrapAlbumKeyWithMaster(reloaded, master, albumId);
  const object = e.encryptAsset(key, ASSET_ID, plaintext);
  assert.deepEqual(e.decryptAsset(unwrapped, ASSET_ID, object), plaintext);

  const otherId = albumId.slice();
  otherId[15]! ^= 1;
  assert.equal(caught(() => e.unwrapAlbumKeyWithMaster(reloaded, master, otherId)).code, "AuthenticationFailed");
  const otherMaster = e.MasterKey.fromBytes(new Uint8Array(randomBytes(32)));
  assert.equal(caught(() => e.unwrapAlbumKeyWithMaster(reloaded, otherMaster, albumId)).code, "AuthenticationFailed");
});

test("the exported lengths are §6.2's, §3.1's, §2's and §6.6.2's", () => {
  assert.equal(e.ownerWrappedLen(), 48);
  assert.equal(e.ownerWrapNonceLen(), 24);
  assert.equal(e.loginProofLen(), 32);
  assert.equal(e.chunkSize(), 262144);
  assert.equal(e.albumKeyLen(), 32);
  assert.equal(e.assetIdLen(), 16);
  assert.equal(e.saltLen(), 16);
  assert.equal(e.recipientIdLen(), 16);
  assert.equal(e.wrappedLen(), 48);
  assert.equal(e.wrapNonceLen(), 24);
  assert.equal(e.albumIdLen(), 16);
  assert.equal(e.masterKeyLen(), 32);
  assert.equal(e.masterWrappedLen(), 48);
  assert.equal(e.masterWrapNonceLen(), 24);
});

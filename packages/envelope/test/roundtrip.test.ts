import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { caught, loadEnvelope } from "./load.js";

const e = await loadEnvelope();

const ALBUM_KEY = Uint8Array.from({ length: 32 }, (_, i) => 0xc0 + i);
const ASSET_ID = Uint8Array.from({ length: 16 }, (_, i) => 0xb0 + i);
const key = e.AlbumKey.fromBytes(ALBUM_KEY);

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

test("the exported lengths are §6.2's and §3.1's", () => {
  assert.equal(e.chunkSize(), 262144);
  assert.equal(e.albumKeyLen(), 32);
  assert.equal(e.assetIdLen(), 16);
  assert.equal(e.saltLen(), 16);
  assert.equal(e.recipientIdLen(), 16);
  assert.equal(e.wrappedLen(), 48);
  assert.equal(e.wrapNonceLen(), 24);
});

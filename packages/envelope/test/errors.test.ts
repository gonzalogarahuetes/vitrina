// Every failure is a JS Error named EnvelopeError with a `code`; §8 rejections
// carry a `reason`. Nothing thrown or logged contains key material (§2.2).
import assert from "node:assert/strict";
import { test } from "node:test";
import { caught, hex, loadEnvelope } from "./load.js";

const e = await loadEnvelope();

const ALBUM_KEY = Uint8Array.from({ length: 32 }, (_, i) => 0xc0 + i);
const ASSET_ID = Uint8Array.from({ length: 16 }, (_, i) => 0xb0 + i);
const PLAINTEXT = Uint8Array.from({ length: 200 }, (_, i) => i);
const key = e.AlbumKey.fromBytes(ALBUM_KEY);
const object = e.encryptAsset(key, ASSET_ID, PLAINTEXT);
const params = new e.WrapParams(8, 1, 1);

const mutated = (f: (o: Uint8Array) => void, o: Uint8Array = object) => {
  const copy = o.slice();
  f(copy);
  return copy;
};

// §8's table, row by row, each surfacing as Header plus the row's reason.
const headerRows: [string, Uint8Array, Record<string, unknown>][] = [
  ["TooShort", object.subarray(0, 40), { expected: 64, got: 40 }],
  ["BadMagic", mutated((o) => (o[0] = 0x00)), {}],
  ["WrongVersion", mutated((o) => (o[4] = 0x02)), { version: 2 }],
  ["WrongCipher", mutated((o) => (o[5] = 0x09)), { cipher: 9 }],
  ["ReservedNotZero", mutated((o) => (o[7] = 0x01)), { offset: 7 }],
  ["PaddingNotZero", mutated((o) => (o[60] = 0x01)), { offset: 60 }],
  ["PlaintextLengthZero", mutated((o) => o.fill(0, 28, 36)), {}],
  ["ChunkSizeZero", mutated((o) => o.fill(0, 24, 28)), {}],
];

for (const [reason, input, fields] of headerRows) {
  test(`§8 ${reason} surfaces as code Header with that reason`, () => {
    const err = caught(() => e.decryptAsset(key, ASSET_ID, input));
    assert.ok(err instanceof Error);
    assert.equal(err.name, "EnvelopeError");
    assert.equal(err.code, "Header");
    assert.equal(err.reason, reason);
    for (const [k, v] of Object.entries(fields)) assert.equal((err as unknown as Record<string, unknown>)[k], v);
  });
}

test("object length disagreements are their own codes, not authentication failures", () => {
  const short = caught(() => e.decryptAsset(key, ASSET_ID, object.subarray(0, object.length - 1)));
  assert.equal(short.code, "ObjectTooShort");
  assert.equal(short.expected, object.length);
  assert.equal(short.got, object.length - 1);

  const long = caught(() => e.decryptAsset(key, ASSET_ID, new Uint8Array([...object, 0])));
  assert.equal(long.code, "TrailingBytes");
});

test("a tampered chunk is AuthenticationFailed with no detail (chunk.rs)", () => {
  const err = caught(() => e.decryptAsset(key, ASSET_ID, mutated((o) => (o[100]! ^= 1))));
  assert.equal(err.code, "AuthenticationFailed");
  assert.equal(err.reason, undefined);
});

// §6.3: empty after normalisation is actionable; a wrong passphrase is not.
test("EmptyPassphrase and AuthenticationFailed are distinct codes", () => {
  const recipient = Uint8Array.from({ length: 16 }, (_, i) => 0x30 + i);
  const stored = e.wrapAlbumKey(key, "Café Roble", params, recipient);

  for (const empty of ["", "   ", " \t\n ", " "]) {
    assert.equal(caught(() => e.wrapAlbumKey(key, empty, params, recipient)).code, "EmptyPassphrase");
    assert.equal(caught(() => e.unwrapAlbumKey(empty, params, recipient, stored)).code, "EmptyPassphrase");
  }
  assert.equal(caught(() => e.unwrapAlbumKey("Café Sauce", params, recipient, stored)).code, "AuthenticationFailed");
  assert.equal(caught(() => e.unwrapAlbumKey("Café Roble", new e.WrapParams(16, 1, 1), recipient, stored)).code, "AuthenticationFailed");
});

// §6.6.2: the empty string and nothing else — the rule is narrower than §6.3's,
// so the whitespace strings EmptyPassphrase rejects are legal passwords here.
test("EmptyPassword is the empty string only; a wrong password is AuthenticationFailed", () => {
  const salt = Uint8Array.from({ length: 16 }, (_, i) => 0xd0 + i);
  const master = e.MasterKey.generate();
  const stored = e.wrapMasterKey(e.deriveOwnerCredential("Tr3s Pájaros!", salt, params).intoKek(), master);

  assert.equal(caught(() => e.deriveOwnerCredential("", salt, params)).code, "EmptyPassword");
  for (const legal of ["   ", " \t\n ", " ", "́"]) {
    assert.ok(e.deriveOwnerCredential(legal, salt, params).proof.length === 32, JSON.stringify(legal));
  }

  const wrong = e.deriveOwnerCredential("Cu4tro Árboles", salt, params).intoKek();
  assert.equal(caught(() => e.unwrapMasterKey(wrong, stored)).code, "AuthenticationFailed");
  const otherSalt = salt.slice();
  otherSalt[0]! ^= 1;
  const wrongSalt = e.deriveOwnerCredential("Tr3s Pájaros!", otherSalt, params).intoKek();
  assert.equal(caught(() => e.unwrapMasterKey(wrongSalt, stored)).code, "AuthenticationFailed");
  const wrongParams = e.deriveOwnerCredential("Tr3s Pájaros!", salt, new e.WrapParams(16, 1, 1)).intoKek();
  assert.equal(caught(() => e.unwrapMasterKey(wrongParams, stored)).code, "AuthenticationFailed");
});

test("no thrown value carries key material, plaintext or the password (§2.2, §6.6)", () => {
  const PASSWORD = "Tr3s Pájaros!";
  const salt = Uint8Array.from({ length: 16 }, (_, i) => 0xd0 + i);
  const secrets = [hex(ALBUM_KEY), hex(PLAINTEXT), PASSWORD.toLowerCase(), hex(Buffer.from(PASSWORD))];
  const failures = [
    () => e.decryptAsset(key, ASSET_ID, mutated((o) => (o[100]! ^= 1))),
    () => e.decryptAsset(key, ASSET_ID, object.subarray(0, 40)),
    () => e.AlbumKey.fromBytes(ALBUM_KEY.subarray(0, 31)),
    () => e.wrapAlbumKey(key, "  ", params, ASSET_ID),
    () => new e.WrapParams(-1, 1, 1),
    () => e.deriveOwnerCredential(PASSWORD, salt.subarray(0, 15), params),
  ];
  for (const f of failures) {
    const err = caught(f);
    const dump = JSON.stringify(Object.fromEntries(Object.getOwnPropertyNames(err).map((k) => [k, (err as unknown as Record<string, unknown>)[k]])));
    for (const s of secrets) assert.doesNotMatch(dump.toLowerCase(), new RegExp(s));
  }
});

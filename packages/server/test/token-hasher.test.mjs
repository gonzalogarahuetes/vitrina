/*
 * Vectors for the TokenHasher adapter — schema §6: SHA-256 of the 32 RAW
 * bytes. Digests computed in Python (hashlib), so this is a second
 * implementation rather than node:crypto checking itself. Hermetic,
 * against dist/.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createTokenHasher } from "../dist/adapters/driven/hashing/token-hasher.js";
import { createCredentialHasher } from "../dist/adapters/driven/hashing/credential-hasher.js";

const hex = (u8) => Buffer.from(u8).toString("hex");
const range = (from, to) => new Uint8Array(Array.from({ length: to - from }, (_, i) => from + i));

const hasher = createTokenHasher();
const TOKEN = range(0x00, 0x20);

describe("createTokenHasher — schema §6", () => {
  const vectors = [
    { name: "token 0x00..0x1f", token: TOKEN, expected: "630dcd2966c4336691125448bbb25b4ff412a49c732db2c8abc1b8581bd710dd" },
    { name: "token all zero", token: new Uint8Array(32), expected: "66687aadf862bd776c8fc18b8e9f8e20089714856ee233b3902a591d0d5f2925" },
    { name: "token 0xe0..0xff", token: range(0xe0, 0x100), expected: "9432c1a7d343fcfacb164bdc44ff71c1281c004886b1c428419088d06cd3561a" },
  ];

  for (const { name, token, expected } of vectors) {
    it(`${name} -> ${expected.slice(0, 8)}...`, () => {
      assert.equal(hex(hasher.hash(token)), expected);
    });
  }

  it("is 32 bytes and deterministic", () => {
    assert.equal(hasher.hash(TOKEN).byteLength, 32);
    assert.equal(hex(hasher.hash(TOKEN)), hex(hasher.hash(TOKEN)));
  });

  it("hashes the raw bytes, not the base64url spelling", () => {
    // Schema §6 rule 1: the canonical input is the 32 raw bytes. The adapter
    // decodes before hashing; hashing the string is the shortcut that skips it.
    const spelling = Buffer.from(Buffer.from(TOKEN).toString("base64url"), "utf8");
    assert.notEqual(hex(hasher.hash(TOKEN)), hex(hasher.hash(new Uint8Array(spelling))));
    assert.equal(
      hex(hasher.hash(new Uint8Array(spelling))),
      "ea866a757e4c38babfa8127cbe9a409d3e1f93a00ff1488ff735fcf917afffd0",
    );
  });

  it("is plain SHA-256, not the peppered credential hash", () => {
    // Schema §3 lists three kinds of hash and says none becomes another. This
    // fails the day someone reaches for authHash because it is nearby.
    const credentials = createCredentialHasher(range(0x10, 0x30));
    assert.notEqual(hex(hasher.hash(TOKEN)), hex(credentials.authHash(TOKEN)));
  });

  it("takes no secret, so it survives a secret rotation", () => {
    // A token hash keyed by the server secret would make every live session
    // depend on it. Two independently constructed hashers must agree.
    assert.equal(hex(createTokenHasher().hash(TOKEN)), hex(createTokenHasher().hash(TOKEN)));
  });
});

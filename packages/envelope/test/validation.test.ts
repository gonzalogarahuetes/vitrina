// Phase-0 plan §7, C.10: every [u8; N] in the crate arrives from JavaScript
// as a Uint8Array of arbitrary length, and every u32 arrives as a JS number
// that ToInt32 would fold silently. Eight rows, each asserted to error.
import assert from "node:assert/strict";
import { test } from "node:test";
import { caught, loadEnvelope } from "./load.js";

const e = await loadEnvelope();

const bytes = (n: number, fill = 0xab) => new Uint8Array(n).fill(fill);
const album = e.AlbumKey.fromBytes(bytes(32));
const params = new e.WrapParams(8, 1, 1);
const stored = e.wrapAlbumKey(album, "Café Roble", params, bytes(16));

interface ByteRow {
  param: string;
  expected: number;
  calls: ((input: Uint8Array) => unknown)[];
}

// The seven byte-length rows, each through every entry point that accepts it.
const rows: ByteRow[] = [
  { param: "albumKey", expected: 32, calls: [(b) => e.AlbumKey.fromBytes(b)] },
  {
    param: "assetId",
    expected: 16,
    calls: [
      (b) => e.encryptAsset(album, b, bytes(3)),
      (b) => e.encryptThumb(album, b, bytes(3)),
      (b) => e.encryptMeta(album, b, bytes(3)),
      (b) => e.decryptAsset(album, b, bytes(83)),
      (b) => e.decryptThumb(album, b, bytes(83)),
      (b) => e.decryptMeta(album, b, bytes(83)),
    ],
  },
  { param: "salt", expected: 16, calls: [(b) => e.Salt.fromBytes(b)] },
  {
    param: "recipientId",
    expected: 16,
    calls: [
      (b) => e.wrapAlbumKey(album, "Café Roble", params, b),
      (b) => e.unwrapAlbumKey("Café Roble", params, b, stored),
    ],
  },
  { param: "wrapped", expected: 48, calls: [(b) => e.WrappedKey.fromParts(b, bytes(24), bytes(16))] },
  { param: "wrapNonce", expected: 24, calls: [(b) => e.WrappedKey.fromParts(bytes(48), b, bytes(16))] },
  { param: "kdfSalt", expected: 16, calls: [(b) => e.WrappedKey.fromParts(bytes(48), bytes(24), b)] },
];

for (const row of rows) {
  test(`${row.param}: wrong lengths are rejected with the parameter name`, () => {
    for (const call of row.calls) {
      for (const got of [0, 1, row.expected - 1, row.expected + 1, row.expected * 2]) {
        const err = caught(() => call(bytes(got)));
        assert.equal(err.code, "WrongLength", `${row.param} length ${got}`);
        assert.equal(err.param, row.param);
        assert.equal(err.expected, row.expected);
        assert.equal(err.got, got);
        assert.match(err.message, new RegExp(`^${row.param}: expected ${row.expected} bytes, got ${got}$`));
      }
    }
  });

  test(`${row.param}: the exact length passes the length check`, () => {
    for (const call of row.calls) {
      try {
        call(bytes(row.expected));
      } catch (err) {
        // Anything but a WrongLength is fine here: the input was accepted as
        // bytes and failed later, e.g. an unauthenticated placeholder object.
        assert.notEqual((err as { code?: string }).code, "WrongLength");
      }
    }
  });
}

// The eighth row. Measured ToInt32 results, from the C.10 brief:
//   -1 -> 4294967295   1.5 -> 1   NaN -> 0   2**32 -> 0   2.9 -> 2
//   Infinity -> 0   2**32 + 5 -> 5   -0.5 -> 0   "7" -> 7
const coercions: unknown[] = [-1, 1.5, NaN, 2 ** 32, 2.9, Infinity, 2 ** 32 + 5, -0.5, "7"];
const numericParams = ["mCostKib", "tCost", "pCost"] as const;

for (const [index, param] of numericParams.entries()) {
  test(`${param}: values ToInt32 would reshape are rejected before conversion`, () => {
    for (const value of [...coercions, null, undefined, true, "8", {}, []]) {
      const args: unknown[] = [8, 1, 1];
      args[index] = value;
      const err = caught(() => new e.WrapParams(...(args as [number, number, number])));
      assert.equal(err.code, "NotUint32", `${param} = ${String(value)}`);
      assert.equal(err.param, param);
      assert.match(err.message, new RegExp(`^${param} must be an integer`));
    }
  });
}

// §6.2 stores parameters per recipient, so this one would have been permanent:
// 2**32 + 8 folds to 8, Argon2's minimum memory, and the crate accepts 8.
test("mCostKib of 2**32 + 8 is rejected rather than accepted as 8", () => {
  assert.equal(caught(() => new e.WrapParams(2 ** 32 + 8, 1, 1)).code, "NotUint32");
  assert.ok(new e.WrapParams(8, 1, 1));
});

test("in-range integers reach the crate, whose own rejection is distinguishable", () => {
  const err = caught(() => new e.WrapParams(0, 1, 1));
  assert.equal(err.code, "InvalidParams");
  assert.equal(caught(() => new e.WrapParams(8, 3, 4)).code, "InvalidParams");
  assert.ok(new e.WrapParams(4294967295, 1, 1) instanceof e.WrapParams, "u32::MAX is in range");
});

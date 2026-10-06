// Phase-0 plan §7, C.10: every [u8; N] in the crate arrives from JavaScript
// as a Uint8Array of arbitrary length, and every u32 arrives as a JS number
// that ToInt32 would fold silently. Ten rows, each asserted to error; the
// §6.6.2 entry points join the salt, wrapped and wrapNonce rows.
import assert from "node:assert/strict";
import { test } from "node:test";
import { caught, loadEnvelope } from "./load.js";

const e = await loadEnvelope();

const bytes = (n: number, fill = 0xab) => new Uint8Array(n).fill(fill);
const album = e.AlbumKey.fromBytes(bytes(32));
const params = new e.WrapParams(8, 1, 1);
const stored = e.wrapAlbumKey(album, "Café Roble", params, bytes(16));
const master = e.MasterKey.fromBytes(bytes(32));
const storedUnderMaster = e.wrapAlbumKeyWithMaster(album, master, bytes(16));

interface ByteRow {
  param: string;
  expected: number;
  calls: ((input: Uint8Array) => unknown)[];
}

// The nine byte-length rows, each through every entry point that accepts it.
const rows: ByteRow[] = [
  { param: "albumKey", expected: 32, calls: [(b) => e.AlbumKey.fromBytes(b)] },
  { param: "masterKey", expected: 32, calls: [(b) => e.MasterKey.fromBytes(b)] },
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
  {
    param: "salt",
    expected: 16,
    calls: [(b) => e.Salt.fromBytes(b), (b) => e.deriveOwnerCredential("Tr3s Pájaros!", b, params)],
  },
  {
    param: "recipientId",
    expected: 16,
    calls: [
      (b) => e.wrapAlbumKey(album, "Café Roble", params, b),
      (b) => e.unwrapAlbumKey("Café Roble", params, b, stored),
      (b) => e.encryptRecipientLabel(album, b, "María"),
      (b) => e.decryptRecipientLabel(album, b, bytes(41)),
    ],
  },
  {
    param: "albumId",
    expected: 16,
    calls: [
      (b) => e.wrapAlbumKeyWithMaster(album, master, b),
      (b) => e.unwrapAlbumKeyWithMaster(storedUnderMaster, master, b),
      (b) => e.encryptAlbumTitle(album, b, "Sofía's first birthday"),
      (b) => e.decryptAlbumTitle(album, b, bytes(41)),
    ],
  },
  {
    param: "wrapped",
    expected: 48,
    calls: [
      (b) => e.WrappedKey.fromParts(b, bytes(24), bytes(16)),
      (b) => e.MasterWrappedKey.fromParts(b, bytes(24)),
      (b) => e.WrappedMaster.fromParts(b, bytes(24)),
    ],
  },
  {
    param: "wrapNonce",
    expected: 24,
    calls: [
      (b) => e.WrappedKey.fromParts(bytes(48), b, bytes(16)),
      (b) => e.MasterWrappedKey.fromParts(bytes(48), b),
      (b) => e.WrappedMaster.fromParts(bytes(48), b),
    ],
  },
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

// The tenth row. Measured ToInt32 results, from the C.10 brief:
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

// Encryption spec §1: a string crossing into the format must be well-formed.
// A `&str` parameter would let the UTF-8 conversion repair an unpaired
// surrogate to U+FFFD; other platforms repair differently, so the binding
// rejects instead. Within one client the repair would round-trip — which is
// why the test is "is it rejected", never "does it round-trip".
interface StringRow {
  name: string;
  param: string;
  call: (s: string) => unknown;
  /** The code a well-formed input reaches when the call cannot succeed. */
  acceptedCode?: string;
}

const stringRows: StringRow[] = [
  { name: "title", param: "title", call: (s) => e.encryptAlbumTitle(album, bytes(16), s) },
  { name: "label", param: "label", call: (s) => e.encryptRecipientLabel(album, bytes(16), s) },
  { name: "wrapAlbumKey passphrase", param: "passphrase", call: (s) => e.wrapAlbumKey(album, s, params, bytes(16)) },
  {
    name: "unwrapAlbumKey passphrase",
    param: "passphrase",
    call: (s) => e.unwrapAlbumKey(s, params, bytes(16), stored),
    // `stored` is wrapped under "Café Roble"; any other well-formed string
    // reaches the KDF and fails to authenticate, which is what proves it passed.
    acceptedCode: "AuthenticationFailed",
  },
  // §6.6.2: the human-typed input, and the case encryption spec §1 names as the worst.
  { name: "password", param: "password", call: (s) => e.deriveOwnerCredential(s, bytes(16), params) },
];

// Lone high, lone low, high at the end, low at the start, and a reversed pair.
const unpaired = ["\uD800", "a\uDC00b", "abc\uDBFF", "\uDFFFabc", "\uDC00\uD800"];
const notStrings: unknown[] = [123, null, undefined, {}, [], new Uint8Array([0x61])];

for (const row of stringRows) {
  test(`${row.name}: an unpaired surrogate is UnpairedSurrogate, named by parameter`, () => {
    for (const s of unpaired) {
      const err = caught(() => row.call(s));
      assert.equal(err.code, "UnpairedSurrogate", `${row.name} ${JSON.stringify(s)}`);
      assert.equal(err.param, row.param);
      assert.equal(err.message, `${row.param} contains an unpaired UTF-16 surrogate`);
    }
  });

  // A surrogate *pair* is well-formed UTF-16 — 😀 is U+1F600 — and must pass.
  test(`${row.name}: a surrogate pair is well-formed and accepted`, () => {
    if (row.acceptedCode) assert.equal(caught(() => row.call("Sofía 😀")).code, row.acceptedCode);
    else assert.doesNotThrow(() => row.call("Sofía 😀"));
  });

  test(`${row.name}: a non-string is NotString, not coerced`, () => {
    for (const v of notStrings) {
      const err = caught(() => row.call(v as string));
      assert.equal(err.code, "NotString", `${row.name} = ${String(v)}`);
      assert.equal(err.param, row.param);
    }
  });
}

test("a title with a surrogate pair round-trips byte-exact", () => {
  const id = bytes(16);
  const title = "Sofía 😀";
  assert.equal(e.decryptAlbumTitle(album, id, e.encryptAlbumTitle(album, id, title)), title);
});

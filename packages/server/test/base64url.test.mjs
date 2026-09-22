/*
 * Schema §6's canonical form — api-sketch §7.2, §9.6.
 * The exact-length decoder had no test of its own; it gained one when the
 * range form was factored out of it, because the alphabet check and the
 * re-encode comparison are now shared and a refactor could silently drop one.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  decodeBase64url,
  decodeBase64urlRange,
  encodeBase64url,
  encodedLength,
  MalformedEncodingError,
} from "../dist/adapters/driving/http/base64url.js";

const canonical = (fill, bytes) => Buffer.alloc(bytes, fill).toString("base64url");

/** Decodes to 32 bytes; the final character's spare bits are not canonical. */
const NON_CANONICAL_32 = "A".repeat(42) + "B";

const throwsMalformed = (fn) =>
  assert.throws(fn, (error) => error instanceof MalformedEncodingError);

describe("decodeBase64url — exact length", () => {
  it("round-trips the canonical spelling", () => {
    const bytes = Buffer.alloc(32, 0x5a);
    assert.deepEqual(decodeBase64url(encodeBase64url(bytes), 32), bytes);
  });

  it("rejects a wrong decoded length", () => {
    throwsMalformed(() => decodeBase64url(canonical(0x01, 31), 32));
    throwsMalformed(() => decodeBase64url(canonical(0x01, 33), 32));
  });

  it("rejects a character outside the alphabet", () => {
    /*
     * WHICH CHECK REJECTS THESE, measured rather than assumed: the canonical
     * re-encode does, not the alphabet regex. Node's decoder accepts standard
     * base64's `+` and `/` when asked for base64url, so these decode to 32
     * bytes and are caught by re-encoding to a different string.
     */
    throwsMalformed(() => decodeBase64url("A".repeat(42) + "+", 32));
    throwsMalformed(() => decodeBase64url("A".repeat(42) + "/", 32));
    throwsMalformed(() => decodeBase64url(Buffer.alloc(32).toString("base64"), 32));
  });

  it("rejects a non-canonical spelling of the right bytes", () => {
    /*
     * The assertion that is easy to lose in a refactor and impossible to
     * notice afterwards. 43 characters carry 258 bits and a token is 256, so
     * four distinct strings decode to the same 32 bytes — "43 chars decoding
     * to 32" identifies no unique spelling.
     */
    assert.equal(Buffer.from(NON_CANONICAL_32, "base64url").byteLength, 32);
    throwsMalformed(() => decodeBase64url(NON_CANONICAL_32, 32));
  });

  it("rejects the empty string", () => {
    /*
     * The ONE case the alphabet regex catches alone, found by deleting it and
     * seeing only this go red. "" decodes to nothing, passes a length of 0,
     * and re-encodes to "" — so the canonical check accepts it. The `+` in
     * the pattern is what refuses it, and is load-bearing for this and
     * nothing else.
     */
    throwsMalformed(() => decodeBase64url("", 0));
  });
});

describe("decodeBase64urlRange — §9.6's metadata envelope", () => {
  const MIN = 81;
  const MAX = 4096;
  const inRange = (bytes) => decodeBase64urlRange(canonical(0x07, bytes), MIN, MAX);

  it("accepts both bounds and between — they are inclusive", () => {
    assert.equal(inRange(MIN).byteLength, MIN);
    assert.equal(inRange(MAX).byteLength, MAX);
    assert.equal(inRange(1024).byteLength, 1024);
  });

  it("rejects one byte outside either bound", () => {
    throwsMalformed(() => inRange(MIN - 1));
    throwsMalformed(() => inRange(MAX + 1));
  });

  it("applies the same alphabet and canonical rules as the exact form", () => {
    // The point of sharing the helpers: a variable-length field is not a
    // laxer field. 32 bytes is inside 0–4096, so only canonicality rejects it.
    throwsMalformed(() => decodeBase64urlRange("A".repeat(42) + "+", 0, MAX));
    throwsMalformed(() => decodeBase64urlRange(NON_CANONICAL_32, 0, MAX));
  });
});

describe("encodedLength", () => {
  it("matches what the encoder actually produces", () => {
    // 32 → 43 is the one the bearer scheme depends on; the others guard the
    // arithmetic for the field sizes §7.5 and §9.2 declare.
    for (const bytes of [16, 24, 32, 48, 81, 4096]) {
      assert.equal(encodedLength(bytes), canonical(0x00, bytes).length, `${bytes} bytes`);
    }
  });
});

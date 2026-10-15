/*
 * Schema §6's canonical codec, as the browser build gets it: @vitrina/shared's
 * source, through the same alias the app uses. The server runs its own tests
 * against the same implementation (packages/server/test/base64url.test.mjs).
 */
import { decodeBase64url, encodeBase64url, MalformedEncodingError } from "@vitrina/shared";
import { describe, expect, it } from "vitest";

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/** A 32-byte token whose canonical last character is not at an alphabet edge. */
const TOKEN = Uint8Array.from({ length: 32 }, (_, i) => (i * 37 + 11) & 0xff);
const CANONICAL = encodeBase64url(TOKEN);

/*
 * 43 characters carry 258 bits; the last character's two low bits are spare.
 * The canonical spelling has them zero; setting them gives the other three.
 */
function allFourSpellings(canonical: string): string[] {
  const last = ALPHABET.indexOf(canonical.charAt(canonical.length - 1));
  expect(last & 0b11).toBe(0);
  return [0, 1, 2, 3].map((spare) => canonical.slice(0, -1) + ALPHABET.charAt(last | spare));
}

describe("canonical base64url in the browser build", () => {
  it("has 43 characters for 32 bytes and round-trips", () => {
    expect(CANONICAL).toHaveLength(43);
    expect(decodeBase64url(CANONICAL, 32)).toEqual(TOKEN);
  });

  it("accepts exactly one of the four spellings of one 32-byte token", () => {
    const spellings = allFourSpellings(CANONICAL);
    expect(new Set(spellings).size).toBe(4);
    const accepted = spellings.filter((s) => {
      try {
        decodeBase64url(s, 32);
        return true;
      } catch (e) {
        expect(e).toBeInstanceOf(MalformedEncodingError);
        return false;
      }
    });
    expect(accepted).toEqual([CANONICAL]);
  });

  it("refuses padding, the standard alphabet, the empty string and a wrong length", () => {
    for (const bad of [CANONICAL + "=", "A".repeat(42) + "+", "A".repeat(42) + "/", "", CANONICAL.slice(0, 42), CANONICAL + "A"]) {
      expect(() => decodeBase64url(bad, 32), JSON.stringify(bad)).toThrow(MalformedEncodingError);
    }
  });

  it("encodes every length remainder the way a standard encoder does", () => {
    // btoa is the browser's own encoder: translate its alphabet, drop padding.
    for (const n of [0, 1, 2, 3, 16, 24, 31, 32, 48]) {
      const bytes = Uint8Array.from({ length: n }, (_, i) => (i * 101 + 7) & 0xff);
      const reference = btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
      expect(encodeBase64url(bytes)).toBe(reference);
      if (n > 0) expect(decodeBase64url(reference, n)).toEqual(bytes);
    }
  });
});

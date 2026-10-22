/*
 * parseInvite against the rules the owner decided: v first, no
 * percent-decoding, no duplicates, no unknown keys in v1, canonical
 * base64url at exact lengths, `k` absent (never empty) in passphrase mode.
 */
import { encodeBase64url } from "@vitrina/shared";
import { describe, expect, it } from "vitest";
import { parseInvite } from "./parse";

const b64 = (bytes: number, fill: number) =>
  encodeBase64url(new Uint8Array(bytes).fill(fill));
const A = b64(16, 1);
const T = b64(32, 2);
const K = b64(32, 3);

/** What the parser decided, as one word: the mode, or the error's kind. */
function outcome(fragment: string): string {
  const r = parseInvite(fragment);
  return r.ok ? r.invite.mode : r.error.kind;
}

describe("parseInvite", () => {
  const cases: [string, string, string][] = [
    // Accepted
    ["a QR invite", `#v=1&a=${A}&t=${T}&k=${K}`, "qr"],
    ["a passphrase invite", `#v=1&a=${A}&t=${T}`, "passphrase"],
    ["keys in any order", `#t=${T}&a=${A}&v=1`, "passphrase"],

    // Missing
    ["the empty string", "", "missing"],
    ["a bare #", "#", "missing"],

    // Shape of the fragment
    ["no leading #", `v=1&a=${A}&t=${T}`, "malformed"],
    ["a % anywhere", `#v=1&a=${A}&t=${T}%41`, "malformed"],
    ["an empty piece (&&)", `#v=1&&a=${A}&t=${T}`, "malformed"],
    ["a trailing &", `#v=1&a=${A}&t=${T}&`, "malformed"],
    ["a piece with no =", `#v=1&a=${A}&t=${T}&k`, "malformed"],
    ["an empty name", `#v=1&a=${A}&t=${T}&=x`, "malformed"],
    ["a duplicate key", `#v=1&a=${A}&t=${T}&t=${T}`, "malformed"],
    ["a duplicate v", `#v=1&v=1&a=${A}&t=${T}`, "malformed"],

    // Version, checked first
    ["no v", `#a=${A}&t=${T}`, "malformed"],
    ["v=01", `#v=01&a=${A}&t=${T}`, "malformed"],
    ["v=+1", `#v=+1&a=${A}&t=${T}`, "malformed"],
    ["v=-1", `#v=-1&a=${A}&t=${T}`, "malformed"],
    ["v=1.0", `#v=1.0&a=${A}&t=${T}`, "malformed"],
    ["an empty v", `#v=&a=${A}&t=${T}`, "malformed"],
    [
      "v=2 with fields v1 does not know",
      "#v=2&anything=else",
      "unsupported-version",
    ],
    ["v=10", `#v=10&a=${A}&t=${T}`, "unsupported-version"],
    /*
     * v is found before ANY v1 grammar is applied (invite spec §6: refuse with
     * a clear message, never guess). A v2 may change the syntax itself, so
     * none of v1's structural rules may turn a v2 invite into the dead page.
     */
    [
      "v=2 with a piece that has no =",
      "#v=2&anything-without-equals",
      "unsupported-version",
    ],
    ["v=2 with an empty piece", "#v=2&&x=1", "unsupported-version"],
    ["v=2 with a % elsewhere", "#v=2&x=%41", "unsupported-version"],
    [
      "v=2 with duplicate keys elsewhere",
      "#v=2&x=1&x=2",
      "unsupported-version",
    ],
    ["v=2 last", "#x=1&v=2", "unsupported-version"],
    ["a % inside v itself", `#v=%31&a=${A}&t=${T}`, "malformed"],

    // v1's fields
    ["an unknown key in v1", `#v=1&a=${A}&t=${T}&x=1`, "malformed"],
    ["no a", `#v=1&t=${T}`, "malformed"],
    ["no t", `#v=1&a=${A}`, "malformed"],
    ["k present but empty", `#v=1&a=${A}&t=${T}&k=`, "malformed"],

    // Values: canonical base64url at exact lengths
    ["a one character short", `#v=1&a=${A.slice(1)}&t=${T}`, "malformed"],
    ["a one character long", `#v=1&a=${A}A&t=${T}`, "malformed"],
    ["t one character short", `#v=1&a=${A}&t=${T.slice(1)}`, "malformed"],
    [
      "k one character short",
      `#v=1&a=${A}&t=${T}&k=${K.slice(1)}`,
      "malformed",
    ],
    [
      "a non-canonical t (spare bits set)",
      `#v=1&a=${A}&t=${T.slice(0, 42)}B`,
      "malformed",
    ],
    ["a padded t", `#v=1&a=${A}&t=${T}=`, "malformed"],
    ["standard base64's +", `#v=1&a=${A}&t=${T.slice(0, 42)}+`, "malformed"],
  ];

  for (const [what, fragment, expected] of cases) {
    it(`${what} → ${expected}`, () => {
      expect(outcome(fragment)).toBe(expected);
    });
  }

  it("returns the token as the text it was sent as, and the decoded bytes", () => {
    const r = parseInvite(`#v=1&a=${A}&t=${T}&k=${K}`);
    if (!r.ok || r.invite.mode !== "qr")
      throw new Error("expected a QR invite");
    expect(r.invite.token).toBe(T);
    expect(Array.from(r.invite.albumId)).toEqual(new Array(16).fill(1));
    expect(Array.from(r.invite.inviteKey)).toEqual(new Array(32).fill(3));
  });

  it("puts nothing from the fragment into an error", () => {
    const r = parseInvite(`#v=1&a=${A}&t=${T}&k=${K.slice(1)}`);
    expect(r.ok).toBe(false);
    const text = JSON.stringify(r);
    for (const value of [A, T, K.slice(1)]) expect(text).not.toContain(value);
  });
});

/*
 * Vectors for api-sketch §8.2's address normalisation: NFC, then trim Unicode
 * White_Space, then the unconditional lowercase mapping — and nothing else.
 *
 * Each vector pins one clause of that rule, so a reader can tell WHICH step a
 * failure belongs to. The properties rather than the spellings are the point:
 * the function is the only implementation of the rule (§8.2 — "why this can
 * be simple"), so drift here is not caught by a second implementation
 * disagreeing, only by these.
 *
 * Hermetic, against dist/, like every file in this directory.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { normaliseAddress } from "../dist/domain/owner/normalise-address.js";

/** Code points, for failure messages a human can read. */
const cps = (s) => [...s].map((c) => c.codePointAt(0).toString(16)).join(" ");

const collapses = (group) => {
  const [first, ...rest] = group.map(normaliseAddress);
  for (const [i, out] of rest.entries()) {
    assert.equal(out, first, `${JSON.stringify(group[i + 1])} → [${cps(out)}], expected [${cps(first)}]`);
  }
};

const vectors = [
  // ---- Step 1: NFC ---------------------------------------------------------
  {
    name: "NFC: combining acute composes to U+00E9",
    input: "cafe\u0301@x.es",
    expected: "caf\u00e9@x.es",
  },
  {
    name: "NFC: A + combining ring above composes to U+00E5",
    input: "A\u030a@x.es",
    expected: "\u00e5@x.es",
  },

  // ---- Step 2: trim Unicode White_Space -------------------------------------
  {
    name: "trim: ASCII space both ends",
    input: "  Ana@Example.COM  ",
    expected: "ana@example.com",
  },
  {
    // The character encryption spec §6.3 names explicitly, and the one
    // String.prototype.trim() does NOT strip — so this vector is what fails
    // if someone puts trim() back.
    name: "trim: U+0085 NEL is White_Space and is stripped",
    input: "\u0085ana@x.es\u0085",
    expected: "ana@x.es",
  },
  {
    name: "trim: U+3000 ideographic space and U+2028 line separator are stripped",
    input: "\u3000ana@x.es\u2028",
    expected: "ana@x.es",
  },
  {
    // The other direction of the trim() discrepancy: trim() removes U+FEFF,
    // White_Space does not include it, so the rule keeps it.
    name: "trim: U+FEFF is NOT White_Space and is kept",
    input: "\ufeffana@x.es",
    expected: "\ufeffana@x.es",
  },
  {
    // §8.2 trims; it does not collapse. That is §6.3's passphrase rule and
    // deliberately not this one.
    name: "trim: interior whitespace is preserved, not collapsed",
    input: "ana mar\u00eda@x.es",
    expected: "ana mar\u00eda@x.es",
  },

  // ---- Step 3: unconditional lowercase --------------------------------------
  {
    // Locale-independent: toLocaleLowerCase("tr") would give "i". The
    // unconditional mapping gives i + U+0307. Pinned so the order of steps
    // cannot silently flip either — lowercasing first then NFC yields the
    // same code points here, but other inputs differ, so the vector fixes
    // the sequence the spec names.
    name: "lowercase: U+0130 maps to i + U+0307, whatever the process locale",
    input: "\u0130@x.es",
    expected: "i\u0307@x.es",
  },
  {
    name: "lowercase: capital sharp s U+1E9E maps to U+00DF",
    input: "\u1e9e@x.es",
    expected: "\u00df@x.es",
  },

  // ---- "Nothing else" -------------------------------------------------------
  {
    name: "no dot-stripping in the local part",
    input: "ana.garcia@gmail.com",
    expected: "ana.garcia@gmail.com",
  },
  {
    name: "no plus-suffix removal",
    input: "ana+vitrina@x.es",
    expected: "ana+vitrina@x.es",
  },
  {
    // Not IDNA: the domain is lowercased like everything else and left as
    // Unicode, never punycoded.
    name: "no IDNA on the domain",
    input: "ana@M\u00fcnchen.de",
    expected: "ana@m\u00fcnchen.de",
  },

  // ---- The §8.2 empty-after-normalisation case ------------------------------
  {
    // The function returns ""; the REJECTION is the use cases' (§8.2, 400 on
    // all three routes). Pinned here so the caller's check has a defined
    // input to check for.
    name: "whitespace-only normalises to the empty string",
    input: "   ",
    expected: "",
  },
  {
    name: "empty stays empty",
    input: "",
    expected: "",
  },
];

describe("normaliseAddress — §8.2 vectors", () => {
  for (const { name, input, expected } of vectors) {
    it(name, () => {
      const actual = normaliseAddress(input);
      assert.equal(
        actual,
        expected,
        `expected [${cps(expected)}], got [${cps(actual)}]`,
      );
    });
  }

  it("is idempotent on every vector", () => {
    // A normalisation that is not a fixed point is one that can be applied
    // a different number of times on two paths and disagree with itself.
    for (const { input } of vectors) {
      const once = normaliseAddress(input);
      assert.equal(normaliseAddress(once), once, `not idempotent: [${cps(input)}]`);
    }
  });

  it(
    "lowercase: capital sigma — Final_Sigma context or unconditional?",
    { todo: "§8.2 says unconditional; V8's toLowerCase applies Final_Sigma (ΣΑΣ → σας). Doc or code moves; pin the answer here." },
    () => {
      // Unconditional mapping: every Σ → σ, no final-form ς.
      assert.equal(normaliseAddress("\u03a3\u0391\u03a3@x.es"), "\u03c3\u03b1\u03c3@x.es");
    },
  );

  it("collapses alternative spellings", () => {
    collapses(["Ana@X.es", " ana@x.es", "ANA@x.es\t", "Ana@X.ES\u00a0"]);
    collapses(["caf\u00e9@x.es", "cafe\u0301@x.es"]);
  });

  it("does not merge distinct addresses", () => {
    assert.notEqual(normaliseAddress("ana@x.es"), normaliseAddress("a.na@x.es"));
    assert.notEqual(normaliseAddress("ana@x.es"), normaliseAddress("ana+1@x.es"));
    assert.notEqual(normaliseAddress("ana@x.es"), normaliseAddress("\u00e1na@x.es"));
    assert.notEqual(normaliseAddress("ana maria@x.es"), normaliseAddress("anamaria@x.es"));
  });
});

/*
 * The route-table walk brief §6 #16 rests on, over the audit surface in
 * schemas/ — api-sketch §4.1 and §7.2, §6.2's owed rows.
 *
 * §6.2 names /signup as the subject to write it against: it accepts the
 * wrapping every album key in the account hangs off, so it is the
 * highest-consequence body in the system. The distinction being encoded is
 * that a WRAPPED BLOB is ciphertext and may be posted, while the key that
 * wrapped it and the secret behind it may never be.
 *
 * This file grows with every PR that adds a schema; import it here or the walk
 * silently stops covering the surface it claims to.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import * as credentials from "../dist/adapters/driving/http/schemas/credentials.js";
import * as health from "../dist/adapters/driving/http/schemas/health.js";

const SCHEMAS = Object.entries({ ...credentials, ...health });

/**
 * Names that may never appear as a property, inbound or outbound. `wrapped_`
 * prefixes are deliberately absent: those ARE permitted, and listing them
 * would make this walk assert the opposite of §4.1.
 */
const FORBIDDEN = [
  "password",
  "passphrase",
  "kek",
  "k_master",
  "k_album",
  "master_key",
  "album_key",
  "secret",
  "pepper",
  "root",
];

/** Every property name anywhere in a schema, at any depth. */
function propertyNames(node, found = new Set()) {
  if (node === null || typeof node !== "object") return found;
  if (node.properties && typeof node.properties === "object") {
    for (const name of Object.keys(node.properties)) found.add(name);
  }
  for (const value of Object.values(node)) propertyNames(value, found);
  return found;
}

describe("the route table", () => {
  it("has a schema to walk", () => {
    // The walk is only as good as its coverage; zero schemas would pass every
    // assertion below.
    assert.ok(SCHEMAS.length >= 5, `only ${SCHEMAS.length} schemas found`);
  });

  for (const [name, schema] of SCHEMAS) {
    describe(name, () => {
      const names = [...propertyNames(schema)].map((n) => n.toLowerCase());

      it("declares no key material, inbound or outbound (§4.1, #16)", () => {
        for (const forbidden of FORBIDDEN) {
          const offenders = names.filter((n) => n === forbidden || n.endsWith(`_${forbidden}`));
          assert.deepEqual(offenders, [], `${name} declares ${offenders.join(", ")}`);
        }
      });

      it("declares no query string or path parameter at all (§7.2)", () => {
        // A token in a query string lands in access logs, in Referer headers
        // and in browser history — the same class as invite spec §2.1's `?`
        // where a `#` belongs. Scoped to querystring and params deliberately:
        // `token` in /login's RESPONSE is the session being returned, which is
        // the route's whole purpose, and an earlier version of this walk
        // flagged it.
        for (const section of ["querystring", "params", "headers"]) {
          assert.equal(schema[section], undefined, `${name} declares a ${section}`);
        }
      });
    });
  }

  it("permits wrapped blobs, which are ciphertext and may be posted", () => {
    // The other half of §4.1, asserted so the list above cannot be widened
    // into forbidding the material signup exists to carry.
    const names = [...propertyNames(credentials.signupSchema)];
    assert.ok(names.includes("wrapped_master"));
    assert.ok(names.includes("wrap_nonce"));
    assert.ok(names.includes("proof"));
  });
});

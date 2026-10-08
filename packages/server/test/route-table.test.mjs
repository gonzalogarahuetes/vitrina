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

import * as albums from "../dist/adapters/driving/http/schemas/albums.js";
import * as credentials from "../dist/adapters/driving/http/schemas/credentials.js";
import * as delivery from "../dist/adapters/driving/http/schemas/delivery.js";
import * as health from "../dist/adapters/driving/http/schemas/health.js";
import * as media from "../dist/adapters/driving/http/schemas/media.js";
import * as recipients from "../dist/adapters/driving/http/schemas/recipients.js";

// fragments.js is deliberately absent: it exports pieces, not route schemas,
// and adding it would count helpers towards the coverage guard below.
const SCHEMAS = Object.entries({
  ...albums,
  ...credentials,
  ...delivery,
  ...health,
  ...media,
  ...recipients,
});

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

/**
 * Forbidden in a RESPONSE only — §4.1's outbound half (PR 4). Matched EXACTLY,
 * not by suffix like the list above: `key` by suffix would flag §9.2's
 * `wrapped_key`, which is the wrapping that route exists to return. `proof` is
 * outbound-only because /signup and /login must accept it.
 */
const FORBIDDEN_IN_RESPONSE = ["key", "proof"];

/**
 * Forbidden in a REQUEST BODY only — §9.7: "no route accepts a `status` field,
 * on any body, ever". Scoped to `body` because §9.4 and §9.8 declare `status`
 * in their responses, where it is the route's purpose.
 */
const FORBIDDEN_IN_BODY = ["status"];

/**
 * Every path parameter any route may declare. An allowlist, not a `_id`
 * pattern, on the same reasoning as §1.2's log projection: additions get
 * argued one at a time.
 */
const PATH_PARAMETERS = ["album_id", "media_id", "recipient_id"];

/** §11.7's filters and cursor, and nothing else. Added one at a time, argued here. */
const QUERY_PARAMETERS = ["recipient_id", "media_id", "limit", "before"];

/** Never a query parameter, whatever the allowlist grows to (§7.2). */
const NEVER_IN_A_QUERY = ["token", "access_token", "key", "secret", "password"];

/** Every property name anywhere in a schema, at any depth. */
function propertyNames(node, found = new Set()) {
  if (node === null || typeof node !== "object") return found;
  if (node.properties && typeof node.properties === "object") {
    for (const name of Object.keys(node.properties)) found.add(name);
  }
  for (const value of Object.values(node)) propertyNames(value, found);
  return found;
}

/**
 * Every node declaring both `properties` and `required`. A `then` or `else`
 * carrying `required` alone is skipped: it constrains properties its parent
 * declares, which is §7.7's create body by design.
 */
function objectNodes(node, found = []) {
  if (node === null || typeof node !== "object") return found;
  if (Array.isArray(node.required) && node.properties && typeof node.properties === "object") {
    found.push(node);
  }
  for (const value of Object.values(node)) objectNodes(value, found);
  return found;
}

describe("the route table", () => {
  it("has a schema to walk", () => {
    // The walk is only as good as its coverage; zero schemas would pass every
    // assertion below.
    assert.ok(SCHEMAS.length >= 5, `only ${SCHEMAS.length} schemas found`);
  });

  it("the query allowlist admits nothing credential-shaped", () => {
    // The allowlist is the rule now, so it is the thing that must not grow a token.
    for (const name of QUERY_PARAMETERS) {
      const hit = NEVER_IN_A_QUERY.find((f) => name === f || name.endsWith(`_${f}`) || name.startsWith(`${f}_`));
      assert.equal(hit, undefined, `${name} is on the query allowlist`);
    }
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

      it("declares no header schema (§7.2)", () => {
        // A token in a query string lands in access logs, in Referer headers
        // and in browser history — the same class as invite spec §2.1's `?`
        // where a `#` belongs. Scoped to querystring and headers deliberately:
        // `token` in /login's RESPONSE is the session being returned, which is
        // the route's whole purpose, and an earlier version of this walk
        // flagged it.
        assert.equal(schema.headers, undefined, `${name} declares a headers schema`);
      });

      it("declares only allowlisted query parameters, closed (§7.2, §11.7)", () => {
        // Narrowed 8 October 2026 from "no querystring at all": §11.7's filters
        // are identifiers, not credentials. An ALLOWLIST, and closed — stronger
        // than the blanket rule for every name not on it.
        if (schema.querystring === undefined) return;

        for (const declared of Object.keys(schema.querystring.properties ?? {})) {
          assert.ok(
            QUERY_PARAMETERS.includes(declared),
            `${name} declares the query parameter ${declared}, which is not allowlisted`,
          );
        }
        // Without this, any other parameter reaches the handler. With it, Fastify's
        // removeAdditional strips it — measured, not rejected (access-log-routes).
        assert.equal(schema.querystring.additionalProperties, false, `${name}'s querystring is open`);
      });

      it("declares only allowlisted path parameters (§7.2, §9.3)", () => {
        // Narrowed 22 September 2026. This read `params === undefined`, true
        // only while every route was flat; §9's eight carry `{album_id}` and
        // `{media_id}`. §7.2's subject is a token in a log, not a path segment.
        if (schema.params === undefined) return;

        for (const declared of Object.keys(schema.params.properties ?? {})) {
          assert.ok(
            PATH_PARAMETERS.includes(declared),
            `${name} declares the path parameter ${declared}, which is not allowlisted`,
          );
        }
      });

      it("returns no field named for a key (§4.1's outbound half)", () => {
        if (schema.response === undefined) return;

        const outbound = [...propertyNames(schema.response)].map((n) => n.toLowerCase());
        const offenders = outbound.filter((n) => FORBIDDEN_IN_RESPONSE.includes(n));
        assert.deepEqual(offenders, [], `${name} returns ${offenders.join(", ")}`);
      });

      it("requires only properties it declares", () => {
        /*
         * Structural, at every depth. A `required` name missing from
         * `properties` is a 500 on every success, not a validation detail:
         * with `additionalProperties: false` the serialiser drops the field the
         * handler sent, then throws because it is required. PR 4's key route
         * shipped exactly this — `kdfSalt` declared, `kdf_salt` required — and
         * nothing else in this file could see it.
         */
        for (const node of objectNodes(schema)) {
          for (const required of node.required) {
            assert.ok(
              Object.hasOwn(node.properties, required),
              `${name} requires ${required} but declares only ${Object.keys(node.properties).join(", ")}`,
            );
          }
        }
      });

      it("accepts no server-set field in a request body (§9.7)", () => {
        // Vacuous until §9's schemas are imported above — nothing in PR 2b has
        // a `status` to declare. Provision, marked as such.
        if (schema.body === undefined) return;

        const inBody = [...propertyNames(schema.body)].map((n) => n.toLowerCase());
        for (const forbidden of FORBIDDEN_IN_BODY) {
          assert.ok(
            !inBody.includes(forbidden),
            `${name} accepts ${forbidden} in its request body`,
          );
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

  it("permits create-recipient's wrapping — §4.1's second audit subject", () => {
    /*
     * §7.7: this route "accepts wrap material and no key material". The walk
     * above proves the second half; this proves the first, so the forbidden
     * list cannot grow to cover `wrapped` or `kdf_salt` without a test going
     * red. Checked in the BODY's top-level properties, because Fastify's
     * removeAdditional strips anything declared only inside `then`/`else`
     * before the handler sees it.
     */
    const declared = Object.keys(recipients.createRecipientSchema.body.properties);
    for (const field of [
      "wrapped",
      "wrap_nonce",
      "kdf_salt",
      "kdf_memory_kib",
      "kdf_iterations",
      "kdf_parallelism",
      "token_hash",
      "label",
    ]) {
      assert.ok(declared.includes(field), `createRecipientSchema does not declare ${field}`);
    }
  });

  it("permits §10.1's wrapping in a response — the outbound converse", () => {
    /*
     * §4.1's outbound half allows a wrapped blob and its public parameters,
     * and this proves the forbidden lists above have not grown to cover them.
     * All seven, required: the client cannot unwrap with any one missing, and
     * `id` is in the wrap AAD with no other source (invite spec §4).
     */
    const ok = recipients.retrieveRecipientKeySchema.response[200];
    const fields = [
      "id",
      "wrapped",
      "wrap_nonce",
      "kdf_salt",
      "kdf_memory_kib",
      "kdf_iterations",
      "kdf_parallelism",
    ];
    assert.deepEqual(Object.keys(ok.properties).sort(), [...fields].sort());
    assert.deepEqual([...ok.required].sort(), [...fields].sort());
    assert.equal(ok.additionalProperties, false, "the allowlist is what keeps `label` out");
  });

  it("§10.1 takes nothing from the request but the token", () => {
    // No path id is the scope check; a body, a query string or a path
    // parameter would each be a second, disagreeable source of identity.
    const schema = recipients.retrieveRecipientKeySchema;
    for (const section of ["body", "params", "querystring", "headers"]) {
      assert.equal(schema[section], undefined, `retrieveRecipientKeySchema declares ${section}`);
    }
  });

  it("takes the album from the path and never from the body (§7.8's table)", () => {
    // At create there is no recipient row, so the album must be an input —
    // and §7.3 resolves scope from the path, before the body is parsed.
    const schema = recipients.createRecipientSchema;
    assert.ok(Object.keys(schema.params.properties).includes("album_id"));
    assert.ok(!propertyNames(schema.body).has("album_id"));
  });

  for (const [name, schema] of [
    ["logoutSchema", credentials.logoutSchema],
    ["logoutAllSchema", credentials.logoutAllSchema],
    ["revokeRecipientSchema", recipients.revokeRecipientSchema],
  ]) {
    it(`${name} declares no body (§7.5, §7.8)`, () => {
      /*
       * The bearer token identifies the session; the path identifies the
       * recipient. A body would be a second, disagreeable source — and on
       * /logout, §7.5's rejected `{token}` shape, a plaintext token in a body.
       */
      assert.equal(schema.body, undefined, `${name} declares a request body`);
    });
  }
});

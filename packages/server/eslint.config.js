/*
 * The dependency rule, as a failing build.
 *
 * vitrina-server-architecture.md §1 states it: imports point inward only,
 * `adapters → application → domain`, never back. §6 states that it "is not
 * advisory" and asks for exactly this — the same move as the forbidden-crypto
 * gate in CI: "a rule that can become a failing build should. The moment the
 * boundary can fail CI it stops depending on anyone's memory."
 *
 * Scoped per-layer with flat config's `files`, so each layer is told only what
 * it may not reach for. Deliberately blunt: it is easier to loosen a rule that
 * fired wrongly than to notice a boundary that quietly stopped existing.
 *
 * Verified by deliberately violating it, per the discipline track-b-plan §3 B.3
 * applies to that gate: "Test that deliberately, then revert it."
 *
 * Note: this file deliberately does not spell out the banned identifier that
 * scripts/check-forbidden-constructions.sh greps for. That script scans
 * crates/ and packages/, so naming it here would fail CI — the same reason the
 * ban is written down in spec/ and CLAUDE.md instead.
 */

/*
 * Babel's parser rather than @typescript-eslint/parser, and that is not a
 * preference: typescript-eslint 8.67 (latest as of August 2026) refuses to load
 * against TypeScript 7.0 — "typescript-eslint does not support TS 7.0", with
 * support for >= 7.1 still open upstream. Babel parses TS syntax without
 * consulting the TypeScript compiler, so this config is insulated from that
 * churn entirely.
 *
 * The trade is that type-aware rules are unavailable here. Irrelevant for the
 * boundary rule below, which reads import specifiers only. Revisit if
 * type-aware linting is ever wanted; `tsc --noEmit` covers types today.
 */
import babelParser from "@babel/eslint-parser";

/*
 * Vendors the core must never name. `pg-*` catches the driver's sub-packages,
 * and both aws-sdk spellings are listed because v2 and v3 differ.
 */
const FORBIDDEN_VENDORS = [
  "fastify",
  "@fastify/*",
  "pg",
  "pg-*",
  "aws-sdk",
  "@aws-sdk/*",
];

const VENDOR_MESSAGE =
  "domain/ and application/ must not name a vendor (vitrina-server-architecture.md §1). " +
  "Depend on a port in application/ports/ and implement it in adapters/driven/.";

const OUTWARD_MESSAGE =
  "Imports point inward only: adapters -> application -> domain (vitrina-server-architecture.md §1). " +
  "This import points outward.";

/*
 * `@vitrina/shared` holds wire-format types — architecture §4 decision 5: "DTOs
 * and JSON Schemas are adapter concerns, in driving/http, never in domain/".
 *
 * Without this, the §1.4 move of `ErrorCode` out of `error-envelope.ts` enforced
 * decision 5 in one direction only. A domain entity leaking into `shared/` is
 * caught by review; a wire type reaching `domain/` was caught by nothing, and it
 * is the direction that actually happens — `ErrorBody` is now one import away
 * from any file in the tree.
 *
 * Applied to `application/` as well as `domain/`, on this file's own stated
 * principle: "easier to loosen a rule that fired wrongly than to notice a
 * boundary that quietly stopped existing." Inert today — the only importer is
 * `adapters/driving/http/error-envelope.ts`, which is where decision 5 puts it.
 * If a use case ever has a genuine reason to name a wire type, that is a
 * decision worth making out loud, and deleting a line here is how it is made.
 */
const WIRE_TYPES = ["@vitrina/shared", "@vitrina/shared/*"];

const WIRE_MESSAGE =
  "@vitrina/shared carries wire-format types; DTOs are adapter concerns, never domain/ " +
  "(vitrina-server-architecture.md §4 decision 5). Define the shape this layer needs in its own terms.";

export default [
  {
    ignores: ["dist/**", "node_modules/**"],
  },
  {
    files: ["**/*.ts"],
    languageOptions: {
      parser: babelParser,
      ecmaVersion: "latest",
      sourceType: "module",
      parserOptions: {
        requireConfigFile: false,
        babelOptions: {
          presets: ["@babel/preset-typescript"],
          // Babel needs a filename to pick the TS syntax variant; ESLint
          // supplies the real one per file.
          filename: "file.ts",
        },
      },
    },
  },
  {
    // "domain/ imports nothing but itself." — vitrina-server-architecture.md §1
    files: ["src/domain/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            { group: FORBIDDEN_VENDORS, message: VENDOR_MESSAGE },
            {
              group: ["**/adapters/**", "**/application/**"],
              message: OUTWARD_MESSAGE,
            },
            { group: WIRE_TYPES, message: WIRE_MESSAGE },
          ],
        },
      ],
    },
  },
  {
    // application/ may import domain/ and its own ports, nothing outward.
    files: ["src/application/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            { group: FORBIDDEN_VENDORS, message: VENDOR_MESSAGE },
            { group: ["**/adapters/**"], message: OUTWARD_MESSAGE },
            { group: WIRE_TYPES, message: WIRE_MESSAGE },
          ],
        },
      ],
    },
  },
];

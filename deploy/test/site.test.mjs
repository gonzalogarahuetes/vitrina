/*
 * site.mjs: production unless told otherwise, and never a malformed name —
 * the rehearsal's only protection against talking to production is that the
 * names it exports are the names every Mac-side script uses.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const SITE = fileURLToPath(new URL("../release/site.mjs", import.meta.url));
const read = (env) =>
  spawnSync(
    process.execPath,
    ["--input-type=module", "-e", "const s = await import(process.argv[1]); console.log(s.APP, s.API)", SITE],
    { env: { PATH: process.env.PATH, ...env }, encoding: "utf8" },
  );

test("defaults to production", () => {
  assert.equal(read({}).stdout.trim(), "https://app.lirioapp.eu https://api.lirioapp.eu");
});

test("the rehearsal's names replace both", () => {
  const r = read({ VITRINA_APP_HOST: "dr-app.example.org", VITRINA_API_HOST: "dr-api.example.org" });
  assert.equal(r.stdout.trim(), "https://dr-app.example.org https://dr-api.example.org");
});

test("a malformed name stops the script instead of falling back", () => {
  for (const bad of ["dr app.example.org", "https://dr.example.org", "localhost", "-x.example.org"]) {
    const r = read({ VITRINA_API_HOST: bad });
    assert.equal(r.status, 2, bad);
    assert.match(r.stderr, /not a hostname/);
  }
});

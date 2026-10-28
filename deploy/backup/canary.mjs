/*
 * A scripted owner for the rehearsal's verify-by-violation step, so the
 * secret's effect on sign-in is shown by a machine as well as by the owner.
 *
 *   node canary.mjs signup <api-origin> <state-file> <email>   create it, keep its proof
 *   node canary.mjs login  <api-origin> <state-file>   prints the HTTP status and code
 *
 * Its proof is 32 random bytes derived from no password, and its wrapping is
 * random bytes that unwrap nothing — the infra journeys' pattern. It can sign
 * in and do nothing else. The state file lives in the rehearsal directory only.
 */

import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

const [cmd, origin, stateFile, email] = process.argv.slice(2);
const b64 = (n) => randomBytes(n).toString("base64url");

async function post(path, body) {
  const res = await fetch(`${origin}/v1${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, code: json.code };
}

if (cmd === "signup") {
  // The address is given, so the caller can put it on SIGNUP_ALLOWLIST first.
  const state = { email: email ?? `canary-${randomUUID()}@rehearsal.invalid`, proof: b64(32) };
  const r = await post("/signup", {
    email: state.email,
    proof: state.proof,
    kdf_salt: b64(16),
    kdf_memory_kib: 65536,
    kdf_iterations: 3,
    kdf_parallelism: 1,
    wrapped_master: b64(48),
    wrap_nonce: b64(24),
  });
  if (r.status !== 201) {
    console.error(`canary signup: ${r.status} ${r.code ?? ""}`);
    process.exit(1);
  }
  writeFileSync(stateFile, JSON.stringify(state), { mode: 0o600 });
  console.log("canary signup 201");
} else if (cmd === "login") {
  const state = JSON.parse(readFileSync(stateFile, "utf8"));
  const r = await post("/login", { email: state.email, proof: state.proof });
  console.log(`${r.status} ${r.code ?? "ok"}`);
} else {
  console.error(`unknown command: ${cmd}`);
  process.exit(2);
}

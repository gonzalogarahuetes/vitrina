/*
 * Is a secret anywhere in the repository — any tracked file, or any commit's
 * diff on any branch? Asked with fingerprints, so the Mac never holds the
 * values: each comes as name:length:sha256, and every window of that length
 * in every token of the right alphabet is hashed and compared. A window, not a
 * whole token, so a secret glued into a URL or a longer string is still found.
 *
 *   node secret-scan.mjs <repo-dir> NAME:LENGTH:SHA256 [...]
 *
 * Exit 0: none found. Exit 1: found, with where. Exit 2: bad arguments.
 * Read-only: git ls-files and git log, nothing that writes.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const [repo, ...specs] = process.argv.slice(2);
const targets = specs.map((s) => {
  const m = /^([A-Z0-9_]+):(\d+):([0-9a-f]{64})$/.exec(s);
  if (!m || Number(m[2]) < 16) {
    console.error(`secret-scan: not NAME:LENGTH:SHA256 (length ≥ 16): ${s}`);
    process.exit(2);
  }
  return { name: m[1], length: Number(m[2]), hash: m[3], found: [] };
});
if (!repo || targets.length === 0) {
  console.error("usage: secret-scan.mjs <repo-dir> NAME:LENGTH:SHA256 [...]");
  process.exit(2);
}

const git = (...args) => {
  const r = spawnSync("git", ["-C", repo, ...args], { maxBuffer: 1 << 30 });
  if (r.status !== 0) {
    console.error(`secret-scan: git ${args[0]} failed: ${r.stderr}`);
    process.exit(2);
  }
  return r.stdout;
};

// The alphabets of base64url, base64 and hex keys; '=' excluded so KEY=value splits.
const TOKEN = /[A-Za-z0-9+/_-]{16,}/g;
const sha256 = (s) => createHash("sha256").update(s).digest("hex");

function scan(text, where) {
  for (const [token] of text.matchAll(TOKEN)) {
    for (const t of targets) {
      for (let i = 0; i + t.length <= token.length; i++) {
        if (sha256(token.slice(i, i + t.length)) === t.hash) {
          if (!t.found.includes(where)) t.found.push(where);
          break;
        }
      }
    }
  }
}

// Every tracked file as it is now.
const files = git("ls-files", "-z").toString("utf8").split("\0").filter(Boolean);
for (const f of files) {
  let text;
  try {
    text = readFileSync(join(repo, f)).toString("latin1");
  } catch {
    continue; // listed but deleted in the working tree: history covers it
  }
  scan(text, f);
}

// Every commit's patch, every branch: a secret committed and later removed is still published.
let commit = "?";
for (const line of git("log", "--all", "-p", "--no-color", "--format=commit %H").toString("latin1").split("\n")) {
  const m = /^commit ([0-9a-f]{40})$/.exec(line);
  if (m) commit = m[1];
  else if (line.startsWith("+") || line.startsWith("-")) scan(line, `history ${commit.slice(0, 12)}`);
}

let leaked = 0;
for (const t of targets) {
  if (t.found.length) {
    leaked++;
    console.log(`FAIL ${t.name} is in the repository: ${t.found.join(", ")}`);
  } else console.log(`PASS ${t.name} appears in no tracked file and no commit (${files.length} files)`);
}
process.exit(leaked ? 1 : 0);

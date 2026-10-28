/*
 * A scripted owner, through Caddy, against the live API — the checks that
 * need a signed-in session. verify.sh runs it between walk-server.sh's open
 * (which invites this address for a few minutes) and close (which removes it
 * and the account again).
 *
 *   node walk.mjs <email> <user-agent-marker> <state-file>
 *
 * The server is format-blind (api-sketch §9.1), so random bytes stand in for
 * every ciphertext: no key exists, and nothing here could decrypt anything.
 * Writes { token, media } to the state file for close's log and bucket checks.
 */

import { randomBytes, randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";

import { API as API_ORIGIN } from "./site.mjs";

const API = `${API_ORIGIN}/v1`;
const [email, marker, stateFile] = process.argv.slice(2);
if (!email || !marker || !stateFile) {
  console.error("usage: walk.mjs <email> <user-agent-marker> <state-file>");
  process.exit(2);
}

let fails = 0;
const pass = (m) => console.log(`PASS ${m}`);
const bad = (m) => (fails++, console.log(`FAIL ${m}`));
const expect = (ok, m, got) => (ok ? pass(m) : bad(got === undefined ? m : `${m} — got ${got}`));
const b64 = (bytes) => Buffer.from(bytes).toString("base64url");

let token;
async function call(method, path, { json, body, headers = {}, init = {} } = {}) {
  const h = { "user-agent": marker, ...headers };
  if (token) h.authorization = `Bearer ${token}`;
  if (json !== undefined) h["content-type"] = "application/json";
  const res = await fetch(`${API}${path}`, {
    method,
    headers: h,
    body: json !== undefined ? JSON.stringify(json) : body,
    ...init,
  });
  const bytes = Buffer.from(await res.arrayBuffer());
  return { status: res.status, headers: res.headers, bytes, json: () => JSON.parse(bytes.toString("utf8")) };
}

const state = { token: null, media: [] };
const save = () => writeFileSync(stateFile, JSON.stringify(state), { mode: 0o600 });

try {
  // --- an account, an album, a photo ----------------------------------------
  const signup = await call("POST", "/signup", {
    json: {
      email,
      proof: b64(randomBytes(32)),
      kdf_salt: b64(randomBytes(16)),
      kdf_memory_kib: 65536,
      kdf_iterations: 3,
      kdf_parallelism: 1,
      wrapped_master: b64(randomBytes(48)),
      wrap_nonce: b64(randomBytes(24)),
    },
  });
  expect(signup.status === 201, "signup, for the address walk-server.sh invited", signup.status);
  token = state.token = signup.json().token;
  save();

  const albumId = randomUUID();
  const album = await call("POST", "/albums", {
    json: { id: albumId, title: b64(randomBytes(64)), wrapped_key: b64(randomBytes(48)), wrap_nonce: b64(randomBytes(24)) },
  });
  expect(album.status === 201, "album created", album.status);

  const newMedia = async () => {
    const id = randomUUID();
    const res = await call("POST", `/albums/${albumId}/media`, { json: { id, kind: "photo", metadata: b64(randomBytes(128)) } });
    expect(res.status === 201, "media row created", res.status);
    state.media.push(id);
    save();
    return id;
  };

  // --- §9.7 through Caddy: Content-Length kept, chunked refused ---------------
  const photo = await newMedia();
  const ASSET = randomBytes(300 * 1024); // more than one 256 KiB chunk
  const THUMB = randomBytes(2048);
  const octet = { "content-type": "application/octet-stream" };

  const asset = await call("PUT", `/media/${photo}/asset`, { body: ASSET, headers: octet });
  expect(asset.status === 200, "an upload with Content-Length reaches the API whole (Caddy did not switch it to chunked)", `${asset.status} ${asset.bytes.toString()}`);
  const thumb = await call("PUT", `/media/${photo}/thumbnail`, { body: THUMB, headers: octet });
  expect(thumb.status === 200 && thumb.json().status === "ready", "both objects in: the row is ready", `${thumb.status} ${thumb.bytes.toString()}`);

  const other = await newMedia();
  const chunked = await call("PUT", `/media/${other}/asset`, {
    headers: octet,
    body: new ReadableStream({
      start(c) {
        c.enqueue(new Uint8Array(randomBytes(4096)));
        c.close();
      },
    }),
    init: { duplex: "half" }, // a stream body with no length: Transfer-Encoding: chunked
  });
  expect(chunked.status === 411, "a chunked upload is refused with 411 (Caddy did not buffer it into a length)", chunked.status);

  // --- §11.2 through Caddy: ranges, no-store, nothing compressed ---------------
  const ranged = await call("GET", `/media/${photo}/asset`, { headers: { range: "bytes=0-99", "accept-encoding": "gzip, br, zstd" } });
  expect(ranged.status === 206, "a ranged GET answers 206", ranged.status);
  expect(ranged.headers.get("content-range") === `bytes 0-99/${ASSET.length}`, "Content-Range is the store's, forwarded", ranged.headers.get("content-range"));
  expect(ranged.bytes.equals(ASSET.subarray(0, 100)), "the 100 bytes are the uploaded ones");
  expect(!ranged.headers.get("content-encoding"), "ciphertext is not compressed", ranged.headers.get("content-encoding"));
  expect(ranged.headers.get("cache-control") === "no-store", "Cache-Control: no-store on ciphertext", ranged.headers.get("cache-control"));

  const middle = await call("GET", `/media/${photo}/asset`, { headers: { range: `bytes=${256 * 1024}-` } });
  expect(middle.status === 206 && middle.bytes.equals(ASSET.subarray(256 * 1024)), "the second chunk alone, without the first");

  const t = await call("GET", `/media/${photo}/thumbnail`);
  expect(t.status === 200 && t.bytes.equals(THUMB), "the thumbnail whole", t.status);

  // --- §9.11: erase what this walk stored -------------------------------------
  for (const id of state.media) {
    const del = await call("DELETE", `/media/${id}`);
    expect(del.status === 204, `media ${id.slice(0, 8)} removed and erased (204)`, del.status);
  }
} catch (error) {
  bad(`the walk stopped: ${error.message}`);
}

save();
console.log(fails === 0 ? "\nwalk: all PASS" : `\nwalk: ${fails} FAIL`);
process.exit(fails === 0 ? 0 : 1);

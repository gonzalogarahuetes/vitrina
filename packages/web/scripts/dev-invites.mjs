#!/usr/bin/env node
/*
 * Development only: seeds the local relay with one album and prints a QR
 * invite and a passphrase invite for walking the recipient path by hand.
 *
 * From the repository root:
 *
 *   pnpm infra:up && pnpm infra:wait
 *   pnpm --filter @vitrina/server build
 *   node --env-file=.env packages/server/dist/index.js   # http://localhost:3000
 *   node packages/web/scripts/dev-invites.mjs            # prints two links
 *   pnpm --filter @vitrina/web dev                       # http://localhost:5173
 *
 * (`pnpm --filter @vitrina/server start` does not load .env, so the server
 * refuses to start.)
 *
 * The owner's screens now create invites (flows §3.8); this remains a quick
 * seed for the recipient path only. Everything goes through the API, as
 * infra/pr5-journey.test.mjs does it, and the owner half is as thin as that
 * test's: the owner's key material is random and never unlocked. The photos are
 * generated PNGs, so nothing from a camera is involved. The passphrase comes
 * from a tiny fixed list: it is NOT a vetted wordlist (encryption spec §6.3)
 * and is fit for nothing but this script.
 */
import { createHash, randomBytes, randomInt, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { deflateSync } from "node:zlib";

const API = process.env.VITE_API_ORIGIN ?? "http://localhost:3000";
const APP = process.env.APP_ORIGIN ?? "http://localhost:5173";
const WASM_DIR = new URL("../../envelope/wasm/", import.meta.url);

const { default: init, ...envelope } = await import(new URL("envelope.js", WASM_DIR));
await init({ module_or_path: await readFile(new URL("envelope_bg.wasm", WASM_DIR)) });

const b64 = (bytes) => Buffer.from(bytes).toString("base64url");
const sha256 = (bytes) => createHash("sha256").update(bytes).digest();
const idBytes = (uuid) => Buffer.from(uuid.replaceAll("-", ""), "hex");

async function call(method, path, { body, token } = {}) {
  const headers = {};
  if (token) headers.authorization = `Bearer ${b64(token)}`;
  let payload;
  if (body instanceof Uint8Array) {
    headers["content-type"] = "application/octet-stream";
    payload = body;
  } else if (body !== undefined) {
    headers["content-type"] = "application/json";
    payload = JSON.stringify(body);
  }
  const res = await fetch(`${API}/v1${path}`, { method, headers, body: payload });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${text}`);
  return text ? JSON.parse(text) : null;
}

// ── A minimal PNG encoder: RGB, 8 bit, filter "Sub" on every row ──────────

const CRC = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "ascii");
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}
function png(w, h, pixel) {
  const raw = Buffer.alloc(h * (1 + w * 3));
  for (let y = 0; y < h; y++) {
    const row = y * (1 + w * 3);
    raw[row] = 1; // Sub
    let prev = [0, 0, 0];
    for (let x = 0; x < w; x++) {
      const px = pixel(x, y);
      for (let c = 0; c < 3; c++) {
        raw[row + 1 + x * 3 + c] = (px[c] - prev[c]) & 0xff;
      }
      prev = px;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** A landscape or portrait gradient with a grid, so zoom and pan are visible; `noise` makes it multi-chunk. */
function picture(w, h, hue, noise) {
  const base = [
    [196, 138, 112],
    [124, 145, 135],
    [145, 127, 152],
    [127, 147, 171],
    [173, 152, 120],
    [138, 154, 124],
  ][hue % 6];
  return png(w, h, (x, y) => {
    const t = (x / w + y / h) / 2;
    const line = x % Math.round(w / 8) < 3 || y % Math.round(h / 6) < 3;
    const n = noise ? randomInt(0, 48) : 0;
    return base.map((c) => (line ? 250 : Math.round(c * (0.55 + 0.6 * t)) + n) & 0xff);
  });
}

// ── The owner's half, as thin as infra/pr5-journey.test.mjs ───────────────

const signup = await call("POST", "/signup", {
  body: {
    email: `dev-${randomUUID()}@vitrina.test`,
    proof: b64(randomBytes(32)),
    kdf_salt: b64(randomBytes(16)),
    kdf_memory_kib: 65536,
    kdf_iterations: 3,
    kdf_parallelism: 1,
    wrapped_master: b64(randomBytes(48)),
    wrap_nonce: b64(randomBytes(24)),
  },
});
const owner = Buffer.from(signup.token, "base64url");

const albumId = randomUUID();
// Drawn inside the module, as the owner's client does: K_album never exists as
// JavaScript bytes, here or in any invite (encryption spec §6.1).
const albumKey = envelope.AlbumKey.generate();
await call("POST", "/albums", {
  token: owner,
  body: {
    id: albumId,
    title: b64(envelope.encryptAlbumTitle(albumKey, idBytes(albumId), "Summer at the lake")),
    wrapped_key: b64(randomBytes(48)),
    wrap_nonce: b64(randomBytes(24)),
  },
});

const shapes = [
  [1600, 1200, false],
  [1200, 1600, false],
  [1600, 900, true], // over 256 KiB: a multi-chunk envelope
  [1600, 1200, false],
  [1080, 1080, false],
];
for (const [i, [w, h, noise]] of shapes.entries()) {
  const id = randomUUID();
  const photo = picture(w, h, i, noise);
  const thumbW = Math.round((w / Math.max(w, h)) * 400);
  const thumbH = Math.round((h / Math.max(w, h)) * 400);
  const thumb = picture(thumbW, thumbH, i, false);
  await call("POST", `/albums/${albumId}/media`, {
    token: owner,
    body: { id, kind: "photo", metadata: b64(envelope.encryptMeta(albumKey, idBytes(id), Buffer.from(JSON.stringify({ width: w, height: h })))) },
  });
  await call("PUT", `/media/${id}/asset`, { token: owner, body: envelope.encryptAsset(albumKey, idBytes(id), photo) });
  await call("PUT", `/media/${id}/thumbnail`, { token: owner, body: envelope.encryptThumb(albumKey, idBytes(id), thumb) });
  process.stderr.write(`photo ${i + 1}: ${w}×${h}, ${photo.length} bytes\n`);
}
// One item left `pending`: the recipient must not see it (api-sketch §9.4).
{
  const id = randomUUID();
  await call("POST", `/albums/${albumId}/media`, {
    token: owner,
    body: { id, kind: "photo", metadata: b64(envelope.encryptMeta(albumKey, idBytes(id), Buffer.from(JSON.stringify({ width: 1, height: 1 })))) },
  });
}

const fragmentBase = `v=1&a=${b64(idBytes(albumId))}`;

// QR invite (encryption spec §6.1): a random K_invite travels in the fragment,
// and the relay stores K_album wrapped under it.
const qr = { id: randomUUID(), token: randomBytes(32) };
const invite = envelope.InviteKey.generate();
const inviteWrapping = envelope.wrapAlbumKeyForInvite(albumKey, invite, idBytes(qr.id));
const inviteBytes = invite.toInviteBytes();
invite.free();
await call("POST", `/albums/${albumId}/recipients`, {
  token: owner,
  body: {
    id: qr.id,
    kind: "qr",
    label: b64(envelope.encryptRecipientLabel(albumKey, idBytes(qr.id), "María")),
    token_hash: b64(sha256(qr.token)),
    wrapped: b64(inviteWrapping.wrapped),
    wrap_nonce: b64(inviteWrapping.wrapNonce),
  },
});

// Passphrase invite: the key is wrapped under the passphrase, v1 parameters.
const WORDS = ["lantern", "orchard", "pebble", "meadow", "harbour", "violet", "copper", "willow", "saffron", "thistle", "ember", "juniper"];
const passphrase = Array.from({ length: 5 }, () => WORDS[randomInt(WORDS.length)]).join(" ");
const pp = { id: randomUUID(), token: randomBytes(32) };
const params = envelope.WrapParams.v1();
const wrapping = envelope.wrapAlbumKey(albumKey, passphrase, params, idBytes(pp.id));
await call("POST", `/albums/${albumId}/recipients`, {
  token: owner,
  body: {
    id: pp.id,
    kind: "passphrase",
    label: b64(envelope.encryptRecipientLabel(albumKey, idBytes(pp.id), "Abuelo Juan")),
    token_hash: b64(sha256(pp.token)),
    wrapped: b64(wrapping.wrapped),
    wrap_nonce: b64(wrapping.wrapNonce),
    kdf_salt: b64(wrapping.kdfSalt),
    kdf_memory_kib: 65536,
    kdf_iterations: 3,
    kdf_parallelism: 1,
  },
});

console.log(`QR invite (María):\n  ${APP}/v/#${fragmentBase}&t=${b64(qr.token)}&k=${b64(inviteBytes)}\n`);
inviteBytes.fill(0);
console.log(`Passphrase invite (Abuelo Juan):\n  ${APP}/v/#${fragmentBase}&t=${b64(pp.token)}\n  passphrase: ${passphrase}\n`);
console.log(`To test revocation:\n  curl -X POST -H 'authorization: Bearer ${b64(owner)}' ${API}/v1/recipients/${qr.id}/revoke`);

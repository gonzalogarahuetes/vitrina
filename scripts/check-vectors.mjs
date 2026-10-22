#!/usr/bin/env node
/*
 * scripts/check-vectors — encryption spec §9.2: "where no external anchor
 * exists, an independent reimplementation is the nearest substitute", and "a
 * check that happened once and cannot be re-run is a claim rather than a check".
 *
 * Re-derives committed vectors from the spec alone, without the crate: a
 * different language, a different library (@noble/ciphers, not RustCrypto),
 * and every construction written out here from the spec text rather than
 * imported. If this file and the crate agree, two implementations agree; if
 * the crate is wrong, the vectors it generated are wrong and this fails.
 *
 * Covered: category 20 and §9.1 vector 9 (encryption spec §6.1). Categories
 * 9, 16, 17, 18 and 19 and protocol vectors 4 and 7 are still owed (§9.2).
 *
 * Reads spec/vectors/vitrina-vectors.json; never writes it. Exits non-zero
 * naming every failed check.
 */
import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import { readFile } from "node:fs/promises";

const FILE = new URL("../spec/vectors/vitrina-vectors.json", import.meta.url);

const unhex = (s) => Uint8Array.from(Buffer.from(s, "hex"));
const hex = (b) => Buffer.from(b).toString("hex");
const ascii = (s) => Uint8Array.from(Buffer.from(s, "ascii"));
const concat = (...parts) => Uint8Array.from(parts.flatMap((p) => [...p]));

/** XChaCha20-Poly1305 decrypt that reports failure as null rather than throwing. */
function open(key, nonce, aad, sealed) {
  try {
    return xchacha20poly1305(key, nonce, aad).decrypt(sealed);
  } catch {
    return null;
  }
}

const failures = [];
const passed = [];
function check(name, ok, detail = "") {
  (ok ? passed : failures).push(ok ? name : `${name}${detail ? `: ${detail}` : ""}`);
}

const file = JSON.parse(await readFile(FILE, "utf8"));

// ── Gate: category 7, the XChaCha20-Poly1305 anchor (§9.2) ──────────────────
// "Every external anchor must pass before any self-generated vector that
// depends on it is produced" — and before this script's own primitive is
// trusted to judge one. If @noble/ciphers does not reproduce draft-03 A.3.1,
// nothing below means anything, so a failure here stops the run.
{
  const a = file.anchors.xchacha20poly1305;
  const got = xchacha20poly1305(unhex(a.key), unhex(a.nonce), unhex(a.aad)).encrypt(unhex(a.plaintext));
  check("category 7: @noble/ciphers reproduces the XChaCha20-Poly1305 anchor", hex(got) === a.ciphertext_and_tag);
  if (failures.length > 0) {
    console.error(`check-vectors: the anchor failed, nothing else was checked\n  ${failures.join("\n  ")}`);
    process.exit(1);
  }
}

// ── §9.1 vector 9 and category 20: §6.1's invite wrap ───────────────────────
// Written from §6.1: AAD = "vitrina-invite-wrap-v1" (22 ASCII bytes, no
// terminator, no length prefix) ‖ recipient_id (16 raw bytes);
// wrapped = XChaCha20-Poly1305(key = K_invite, nonce = wrap_nonce, msg = K_album, aad).
const INVITE_WRAP_DOMAIN = ascii("vitrina-invite-wrap-v1");
const inviteWrapAad = (recipientId) => concat(INVITE_WRAP_DOMAIN, recipientId);

const v9 = file.protocol.invite_wrap_aad;
check("protocol 9: present in the file", v9 !== undefined, "regenerate the vectors (cargo test -p vitrina-envelope generate_vectors -- --ignored)");
if (v9 !== undefined) {
  const v = v9;
  check("protocol 9: is vector 9", v.vector === 9);
  check("protocol 9: recipient_id is vector 5's", v.recipient_id === file.protocol.wrap_aad.recipient_id);
  const aad = inviteWrapAad(unhex(v.recipient_id));
  check("protocol 9: the domain string is 22 bytes", INVITE_WRAP_DOMAIN.length === 22);
  check("protocol 9: the AAD is 38 bytes", aad.length === 38, `got ${aad.length}`);
  check("protocol 9: the AAD matches the file", hex(aad) === v.aad, `derived ${hex(aad)}, file ${v.aad}`);
}

const c20 = file.invite_wrap ?? [];
check("category 20: exactly one entry", c20.length === 1, `got ${c20.length}`);
for (const v of c20) {
  const kAlbum = unhex(v.k_album);
  const kInvite = unhex(v.k_invite);
  const recipientId = unhex(v.recipient_id);
  const nonce = unhex(v.wrap_nonce);
  const aad = inviteWrapAad(recipientId);

  check("category 20: is category 20", v.category === 20);
  check("category 20: field lengths are §6.1's", [kAlbum.length, kInvite.length, recipientId.length, nonce.length] + "" === "32,32,16,24");
  check("category 20: K_invite is not K_album", v.k_invite !== v.k_album);
  check("category 20: recipient_id is vector 5's", v.recipient_id === file.protocol.wrap_aad.recipient_id);
  check("category 20: K_album is category 1's", v.k_album === file.envelope[0].k_album);

  const wrapped = xchacha20poly1305(kInvite, nonce, aad).encrypt(kAlbum);
  check("category 20: wrapped is 48 bytes", wrapped.length === 48);
  check("category 20: wrapped matches the file", hex(wrapped) === v.wrapped, `derived ${hex(wrapped)}, file ${v.wrapped}`);

  const opened = open(kInvite, nonce, aad, unhex(v.wrapped));
  check("category 20: the committed blob opens to K_album", opened !== null && hex(opened) === v.k_album);

  // What the distinct domain string buys (§6.1), with the key held constant:
  // the same blob under the same K_invite and recipient_id, but another
  // domain's AAD, must not authenticate. Neither must a one-bit-off id.
  for (const [name, domain] of [
    ["the passphrase wrap's", "vitrina-wrap-v1"],
    ["the album wrap's", "vitrina-album-wrap-v1"],
  ]) {
    const crossed = open(kInvite, nonce, concat(ascii(domain), recipientId), unhex(v.wrapped));
    check(`category 20: the blob does not open under ${name} AAD`, crossed === null);
  }
  const otherId = recipientId.slice();
  otherId[15] ^= 0x01;
  check("category 20: the blob does not open under another recipient_id", open(kInvite, nonce, inviteWrapAad(otherId), unhex(v.wrapped)) === null);
}

if (failures.length > 0) {
  console.error(`check-vectors: ${failures.length} failed, ${passed.length} passed\n  ${failures.join("\n  ")}`);
  process.exit(1);
}
console.log(`check-vectors: ${passed.length} checks passed (category 7 gate, category 20, §9.1 vector 9)`);

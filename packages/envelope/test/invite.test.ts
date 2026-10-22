/*
 * §6.1's invite wrap through the binding: K_album under K_invite, bound to
 * recipient_id by the AAD "vitrina-invite-wrap-v1" ‖ recipient_id.
 *
 * AlbumKey has no byte getter (§2.2), so an unwrapped K_album is proven by
 * what it decrypts, never by comparison. K_invite is the opposite case: its
 * bytes leave on purpose, so the recipient half here starts from
 * toInviteBytes() exactly as a client starts from the URL fragment.
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { caught, loadEnvelope, type AlbumKey } from "./load.js";

const e = await loadEnvelope();

const ASSET_ID = Uint8Array.from({ length: 16 }, (_, i) => 0xb0 + i);
const PASSPHRASE = "Café Roble";
const lowParams = new e.WrapParams(8, 1, 1);
const random = (n: number) => new Uint8Array(randomBytes(n));

/** True if `candidate` decrypts what `album` encrypted: the only way to compare K_album. */
function sameAlbumKey(album: AlbumKey, candidate: AlbumKey): boolean {
  const plaintext = random(100);
  const object = e.encryptAsset(album, ASSET_ID, plaintext);
  try {
    return Buffer.from(e.decryptAsset(candidate, ASSET_ID, object)).equals(Buffer.from(plaintext));
  } catch {
    return false;
  }
}

test("owner to recipient: generate, wrap, export the bytes, rebuild from them, unwrap", () => {
  const album = e.AlbumKey.generate();
  const recipientId = random(16);

  // Owner: K_invite drawn inside the module, the wrapping posted, the bytes put in the fragment.
  const ownerInvite = e.InviteKey.generate();
  const stored = e.wrapAlbumKeyForInvite(album, ownerInvite, recipientId);
  assert.equal(stored.wrapped.length, e.inviteWrappedLen());
  assert.equal(stored.wrapNonce.length, e.inviteWrapNonceLen());
  const fragmentBytes = ownerInvite.toInviteBytes();
  assert.equal(fragmentBytes.length, e.inviteKeyLen());
  ownerInvite.free();

  // Recipient: the bytes from the fragment, the wrapping from GET /v1/recipient/key.
  const recipientInvite = e.InviteKey.fromBytes(fragmentBytes);
  fragmentBytes.fill(0);
  const fetched = e.InviteWrappedKey.fromParts(stored.wrapped, stored.wrapNonce);
  const unwrapped = e.unwrapAlbumKeyWithInvite(fetched, recipientInvite, recipientId);

  assert.ok(sameAlbumKey(album, unwrapped), "the unwrapped key does not open what K_album encrypted");
});

test("generate draws a distinct K_invite every time", () => {
  const a = e.InviteKey.generate().toInviteBytes();
  const b = e.InviteKey.generate().toInviteBytes();
  assert.notDeepEqual(a, b);
});

test("every wrap draws a fresh wrap_nonce, so the same inputs never give the same wrapping", () => {
  const album = e.AlbumKey.generate();
  const invite = e.InviteKey.generate();
  const recipientId = random(16);

  const first = e.wrapAlbumKeyForInvite(album, invite, recipientId);
  const second = e.wrapAlbumKeyForInvite(album, invite, recipientId);

  assert.notDeepEqual(first.wrapNonce, second.wrapNonce);
  assert.notDeepEqual(first.wrapped, second.wrapped);
});

test("the wrapping is bound to recipient_id: one bit off is AuthenticationFailed", () => {
  const album = e.AlbumKey.generate();
  const invite = e.InviteKey.generate();
  const recipientId = random(16);
  const stored = e.wrapAlbumKeyForInvite(album, invite, recipientId);

  const otherId = recipientId.slice();
  otherId[15]! ^= 1;

  assert.equal(caught(() => e.unwrapAlbumKeyWithInvite(stored, invite, otherId)).code, "AuthenticationFailed");
});

test("the wrapping is bound to K_invite: another invite key is AuthenticationFailed", () => {
  const album = e.AlbumKey.generate();
  const recipientId = random(16);
  const stored = e.wrapAlbumKeyForInvite(album, e.InviteKey.generate(), recipientId);

  assert.equal(
    caught(() => e.unwrapAlbumKeyWithInvite(stored, e.InviteKey.generate(), recipientId)).code,
    "AuthenticationFailed",
  );
});

/*
 * Cross-mode. The binding cannot put one key under both modes: the passphrase
 * KEK never leaves the module. So these two tests are the realistic failure —
 * a relay, or a bug, handing one kind's wrapping to the other kind's unwrap —
 * and they would pass on the key difference alone. What isolates the domain
 * string is the test after them, and the crate's two in invite_wrap.rs.
 */
test("a passphrase-mode wrapping never opens with the invite unwrap", () => {
  const album = e.AlbumKey.generate();
  const recipientId = random(16);
  const passphraseWrapping = e.wrapAlbumKey(album, PASSPHRASE, lowParams, recipientId);

  const asInvite = e.InviteWrappedKey.fromParts(passphraseWrapping.wrapped, passphraseWrapping.wrapNonce);
  assert.equal(
    caught(() => e.unwrapAlbumKeyWithInvite(asInvite, e.InviteKey.generate(), recipientId)).code,
    "AuthenticationFailed",
  );
});

test("an invite wrapping never opens with the passphrase unwrap", () => {
  const album = e.AlbumKey.generate();
  const recipientId = random(16);
  const inviteWrapping = e.wrapAlbumKeyForInvite(album, e.InviteKey.generate(), recipientId);

  const asPassphrase = e.WrappedKey.fromParts(inviteWrapping.wrapped, inviteWrapping.wrapNonce, random(16));
  assert.equal(
    caught(() => e.unwrapAlbumKey(PASSPHRASE, lowParams, recipientId, asPassphrase)).code,
    "AuthenticationFailed",
  );
});

test("same key bytes, same 16-byte id: the invite and album-wrap domain strings alone keep them apart", () => {
  /*
   * The one place the binding CAN hold the key constant: MasterKey and
   * InviteKey both take 32 raw bytes, and album_id and recipient_id are both
   * 16. So key, id and AEAD are identical across the two calls, and only
   * "vitrina-invite-wrap-v1" vs "vitrina-album-wrap-v1" differs. The control
   * unwraps prove each wrapping is good under its own domain first.
   */
  const keyBytes = random(32);
  const id = random(16);
  const album = e.AlbumKey.generate();
  const invite = e.InviteKey.fromBytes(keyBytes);
  const master = e.MasterKey.fromBytes(keyBytes);

  const underInvite = e.wrapAlbumKeyForInvite(album, invite, id);
  const underMaster = e.wrapAlbumKeyWithMaster(album, master, id);

  // Controls.
  assert.ok(sameAlbumKey(album, e.unwrapAlbumKeyWithInvite(underInvite, invite, id)));
  assert.ok(sameAlbumKey(album, e.unwrapAlbumKeyWithMaster(underMaster, master, id)));

  // Crossed.
  const inviteAsMaster = e.MasterWrappedKey.fromParts(underInvite.wrapped, underInvite.wrapNonce);
  const masterAsInvite = e.InviteWrappedKey.fromParts(underMaster.wrapped, underMaster.wrapNonce);
  assert.equal(caught(() => e.unwrapAlbumKeyWithMaster(inviteAsMaster, master, id)).code, "AuthenticationFailed");
  assert.equal(caught(() => e.unwrapAlbumKeyWithInvite(masterAsInvite, invite, id)).code, "AuthenticationFailed");
});

test("a tampered wrapping or nonce is AuthenticationFailed", () => {
  const album = e.AlbumKey.generate();
  const invite = e.InviteKey.generate();
  const recipientId = random(16);
  const stored = e.wrapAlbumKeyForInvite(album, invite, recipientId);

  const wrapped = stored.wrapped;
  wrapped[47]! ^= 1; // the last tag byte
  const badTag = e.InviteWrappedKey.fromParts(wrapped, stored.wrapNonce);
  assert.equal(caught(() => e.unwrapAlbumKeyWithInvite(badTag, invite, recipientId)).code, "AuthenticationFailed");

  const nonce = stored.wrapNonce;
  nonce[0]! ^= 1;
  const badNonce = e.InviteWrappedKey.fromParts(stored.wrapped, nonce);
  assert.equal(caught(() => e.unwrapAlbumKeyWithInvite(badNonce, invite, recipientId)).code, "AuthenticationFailed");
});

/*
 * Invite spec §7 item 1: object → URL → object, both modes, through the
 * owner's parser. And §2.1: the secrets sit in the fragment and nowhere else.
 */
import { encodeBase64url } from "@vitrina/shared";
import { describe, expect, it } from "vitest";
import { parseInvite } from "./parse";
import { inviteLink } from "./url";

const ALBUM = Uint8Array.from({ length: 16 }, (_, i) => 0xa0 + i);
const TOKEN = encodeBase64url(Uint8Array.from({ length: 32 }, (_, i) => i));
const KEY_BYTES = Uint8Array.from({ length: 32 }, (_, i) => 0xf0 - i);
const KEY = encodeBase64url(KEY_BYTES);
const ORIGIN = "https://vitrina.example";

describe("inviteLink (invite spec §2, §4)", () => {
  it("QR: round-trips through parseInvite, K_invite included", () => {
    const url = inviteLink({ origin: ORIGIN, albumId: ALBUM, token: TOKEN, inviteKey: KEY });
    const parsed = parseInvite(new URL(url).hash);
    expect(parsed).toEqual({ ok: true, invite: { mode: "qr", albumId: ALBUM, token: TOKEN, inviteKey: KEY_BYTES } });
  });

  it("passphrase: round-trips with no key at all", () => {
    const url = inviteLink({ origin: ORIGIN, albumId: ALBUM, token: TOKEN });
    expect(url).not.toContain("k=");
    expect(parseInvite(new URL(url).hash)).toEqual({ ok: true, invite: { mode: "passphrase", albumId: ALBUM, token: TOKEN } });
  });

  it("puts every secret after # and nothing in a query or the path (§2.1)", () => {
    const url = new URL(inviteLink({ origin: ORIGIN, albumId: ALBUM, token: TOKEN, inviteKey: KEY }));
    expect(url.search).toBe("");
    expect(url.pathname).toBe("/v/");
    expect(url.origin).toBe(ORIGIN);
    const beforeHash = url.href.slice(0, url.href.indexOf("#"));
    expect(beforeHash).not.toContain(TOKEN);
    expect(beforeHash).not.toContain(KEY);
    expect(url.href).not.toContain("?");
  });

  it("refuses an origin with a path, query or fragment, and malformed parts", () => {
    for (const origin of [`${ORIGIN}/`, `${ORIGIN}/x`, `${ORIGIN}?a`, `${ORIGIN}#a`, "vitrina.example"]) {
      expect(() => inviteLink({ origin, albumId: ALBUM, token: TOKEN })).toThrow();
    }
    expect(() => inviteLink({ origin: ORIGIN, albumId: ALBUM.subarray(1), token: TOKEN })).toThrow();
    expect(() => inviteLink({ origin: ORIGIN, albumId: ALBUM, token: `${TOKEN}=` })).toThrow();
    expect(() => inviteLink({ origin: ORIGIN, albumId: ALBUM, token: TOKEN, inviteKey: KEY.slice(1) })).toThrow();
  });
});

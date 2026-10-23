/*
 * The invite payload's URL serialisation (invite spec §2, §4), the owner's
 * side: what the share screen shows, copies and draws as a QR. Serialising
 * only; the parser (./parse.ts) is the owner's.
 *
 * Everything secret goes after `#`, never `?` (invite spec §2.1): a fragment
 * is not sent in any request, and a query string would send the token, and in
 * QR mode K_invite, to the relay in plaintext on the very first load. The path
 * is fixed; `relay` is this page's own origin (invite spec §1, the web client).
 */
import { encodeBase64url } from "@vitrina/shared";

export type InviteLinkParts = {
  /** This page's origin: `location.origin`. Scheme, host and port, nothing else. */
  readonly origin: string;
  /** The album id's 16 raw bytes. */
  readonly albumId: Uint8Array;
  /** The token, already base64url (43 chars), as the owner's function returns it. */
  readonly token: string;
  /** K_invite, already base64url (43 chars). Absent for a passphrase invite (invite spec §4). */
  readonly inviteKey?: string;
};

const ORIGIN = /^https?:\/\/[^/?#\s]+$/;
const B64_32 = /^[A-Za-z0-9_-]{43}$/;

/** `https://{relay}/v/#v=1&a={album}&t={token}[&k={key}]`. Throws on anything malformed rather than emit a link that half works. */
export function inviteLink(p: InviteLinkParts): string {
  if (!ORIGIN.test(p.origin)) throw new TypeError("origin must be a bare origin");
  if (p.albumId.length !== 16) throw new TypeError("album id must be 16 bytes");
  if (!B64_32.test(p.token)) throw new TypeError("token must be 43 base64url characters");
  if (p.inviteKey !== undefined && !B64_32.test(p.inviteKey)) throw new TypeError("invite key must be 43 base64url characters");
  const fragment = `v=1&a=${encodeBase64url(p.albumId)}&t=${p.token}${p.inviteKey === undefined ? "" : `&k=${p.inviteKey}`}`;
  return `${p.origin}/v/#${fragment}`;
}

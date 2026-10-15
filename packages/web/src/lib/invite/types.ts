/*
 * The invite payload as parseInvite returns it — signature approved by the
 * owner. The parser itself (./parse.ts) is the owner's: CLAUDE.md's
 * "do not write" list. Nothing in this file decodes, validates or parses.
 */

export type Invite =
  | {
      readonly mode: "qr";
      /** 16 bytes. */
      readonly albumId: Uint8Array;
      /** The 43-character canonical base64url text, sent as the bearer value unchanged. */
      readonly token: string;
      /** 32 bytes of K_album. Zeroed by openDirectKey; dead afterwards. */
      readonly key: Uint8Array;
    }
  | {
      readonly mode: "passphrase";
      readonly albumId: Uint8Array;
      readonly token: string;
    };

export type InviteError =
  /** "" or "#" → dead page. */
  | { readonly kind: "missing" }
  /** Anything wrong in a v=1 payload → dead page. */
  | { readonly kind: "malformed" }
  /** A well-formed `v` other than 1 → open.newer-version (invite spec §6). */
  | { readonly kind: "unsupported-version" };

export type ParseResult = { readonly ok: true; readonly invite: Invite } | { readonly ok: false; readonly error: InviteError };

/** `fragment` is location.hash exactly as the browser returns it, leading `#` included. Pure. */
export type ParseInvite = (fragment: string) => ParseResult;

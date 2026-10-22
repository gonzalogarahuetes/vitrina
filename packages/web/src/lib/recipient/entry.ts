/*
 * The invite fragment, taken before anything else runs (invite spec §2.1–§2.2;
 * flows §4.1): read it, strip it from the address bar, and only then let any
 * code that can make a request start.
 *
 * Called from hooks.client.ts's `init`, which SvelteKit runs before its router
 * reads the URL. So the router never holds the fragment, not even in memory:
 * SvelteKit's own `replaceState` from $app/navigation would write `page.url`,
 * fragment included, into history.state, which the browser persists with the
 * session. The native call below keeps SvelteKit's state object as it is and
 * changes only the URL. (In `vite dev` SvelteKit logs a one-time warning about
 * the native call; that warning is expected here.)
 *
 * A valid fragment is kept for the tab (lib/session/recipient-session.ts), so
 * a reload continues: QR unwraps again with the stored K_invite, passphrase
 * asks for the words again. Never K_album, which no fragment carries.
 */

import { parseInvite } from "$lib/invite/parse";
import { inviteStore, type InviteStore } from "$lib/session/recipient-session";

export type LocationLike = { readonly pathname: string; readonly search: string; readonly hash: string };
export type HistoryLike = { readonly state: unknown; replaceState(data: unknown, unused: string, url: string): void };

const RECIPIENT_PATHS = new Set(["/v/", "/v"]);

let captured: string | null = null;

/**
 * Flows §4.1 step 1 and §4.7, in the order decided on 21 October 2026: read
 * the fragment, strip it, parse it, and store it only if parseInvite accepts
 * it. A malformed or newer-version fragment never reaches storage. With no
 * fragment — a reload — the tab's stored one is handed over instead, and
 * parsed again by the session like any other.
 */
export function captureInvite(location: LocationLike, history: HistoryLike, store: InviteStore = inviteStore()): void {
  if (!RECIPIENT_PATHS.has(location.pathname)) return;
  const fragment = location.hash;

  history.replaceState(history.state, "", location.pathname + location.search);

  if (fragment === "") {
    captured = store.read() ?? "";
    return;
  }
  const parsed = parseInvite(fragment);
  if (parsed.ok) {
    store.write(fragment);
    // Parsed only to decide; the session parses its own copy. Zero this one's K_invite.
    if (parsed.invite.mode === "qr") parsed.invite.inviteKey.fill(0);
  }
  captured = fragment;
}

/** Hands the fragment over once. A second call gets "", which parses as `missing`. */
export function takeCapturedInvite(): string {
  const fragment = captured ?? "";
  captured = null;
  return fragment;
}

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
 */

export type LocationLike = { readonly pathname: string; readonly search: string; readonly hash: string };
export type HistoryLike = { readonly state: unknown; replaceState(data: unknown, unused: string, url: string): void };

const RECIPIENT_PATHS = new Set(["/v/", "/v"]);

let captured: string | null = null;

export function captureInvite(location: LocationLike, history: HistoryLike): void {
  if (!RECIPIENT_PATHS.has(location.pathname)) return;
  const fragment = location.hash;

  /*
   * ⟪SEAM — flows §4.7, pending the device test (scripts/tab-reload-test/).⟫
   * Every reload is the dead page today: the fragment is stripped below and
   * nothing is stored, so a reload arrives with an empty fragment and
   * parseInvite answers `missing`. Restoring from tab-scoped storage plugs in
   * HERE, and only here: on an empty fragment, read the stored one back; on a
   * non-empty one, store it before stripping. It is not built, and nothing
   * may be stored until the owner decides (invite spec §2.2 step 4 forbids
   * writing `key` to sessionStorage as written today). eslint.config.js
   * already confines sessionStorage to one module; this seam would call it.
   */

  history.replaceState(history.state, "", location.pathname + location.search);
  captured = fragment;
}

/** Hands the fragment over once. A second call gets "", which parses as `missing`. */
export function takeCapturedInvite(): string {
  const fragment = captured ?? "";
  captured = null;
  return fragment;
}

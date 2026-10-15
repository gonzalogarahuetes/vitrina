import { loadEnvelope, type LoadedEnvelope } from "$lib/envelope";

// A static SPA: nothing renders on a server, nothing is prerendered.
export const ssr = false;
export const prerender = false;

export type EnvelopeState = { readonly status: "ready"; readonly loaded: LoadedEnvelope } | { readonly status: "unavailable" };

/*
 * Every screen sits under this layout, so the WASM is initialised before any
 * of them renders. A failure is its own state, not SvelteKit's error page and
 * not a credential failure (flows §2).
 */
export async function load(): Promise<{ envelope: EnvelopeState }> {
  try {
    return { envelope: { status: "ready", loaded: await loadEnvelope() } };
  } catch {
    return { envelope: { status: "unavailable" } };
  }
}
